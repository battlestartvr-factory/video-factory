import { describe, it, expect } from "vitest";
import { parseGoogleDriveInput } from "@/lib/storage/providers";

describe("parseGoogleDriveInput", () => {
  it("parses file id directly", () => {
    const ref = parseGoogleDriveInput("1abcDEFghIJklmnOP_qrsTUV");
    expect(ref?.externalId).toBe("1abcDEFghIJklmnOP_qrsTUV");
    expect(ref?.provider).toBe("google_drive");
  });

  it("parses drive file URL", () => {
    const ref = parseGoogleDriveInput(
      "https://drive.google.com/file/d/1abcDEFghIJklmnOP_qrsTUV/view",
    );
    expect(ref?.externalId).toBe("1abcDEFghIJklmnOP_qrsTUV");
  });

  it("parses open?id URL", () => {
    const ref = parseGoogleDriveInput(
      "https://drive.google.com/open?id=1abcDEFghIJklmnOP_qrsTUV",
    );
    expect(ref?.externalId).toBe("1abcDEFghIJklmnOP_qrsTUV");
  });

  it("returns null for invalid input", () => {
    expect(parseGoogleDriveInput("not-a-valid-link")).toBeNull();
  });
});
