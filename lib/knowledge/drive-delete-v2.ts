import "server-only";

import { createLogger } from "@/lib/logging/logger";
import {
  createDriveApiClient,
  createDriveAuthClient,
  isDriveStorageConfigured,
} from "@/lib/storage/drive-provider";
import { getGoogleApiHttpStatus } from "@/lib/storage/drive-errors";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { KnowledgeDocument } from "@/lib/types/workspace";
import {
  isDriveBackedKnowledgeDocument,
  resolveKnowledgeDriveFileId,
} from "./drive-delete";

type DriveKnowledgeDocument = KnowledgeDocument & {
  storage_provider?: string | null;
  drive_file_id?: string | null;
  drive_web_url?: string | null;
  storage_path?: string | null;
  metadata?: Record<string, unknown>;
};

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

async function removeDriveObjectVerified(driveFileId: string): Promise<{
  mode: "trash" | "permanent_delete";
  alreadyTrashed: boolean;
}> {
  const auth = createDriveAuthClient();
  if (!auth) throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
  const drive = createDriveApiClient(auth);

  let metadata;
  try {
    metadata = await drive.files.get({
      fileId: driveFileId,
      fields:
        "id,name,trashed,ownedByMe,driveId,parents,capabilities(canTrash,canDelete)",
      supportsAllDrives: true,
    });
  } catch (error) {
    // A 404 from the same server credential is not sufficient proof that the
    // object is globally gone: the credential may simply have lost access.
    if (getGoogleApiHttpStatus(error) === 404) {
      throw new Error("DRIVE_DELETE_NOT_VERIFIABLE");
    }
    throw error;
  }

  const file = metadata.data;
  if (file.trashed === true) {
    return { mode: "trash", alreadyTrashed: true };
  }

  // Items in a real Shared Drive have no individual owner. Permanent deletion is
  // allowed only when Google explicitly reports canDelete for the active credential.
  if (file.driveId) {
    if (file.capabilities?.canDelete !== true) {
      throw new Error("DRIVE_DELETE_PERMISSION_DENIED");
    }

    await drive.files.delete({
      fileId: driveFileId,
      supportsAllDrives: true,
    });

    try {
      await drive.files.get({
        fileId: driveFileId,
        fields: "id",
        supportsAllDrives: true,
      });
      throw new Error("DRIVE_DELETE_NOT_CONFIRMED");
    } catch (error) {
      if (error instanceof Error && error.message === "DRIVE_DELETE_NOT_CONFIRMED") {
        throw error;
      }
      if (getGoogleApiHttpStatus(error) !== 404) throw error;
    }

    return { mode: "permanent_delete", alreadyTrashed: false };
  }

  // For My Drive / "Shared with me" hierarchies we deliberately use Trash,
  // because it is the same user-visible deletion model as the Drive UI and Google
  // exposes an explicit canTrash capability. Only the owner can trash a My Drive
  // item. This prevents a service/shared credential from losing access and falsely
  // treating its own 404 as proof that the owner's object was deleted.
  if (file.ownedByMe !== true || file.capabilities?.canTrash !== true) {
    throw new Error("DRIVE_DELETE_PERMISSION_DENIED");
  }

  await drive.files.update({
    fileId: driveFileId,
    requestBody: { trashed: true },
    fields: "id,trashed",
    supportsAllDrives: true,
  });

  const verify = await drive.files.get({
    fileId: driveFileId,
    fields: "id,trashed",
    supportsAllDrives: true,
  });

  if (verify.data.trashed !== true) {
    throw new Error("DRIVE_DELETE_NOT_CONFIRMED");
  }

  return { mode: "trash", alreadyTrashed: false };
}

export async function deleteKnowledgeDocumentWithVerifiedDriveRemoval(
  userId: string,
  documentId: string,
): Promise<{
  driveRemoved: boolean;
  driveMode: "none" | "trash" | "permanent_delete";
  driveAlreadyTrashed: boolean;
}> {
  const logger = createLogger({
    event: "knowledge.document.delete.v2",
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
  let driveMode: "none" | "trash" | "permanent_delete" = "none";
  let driveAlreadyTrashed = false;
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

    logger.info("before_drive_remove", { file_id: driveFileId, filename: document.filename });

    try {
      const removal = await removeDriveObjectVerified(driveFileId);
      driveMode = removal.mode;
      driveAlreadyTrashed = removal.alreadyTrashed;
      logger.info("after_drive_remove", {
        file_id: driveFileId,
        mode: driveMode,
        already_trashed: driveAlreadyTrashed,
      });
    } catch (error) {
      const code =
        error instanceof Error && error.message.startsWith("DRIVE_")
          ? error.message
          : "DRIVE_DELETE_FAILED";
      await markDeleteFailure({ document, errorCode: code, driveFileId, error });
      throw new Error(code);
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
    drive_mode: driveMode,
    drive_already_trashed: driveAlreadyTrashed,
  });

  return {
    driveRemoved: driveMode !== "none",
    driveMode,
    driveAlreadyTrashed,
  };
}
