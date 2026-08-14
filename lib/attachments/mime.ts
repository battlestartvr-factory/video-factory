/**
 * Extensible MIME type registry for chat/generator attachments.
 * Uses MIME type as primary identifier; extensions are secondary hints.
 */

export interface MimeDefinition {
  mime: string;
  extensions: string[];
  category: "image" | "video" | "document" | "text";
  maxSizeBytes: number;
}

export const ATTACHMENT_MIME_REGISTRY: MimeDefinition[] = [
  { mime: "image/png", extensions: [".png"], category: "image", maxSizeBytes: 20 * 1024 * 1024 },
  { mime: "image/jpeg", extensions: [".jpg", ".jpeg"], category: "image", maxSizeBytes: 20 * 1024 * 1024 },
  { mime: "image/webp", extensions: [".webp"], category: "image", maxSizeBytes: 20 * 1024 * 1024 },
  { mime: "image/gif", extensions: [".gif"], category: "image", maxSizeBytes: 20 * 1024 * 1024 },
  { mime: "video/mp4", extensions: [".mp4"], category: "video", maxSizeBytes: 100 * 1024 * 1024 },
  { mime: "video/quicktime", extensions: [".mov"], category: "video", maxSizeBytes: 100 * 1024 * 1024 },
  { mime: "video/webm", extensions: [".webm"], category: "video", maxSizeBytes: 100 * 1024 * 1024 },
  { mime: "application/pdf", extensions: [".pdf"], category: "document", maxSizeBytes: 50 * 1024 * 1024 },
  { mime: "text/plain", extensions: [".txt"], category: "text", maxSizeBytes: 10 * 1024 * 1024 },
  { mime: "text/markdown", extensions: [".md"], category: "text", maxSizeBytes: 10 * 1024 * 1024 },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    category: "document",
    maxSizeBytes: 50 * 1024 * 1024,
  },
];

const MIME_MAP = new Map(ATTACHMENT_MIME_REGISTRY.map((d) => [d.mime, d]));

export function getMimeDefinition(mime: string): MimeDefinition | undefined {
  return MIME_MAP.get(mime);
}

export function isAllowedMime(mime: string): boolean {
  return MIME_MAP.has(mime);
}

export function getAllowedMimes(): string[] {
  return ATTACHMENT_MIME_REGISTRY.map((d) => d.mime);
}

export function getAcceptString(): string {
  return ATTACHMENT_MIME_REGISTRY.map((d) => d.mime).join(",");
}

export function guessMimeFromExtension(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!ext) return null;
  const def = ATTACHMENT_MIME_REGISTRY.find((d) => d.extensions.includes(ext));
  return def?.mime ?? null;
}

export function getCategoryFromMime(mime: string): MimeDefinition["category"] | null {
  return getMimeDefinition(mime)?.category ?? null;
}
