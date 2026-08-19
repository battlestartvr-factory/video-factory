import { describe, expect, it } from "vitest";
import {
  outputDriveFileId,
  outputProviderUrl,
} from "../../worker/workflows/gameplay-authenticity-inspection-client";

describe("generated gameplay inspection asset transport", () => {
  it("prefers an already archived Drive pointer when present", () => {
    const outputs = [
      { url: "https://example.com/provider-image.png", kind: "image" },
      { driveFileId: "drive-asset-123", kind: "archive" },
    ];
    expect(outputDriveFileId(outputs)).toBe("drive-asset-123");
    expect(outputProviderUrl(outputs)).toBe("https://example.com/provider-image.png");
  });

  it("finds the durable generation provider URL when no Drive pointer exists yet", () => {
    const outputs = [{ url: "https://example.com/generated-video.mp4", kind: "video" }];
    expect(outputDriveFileId(outputs)).toBeNull();
    expect(outputProviderUrl(outputs)).toBe("https://example.com/generated-video.mp4");
  });

  it("fails closed at the caller when neither transport is available", () => {
    const outputs = [{ kind: "image" }, { url: "   " }];
    expect(outputDriveFileId(outputs)).toBeNull();
    expect(outputProviderUrl(outputs)).toBeNull();
  });
});
