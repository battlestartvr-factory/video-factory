import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_APPEARANCE,
  getAppearanceSnapshot,
  writeAppearanceSnapshot,
  resetAppearanceSnapshotCache,
} from "@/lib/theme/appearance-storage";

describe("appearance storage snapshot", () => {
  const store: Record<string, string> = {};

  beforeEach(() => {
    resetAppearanceSnapshotCache();
    for (const key of Object.keys(store)) delete store[key];
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
        removeItem: (key: string) => {
          delete store[key];
        },
      },
      configurable: true,
    });
  });

  it("returns stable object reference when localStorage is unchanged", () => {
    store["acf-appearance"] = JSON.stringify({ theme: "dark", accentColor: "violet" });

    const first = getAppearanceSnapshot();
    const second = getAppearanceSnapshot();
    const third = getAppearanceSnapshot();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first.theme).toBe("dark");
    expect(first.accentColor).toBe("violet");
    expect(first.font).toBe(DEFAULT_APPEARANCE.font);
  });

  it("returns new reference only when localStorage value changes", () => {
    store["acf-appearance"] = JSON.stringify({ theme: "dark" });
    const before = getAppearanceSnapshot();

    store["acf-appearance"] = JSON.stringify({ theme: "light" });
    resetAppearanceSnapshotCache();
    const after = getAppearanceSnapshot();

    expect(before).not.toBe(after);
    expect(after.theme).toBe("light");
  });

  it("writeAppearanceSnapshot keeps getAppearanceSnapshot stable across reads", () => {
    const settings = { ...DEFAULT_APPEARANCE, theme: "light" as const };
    writeAppearanceSnapshot(settings);

    const a = getAppearanceSnapshot();
    const b = getAppearanceSnapshot();

    expect(a).toBe(b);
    expect(a.theme).toBe("light");
  });
});
