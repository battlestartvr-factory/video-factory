import { describe, expect, it } from "vitest";
import { extractTextFromBuffer } from "@/lib/knowledge/file-extractors";

const TEXT_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    "4 0 obj<</Length 44>>stream\n" +
    "BT /F1 24 Tf 100 700 Td (Hello Knowledge PDF extraction regression test) Tj ET\n" +
    "endstream\nendobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000254 00000 n \n0000000368 00000 n \n" +
    "trailer<</Size 6/Root 1 0 R>>\nstartxref\n441\n%%EOF",
);

const EMPTY_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n" +
    "trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

describe("knowledge PDF extraction", () => {
  it("imports extraction module in Node without DOM globals", async () => {
    expect(typeof globalThis.DOMMatrix).toBe("undefined");
    const mod = await import("@/lib/knowledge/file-extractors");
    expect(typeof mod.extractTextFromBuffer).toBe("function");
  });

  it("extracts text from a text-based PDF", async () => {
    const result = await extractTextFromBuffer(TEXT_PDF, "application/pdf", "sample.pdf");
    expect(result.needsOcr).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.text).toContain("Hello Knowledge PDF extraction regression test");
  });

  it("returns needs_ocr for empty or scanned PDFs", async () => {
    const result = await extractTextFromBuffer(EMPTY_PDF, "application/pdf", "empty.pdf");
    expect(result.needsOcr).toBe(true);
    expect(result.text).toBe("");
  });

  it("does not bundle legacy pdfjs-dist import path", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile(new URL("../../lib/knowledge/file-extractors.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toContain("pdf-parse");
    expect(source).not.toContain("pdfjs-dist/legacy/build/pdf");
    expect(source).toContain("unpdf");
  });
});
