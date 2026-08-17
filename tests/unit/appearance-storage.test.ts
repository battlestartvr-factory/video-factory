// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPEARANCE,
  getAppearanceSnapshot,
  resetAppearanceSnapshotCache,
  subscribeAppearanceStorage,
  writeAppearanceSnapshot,
} from "@/lib/theme/appearance-storage";

describe("appearance storage", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAppearanceSnapshotCache();
  });

  it("persists appearance and notifies subscribers in the same tab", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppearanceStorage(listener);

    writeAppearanceSnapshot({
      ...DEFAULT_APPEARANCE,
      accentColor: "violet",
      font: "mono",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAppearanceSnapshot()).toMatchObject({
      accentColor: "violet",
      font: "mono",
    });

    unsubscribe();
  });

  it("does not emit a duplicate change event for an identical snapshot", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppearanceStorage(listener);
    const appearance = { ...DEFAULT_APPEARANCE, accentColor: "sky" as const };

    writeAppearanceSnapshot(appearance);
    writeAppearanceSnapshot(appearance);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
