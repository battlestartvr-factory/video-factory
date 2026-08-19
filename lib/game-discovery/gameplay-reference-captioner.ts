import "server-only";
import { createAgentProvider } from "@/lib/agent/provider";
import type { AgentProvider, AgentUsage } from "@/lib/agent/types";
import { getKieConfig } from "@/lib/env/env.server";
import {
  buildGameplayReferenceCaptionPrompt,
  parseGameplayReferenceCaption,
  type GameplayReferenceCaptionV1,
} from "./gameplay-reference-indexing";

export const GAMEPLAY_REFERENCE_CAPTION_MODEL = "gemini-3-6-flash";
const KIE_BASE64_UPLOAD_URL = "https://kieai.redpandaai.co/api/file-base64-upload";
const MAX_BASE64_IMAGE_BYTES = 10 * 1024 * 1024;

export interface GameplayReferenceCaptionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GameplayReferenceCaptionResult {
  caption: GameplayReferenceCaptionV1;
  model: string;
  usage: GameplayReferenceCaptionUsage;
}

export type GameplayReferenceTempUpload = (input: {
  referenceId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}) => Promise<string>;

function normalizedUsage(usage?: AgentUsage): GameplayReferenceCaptionUsage {
  return {
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens:
      usage?.totalTokens ?? (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
  };
}

function safeExtension(filename: string, mimeType: string): string {
  const ext = filename.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase();
  if (ext) return ext;
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function responseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function uploadGameplayReferenceToKieTemp(input: {
  referenceId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  fetchImpl?: typeof fetch;
  apiKey?: string;
}): Promise<string> {
  if (!input.mimeType.startsWith("image/")) {
    throw new Error(`GAMEPLAY_REFERENCE_CAPTION_UNSUPPORTED_MIME:${input.mimeType}`);
  }
  if (input.buffer.length > MAX_BASE64_IMAGE_BYTES) {
    throw new Error(`GAMEPLAY_REFERENCE_CAPTION_IMAGE_TOO_LARGE:${input.buffer.length}`);
  }

  const config = getKieConfig();
  const apiKey = (input.apiKey ?? config.apiKey).trim();
  if (!apiKey) throw new Error("GAMEPLAY_REFERENCE_CAPTION_KIE_NOT_CONFIGURED");

  const fetchImpl = input.fetchImpl ?? fetch;
  const extension = safeExtension(input.filename, input.mimeType);
  const uniqueFilename = `${input.referenceId}-${crypto.randomUUID()}.${extension}`;
  const response = await fetchImpl(KIE_BASE64_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base64Data: `data:${input.mimeType};base64,${input.buffer.toString("base64")}`,
      uploadPath: "gameplay-references/captioning",
      fileName: uniqueFilename,
    }),
  });

  const rawText = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = responseObject(JSON.parse(rawText));
  } catch {
    // Keep payload empty; status-based error below is enough and never includes secrets.
  }

  if (!response.ok) {
    throw new Error(`GAMEPLAY_REFERENCE_CAPTION_UPLOAD_FAILED:${response.status}`);
  }

  const data = responseObject(payload.data);
  const urlCandidates = [data.downloadUrl, data.fileUrl, data.url, payload.downloadUrl, payload.fileUrl];
  const url = urlCandidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && /^https:\/\//i.test(candidate.trim()),
  );
  if (!url) throw new Error("GAMEPLAY_REFERENCE_CAPTION_UPLOAD_URL_MISSING");
  return url.trim();
}

export async function captionGameplayReferenceImage(input: {
  referenceId: string;
  gameName: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  provider?: AgentProvider;
  upload?: GameplayReferenceTempUpload;
}): Promise<GameplayReferenceCaptionResult> {
  const upload = input.upload ?? ((request) => uploadGameplayReferenceToKieTemp(request));
  const imageUrl = await upload({
    referenceId: input.referenceId,
    filename: input.filename,
    mimeType: input.mimeType,
    buffer: input.buffer,
  });
  const provider = input.provider ?? createAgentProvider();
  const response = await provider.run({
    model: GAMEPLAY_REFERENCE_CAPTION_MODEL,
    system:
      "You are a low-cost visual indexer for a real-gameplay reference library. Describe only evidence visible in the supplied frame. Return strict JSON only. Never improve, dramatize, or reinterpret a cinematic frame as gameplay.",
    reasoningLevel: null,
    tools: [],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildGameplayReferenceCaptionPrompt(input.gameName) },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  if (!response.content) throw new Error("GAMEPLAY_REFERENCE_CAPTION_EMPTY_RESPONSE");

  // Deliberately no second model call: cheap-model primitive drift is repaired by code;
  // semantic/schema failures are persisted for inspection instead of spending again.
  const caption = parseGameplayReferenceCaption(response.content);
  return {
    caption,
    model: GAMEPLAY_REFERENCE_CAPTION_MODEL,
    usage: normalizedUsage(response.usage),
  };
}
