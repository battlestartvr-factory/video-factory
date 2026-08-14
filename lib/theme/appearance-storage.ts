import type { AppearanceSettings } from "@/lib/types/workspace";

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "dark",
  accentColor: "amber",
  font: "geist",
  density: "comfortable",
};

let cachedRaw: string | null | undefined;
let cachedSnapshot: AppearanceSettings = DEFAULT_APPEARANCE;

function parseAppearance(raw: string | null): AppearanceSettings {
  if (!raw) return DEFAULT_APPEARANCE;
  try {
    return { ...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as Partial<AppearanceSettings>) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Stable snapshot for useSyncExternalStore — same reference until localStorage changes. */
export function getAppearanceSnapshot(): AppearanceSettings {
  const raw = localStorage.getItem("acf-appearance");
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;
  cachedSnapshot = parseAppearance(raw);
  return cachedSnapshot;
}

export function writeAppearanceSnapshot(settings: AppearanceSettings): void {
  const serialized = JSON.stringify(settings);
  if (localStorage.getItem("acf-appearance") !== serialized) {
    localStorage.setItem("acf-appearance", serialized);
  }
  if (cachedRaw !== serialized) {
    cachedRaw = serialized;
    cachedSnapshot = parseAppearance(serialized);
  }
}

export function subscribeAppearanceStorage(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

/** Test helper — reset module-level cache between tests. */
export function resetAppearanceSnapshotCache(): void {
  cachedRaw = undefined;
  cachedSnapshot = DEFAULT_APPEARANCE;
}
