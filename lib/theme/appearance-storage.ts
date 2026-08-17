import type { AppearanceSettings } from "@/lib/types/workspace";

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "dark",
  accentColor: "amber",
  font: "geist",
  density: "comfortable",
};

const STORAGE_KEY = "acf-appearance";
const APPEARANCE_CHANGE_EVENT = "acf-appearance-change";

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
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;
  cachedSnapshot = parseAppearance(raw);
  return cachedSnapshot;
}

export function writeAppearanceSnapshot(settings: AppearanceSettings): void {
  const serialized = JSON.stringify({ ...DEFAULT_APPEARANCE, ...settings });
  const changed = localStorage.getItem(STORAGE_KEY) !== serialized;

  if (changed) {
    localStorage.setItem(STORAGE_KEY, serialized);
  }
  if (cachedRaw !== serialized) {
    cachedRaw = serialized;
    cachedSnapshot = parseAppearance(serialized);
  }

  // The native `storage` event only fires in *other* tabs. Emit a local event
  // so useSyncExternalStore subscribers in the current tab update immediately.
  if (changed) {
    window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
  }
}

export function subscribeAppearanceStorage(callback: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(APPEARANCE_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(APPEARANCE_CHANGE_EVENT, callback);
  };
}

/** Test helper — reset module-level cache between tests. */
export function resetAppearanceSnapshotCache(): void {
  cachedRaw = undefined;
  cachedSnapshot = DEFAULT_APPEARANCE;
}
