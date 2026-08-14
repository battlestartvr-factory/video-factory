import { CONTENT_LIMITS } from "@/lib/agent/config";

export function chunkText(text: string, chunkSize: number = CONTENT_LIMITS.knowledgeChunkSize): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: string[] = [];
  const paragraphs = trimmed.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + para).length > chunkSize && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const limited = chunks.length ? chunks : [trimmed.slice(0, chunkSize)];
  return limited.slice(0, CONTENT_LIMITS.maxKnowledgeChunksPerDocument);
}

export function normalizeExtractedText(text: string): string {
  return text.slice(0, CONTENT_LIMITS.maxExtractedTextChars);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function isExtractableMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/pdf" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}
