"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useSyncExternalStore,
  useMemo,
  useRef,
} from "react";
import type { AppearanceSettings } from "@/lib/types/workspace";
import {
  DEFAULT_APPEARANCE,
  getAppearanceSnapshot,
  writeAppearanceSnapshot,
  subscribeAppearanceStorage,
} from "@/lib/theme/appearance-storage";
import {
  getSidebarCollapsedSnapshot,
  writeSidebarCollapsedSnapshot,
  subscribeSidebarStorage,
} from "@/lib/theme/sidebar-storage";

interface ThemeContextValue {
  appearance: AppearanceSettings;
  setAppearance: (settings: Partial<AppearanceSettings>) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (v: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveAppearance(settings?: Partial<AppearanceSettings> | null): AppearanceSettings {
  return { ...DEFAULT_APPEARANCE, ...(settings ?? {}) };
}

function applyAppearance(settings: AppearanceSettings) {
  const root = document.documentElement;

  const theme = settings.theme ?? "dark";
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", prefersDark ? "dark" : "light");
  } else {
    root.setAttribute("data-theme", theme === "light" ? "light" : "dark");
  }

  root.setAttribute("data-accent", settings.accentColor ?? "amber");
  root.setAttribute("data-density", settings.density ?? "comfortable");

  const body = document.body;
  if (settings.font === "mono") {
    body.style.setProperty("--font-app-sans", "var(--font-geist-mono)");
  } else if (settings.font === "system") {
    body.style.setProperty(
      "--font-app-sans",
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    );
  } else {
    body.style.setProperty("--font-app-sans", "var(--font-geist-sans)");
  }
}

export function ThemeProvider({
  children,
  initialAppearance,
}: {
  children: React.ReactNode;
  initialAppearance?: AppearanceSettings | null;
}) {
  const serverAppearance = useMemo(
    () => resolveAppearance(initialAppearance),
    [initialAppearance],
  );
  const seededServerAppearance = useRef(false);

  const appearance = useSyncExternalStore(
    subscribeAppearanceStorage,
    getAppearanceSnapshot,
    () => serverAppearance,
  );
  const storedCollapsed = useSyncExternalStore(
    subscribeSidebarStorage,
    getSidebarCollapsedSnapshot,
    () => false,
  );

  const [sidebarCollapsedOverride, setSidebarCollapsedOverride] = useState<boolean | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarCollapsed = sidebarCollapsedOverride ?? storedCollapsed;

  // Supabase is the durable source of truth. Seed the client cache once when the
  // dashboard mounts so a stale localStorage value cannot silently win later.
  useEffect(() => {
    if (seededServerAppearance.current || !initialAppearance) return;
    seededServerAppearance.current = true;
    writeAppearanceSnapshot(serverAppearance);
  }, [initialAppearance, serverAppearance]);

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    writeSidebarCollapsedSnapshot(sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (appearance.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyAppearance(appearance);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [appearance]);

  const setAppearance = useCallback((partial: Partial<AppearanceSettings>) => {
    const current = getAppearanceSnapshot();
    writeAppearanceSnapshot(resolveAppearance({ ...current, ...partial }));
  }, []);

  const setSidebarCollapsed = useCallback((v: boolean) => {
    setSidebarCollapsedOverride(v);
    writeSidebarCollapsedSnapshot(v);
  }, []);

  const contextValue = useMemo(
    () => ({
      appearance,
      setAppearance,
      sidebarCollapsed,
      setSidebarCollapsed,
      mobileSidebarOpen,
      setMobileSidebarOpen,
    }),
    [appearance, setAppearance, sidebarCollapsed, setSidebarCollapsed, mobileSidebarOpen],
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
