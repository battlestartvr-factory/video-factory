import "server-only";

import { createLogger } from "@/lib/logging/logger";
import {
  createDriveApiClient,
  createDriveAuthClient,
  getDriveStorageProvider,
  isDriveStorageConfigured,
} from "@/lib/storage/drive-provider";
import { DriveStorageError, getGoogleApiHttpStatus } from "@/lib/storage/drive-errors";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { KnowledgeDocument } from "@/lib/types/workspace";

const DELETE_VERIFY_ATTEMPTS = 4;
const DELETE_VERIFY_DELAY_MS = 250;
const DUPLICATE_CREATED_AT_TOLERANCE_MS = 15 * 60_000;

type DriveKnowledgeDocument = KnowledgeDocument & {
  storage_provider?: string | null;
  drive_file_id?: string | null;
  drive_web_url?: string | null;
  storage_path?: string | null;
  metadata?: Record<string, unknown>;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function looksLikeDriveFileId(value: string): boolean {
  return /^[A-Za-z0-9_-]{10,}$/.test(value);
}

export function parseGoogleDriveFileId(rawUrl: string | null | undefined): string | null {
  const value = nonEmptyString(rawUrl);
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!/(^|\.)google\.com$/i.test(url.hostname) && !/(^|\.)googleusercontent\.com$/i.test(url.hostname)) {
      return null;
    }

    const queryId = nonEmptyString(url.searchParams.get("id"));
    if (queryId && looksLikeDriveFileId(queryId)) return queryId;

    const pathMatch = url.pathname.match(/\/d\/([A-Za-z0-9_-]{10,})(?:\/|$)/);
    if (pathMatch?.[1]) return pathMatch[1];
  } catch {
    return null;
  }

  return null;
}

export function isDriveBackedKnowledgeDocument(document: Partial<DriveKnowledgeDocument>): boolean {
  if (nonEmptyString(document.storage_provider)?.toLowerCase() === "google_drive") return true;
  if (nonEmptyString(document.drive_file_id)) return true;
  if (parseGoogleDriveFileId(document.drive_web_url)) return true;

  const metadata = document.metadata ?? {};
  return Boolean(nonEmptyString(metadata.drive_file_id) || nonEmptyString(metadata.driveFileId));
}

export function resolveKnowledgeDriveFileId(document: Partial<DriveKnowledgeDocument>): string | null {
  const direct = nonEmptyString(document.drive_file_id);
  if (direct && looksLikeDriveFileId(direct)) return direct;

  if (nonEmptyString(document.storage_provider)?.toLowerCase() === "google_drive") {
    const storagePath = nonEmptyString(document.storage_path);
    if (storagePath && looksLikeDriveFileId(storagePath)) return storagePath;
  }

  const metadata = document.metadata ?? {};
  for (const candidate of [metadata.drive_file_id, metadata.driveFileId]) {
    const value = nonEmptyString(candidate);
    if (value && looksLikeDriveFileId(value)) return value;
  }

  return parseGoogleDriveFileId(document.drive_web_url);
}

function uploadFolderId(document: Partial<DriveKnowledgeDocument>): string | null {
  const metadata = document.metadata ?? {};
  return nonEmptyString(metadata.upload_folder_id) ?? nonEmptyString(metadata.uploadFolderId);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyDriveFileAbsent(driveFileId: string): Promise<boolean> {
  const auth = createDriveAuthClient();
  if (!auth) throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
  const drive = createDriveApiClient(auth);

  for (let attempt = 0; attempt < DELETE_VERIFY_ATTEMPTS; attempt += 1) {
    try {
      await drive.files.get({
        fileId: driveFileId,
        fields: "id",
        supportsAllDrives: true,
      });
    } catch (error) {
      if (getGoogleApiHttpStatus(error) === 404) return true;
      throw error;
    }

    if (attempt < DELETE_VERIFY_ATTEMPTS - 1) {
      await sleep(DELETE_VERIFY_DELAY_MS * (attempt + 1));
    }
  }

  return false;
}

async function markDeleteFailure(input: {
  document: DriveKnowledgeDocument;
  errorCode: string;
  driveFileId: string | null;
  error: unknown;
}): Promise<void> {
  const service = createSupabaseServiceClient();
  await service
    .from("knowledge_documents")
    .update({
      status: "failed",
      metadata: {
        ...(input.document.metadata ?? {}),
        delete_audit: {
          drive_delete_failed: true,
          drive_file_id: input.driveFileId,
          error: input.error instanceof Error ? input.error.message : String(input.error),
          error_code: input.errorCode,
          attempted_at: new Date().toISOString(),
        },
      },
    })
    .eq("id", input.document.id)
    .eq("user_id", input.document.user_id);
}

async function cleanupLikelyRetryDuplicates(input: {
  document: DriveKnowledgeDocument;
  deletedDriveFileId: string;
}): Promise<number> {
  const folderId = uploadFolderId(input.document);
  if (!folderId) return 0;

  const auth = createDriveAuthClient();
  if (!auth) return 0;
  const driveApi = createDriveApiClient(auth);
  const escapedFilename = input.document.filename.replace(/'/g, "\\'");
  const response = await driveApi.files.list({
    q: `'${folderId}' in parents and name='${escapedFilename}' and trashed=false`,
    fields: "files(id,name,size,createdTime)",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const candidates = response.data.files ?? [];
  if (!candidates.length) return 0;

  const service = createSupabaseServiceClient();
  const { data: siblings } = await service
    .from("knowledge_documents")
    .select("id,storage_provider,drive_file_id,storage_path,drive_web_url,metadata")
    .eq("user_id", input.document.user_id)
    .eq("filename", input.document.filename)
    .neq("id", input.document.id);

  const protectedIds = new Set<string>();
  for (const sibling of siblings ?? []) {
    const resolved = resolveKnowledgeDriveFileId(sibling as Partial<DriveKnowledgeDocument>);
    if (resolved) protectedIds.add(resolved);
  }

  const sourceCreatedAt = Date.parse(input.document.created_at);
  let cleaned = 0;
  const provider = getDriveStorageProvider();

  for (const candidate of candidates) {
    const candidateId = nonEmptyString(candidate.id);
    if (!candidateId || candidateId === input.deletedDriveFileId || protectedIds.has(candidateId)) continue;

    // Only auto-clean a leftover that strongly resembles a retry-created duplicate.
    // A manually added same-name file outside this time/size envelope is left untouched.
    const candidateSize = candidate.size ? Number(candidate.size) : null;
    if (
      input.document.size_bytes != null &&
      candidateSize != null &&
      Number.isFinite(candidateSize) &&
      candidateSize !== input.document.size_bytes
    ) {
      continue;
    }

    const candidateCreatedAt = candidate.createdTime ? Date.parse(candidate.createdTime) : Number.NaN;
    if (
      Number.isFinite(sourceCreatedAt) &&
      Number.isFinite(candidateCreatedAt) &&
      Math.abs(candidateCreatedAt - sourceCreatedAt) > DUPLICATE_CREATED_AT_TOLERANCE_MS
    ) {
      continue;
    }

    const { httpStatus } = await provider.deleteFile(candidateId);
    if (httpStatus !== 404 && !(await verifyDriveFileAbsent(candidateId))) {
      throw new Error("DRIVE_DUPLICATE_DELETE_NOT_CONFIRMED");
    }
    cleaned += 1;
  }

  return cleaned;
}

export async function deleteKnowledgeDocumentWithDriveSync(
  userId: string,
  documentId: string,
): Promise<{ driveDeleted: boolean; driveAlreadyGone: boolean; cleanedRetryDuplicates: number }> {
  const logger = createLogger({
    event: "knowledge.document.delete",
    document_id: documentId,
    user_id: userId,
  });
  const service = createSupabaseServiceClient();
  const { data: row, error: fetchError } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("id", documentId)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchError) throw new Error("DOCUMENT_FETCH_FAILED");
  if (!row) throw new Error("DOCUMENT_NOT_FOUND");

  const document = row as DriveKnowledgeDocument;
  const driveBacked = isDriveBackedKnowledgeDocument(document);
  let driveDeleted = false;
  let driveAlreadyGone = false;
  let cleanedRetryDuplicates = 0;
  let driveFileId: string | null = null;

  if (driveBacked) {
    if (!isDriveStorageConfigured()) {
      await markDeleteFailure({
        document,
        errorCode: "GOOGLE_DRIVE_NOT_CONFIGURED",
        driveFileId: null,
        error: new Error("Google Drive is not configured"),
      });
      throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
    }

    driveFileId = resolveKnowledgeDriveFileId(document);
    if (!driveFileId) {
      await markDeleteFailure({
        document,
        errorCode: "DRIVE_FILE_ID_MISSING",
        driveFileId: null,
        error: new Error("Drive-backed document has no resolvable Drive file id"),
      });
      throw new Error("DRIVE_FILE_ID_MISSING");
    }

    logger.info("before_drive_delete", { file_id: driveFileId, filename: document.filename });

    try {
      const drive = getDriveStorageProvider();
      const { httpStatus } = await drive.deleteFile(driveFileId);
      driveAlreadyGone = httpStatus === 404;

      if (!driveAlreadyGone) {
        const absent = await verifyDriveFileAbsent(driveFileId);
        if (!absent) throw new Error("DRIVE_DELETE_NOT_CONFIRMED");
        driveDeleted = true;
      }

      // A failed/retried upload can leave another unreferenced object with the same
      // name in the managed Knowledge folder. Clean only strongly matched retry copies.
      cleanedRetryDuplicates = await cleanupLikelyRetryDuplicates({
        document,
        deletedDriveFileId: driveFileId,
      });

      logger.info("after_drive_delete", {
        file_id: driveFileId,
        already_gone: driveAlreadyGone,
        cleaned_retry_duplicates: cleanedRetryDuplicates,
      });
    } catch (driveError) {
      const errorCode =
        driveError instanceof DriveStorageError &&
        driveError.code === "DRIVE_DELETE_PERMISSION_DENIED"
          ? "DRIVE_DELETE_PERMISSION_DENIED"
          : driveError instanceof Error && driveError.message.startsWith("DRIVE_")
            ? driveError.message
            : "DRIVE_DELETE_FAILED";

      await markDeleteFailure({ document, errorCode, driveFileId, error: driveError });
      throw new Error(errorCode);
    }
  }

  const { error: deleteError } = await service
    .from("knowledge_documents")
    .delete()
    .eq("id", documentId)
    .eq("user_id", userId);
  if (deleteError) throw new Error("DATABASE_DELETE_FAILED");

  logger.info("deleted", {
    filename: document.filename,
    drive_file_id: driveFileId,
    drive_deleted: driveDeleted,
    drive_already_gone: driveAlreadyGone,
    cleaned_retry_duplicates: cleanedRetryDuplicates,
  });

  return { driveDeleted, driveAlreadyGone, cleanedRetryDuplicates };
}
