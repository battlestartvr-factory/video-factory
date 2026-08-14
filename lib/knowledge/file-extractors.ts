import "server-only";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { CONTENT_LIMITS } from "@/lib/agent/config";
import { chunkText, isExtractableMime, normalizeExtractedText } from "./extraction";

export interface ExtractionResult {
  text: string;
  needsOcr: boolean;
  error?: string;
}

const MIN_MEANINGFUL_TEXT_CHARS = 40;
const SYNC_EXTRACTION_MAX_BYTES = 15 * 1024 * 1024;

export function isSyncExtractionSafe(sizeBytes: number | null | undefined): boolean {
  if (!sizeBytes) return true;
  return sizeBytes <= SYNC_EXTRACTION_MAX_BYTES;
}

export async function extractTextFromBuffer(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<ExtractionResult> {
  try {
    if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
      return extractPdf(buffer);
    }
    if (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      filename.toLowerCase().endsWith(".docx")
    ) {
      return extractDocx(buffer);
    }
    if (
      mimeType.startsWith("text/") ||
      filename.toLowerCase().endsWith(".md") ||
      filename.toLowerCase().endsWith(".txt")
    ) {
      const text = normalizeExtractedText(buffer.toString("utf-8"));
      return { text, needsOcr: false };
    }

    if (isExtractableMime(mimeType)) {
      return { text: "", needsOcr: true, error: "UNSUPPORTED_MIME" };
    }

    return { text: "", needsOcr: false, error: "UNSUPPORTED_MIME" };
  } catch (error) {
    return {
      text: "",
      needsOcr: false,
      error: error instanceof Error ? error.message : "EXTRACTION_FAILED",
    };
  }
}

async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = normalizeExtractedText(result.text ?? "");
    if (text.trim().length < MIN_MEANINGFUL_TEXT_CHARS) {
      return { text: "", needsOcr: true };
    }
    return { text, needsOcr: false };
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer: Buffer): Promise<ExtractionResult> {
  const result = await mammoth.extractRawText({ buffer });
  const text = normalizeExtractedText(result.value ?? "");
  if (text.trim().length < MIN_MEANINGFUL_TEXT_CHARS) {
    return { text: "", needsOcr: false, error: "EMPTY_DOCX" };
  }
  return { text, needsOcr: false };
}

export function buildChunks(text: string): string[] {
  return chunkText(text);
}

export { SYNC_EXTRACTION_MAX_BYTES, MIN_MEANINGFUL_TEXT_CHARS, CONTENT_LIMITS };
