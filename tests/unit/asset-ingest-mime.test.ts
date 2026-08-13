import { describe, expect, it } from "vitest";
import { detectMimeFromMagicBytes, buildObjectKey } from "@/lib/asset-ingest/mime";
import {
  jpegBytes,
  movBytes,
  mp4Bytes,
  pngBytes,
  spoofedGifAsPng,
  webmBytes,
  webpBytes,
} from "./asset-ingest-fixtures";

describe("asset-ingest mime detection", () => {
  it("detects image mime types from magic bytes", async () => {
    await expect(detectMimeFromMagicBytes(pngBytes(), "image")).resolves.toEqual({
      mimeType: "image/png",
      extension: "png",
    });
    await expect(detectMimeFromMagicBytes(jpegBytes(), "image")).resolves.toEqual({
      mimeType: "image/jpeg",
      extension: "jpg",
    });
    await expect(detectMimeFromMagicBytes(webpBytes(), "image")).resolves.toEqual({
      mimeType: "image/webp",
      extension: "webp",
    });
  });

  it("detects video mime types from magic bytes", async () => {
    await expect(detectMimeFromMagicBytes(mp4Bytes(), "video")).resolves.toEqual({
      mimeType: "video/mp4",
      extension: "mp4",
    });
    await expect(detectMimeFromMagicBytes(webmBytes(), "video")).resolves.toEqual({
      mimeType: "video/webm",
      extension: "webm",
    });
    await expect(detectMimeFromMagicBytes(movBytes(), "video")).resolves.toEqual({
      mimeType: "video/quicktime",
      extension: "mov",
    });
  });

  it("rejects MIME spoofing (GIF bytes with image kind)", async () => {
    await expect(
      detectMimeFromMagicBytes(spoofedGifAsPng(), "image"),
    ).rejects.toMatchObject({ code: "INVALID_MIME" });
  });

  it("rejects image bytes when kind is video", async () => {
    await expect(
      detectMimeFromMagicBytes(pngBytes(), "video"),
    ).rejects.toMatchObject({ code: "INVALID_MIME" });
  });

  it("builds object key only after verified extension", () => {
    expect(
      buildObjectKey({
        projectId: "11111111-1111-4111-8111-111111111111",
        jobId: "22222222-2222-4222-8222-222222222222",
        stage: "keyframes",
        providerTaskId: "33333333-3333-4333-8333-333333333333",
        variantIndex: 1,
        extension: "png",
      }),
    ).toBe(
      "temp/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/keyframes/33333333-3333-4333-8333-333333333333-1.png",
    );
  });
});
