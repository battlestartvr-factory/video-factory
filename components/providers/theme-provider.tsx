"use client";

import { createContext, useContext, useEffect, useState, useCallback, useSyncExternalStore, useMemo } from "react";
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

  if (settings.font === "mono") {
    root.style.setProperty("--font-geist-sans", "var(--font-geist-mono)");
  } else {
    root.style.removeProperty("--font-geist-sans");
  }
}

function subscribeStorage(callback: () => void) {
  const unsubAppearance = subscribeAppearanceStorage(callback);
  const unsubSidebar = subscribeSidebarStorage(callback);
  return () => {
    unsubAppearance();
    unsubSidebar();
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const storedAppearance = useSyncExternalStore(
    subscribeStorage,
    getAppearanceSnapshot,
    () => DEFAULT_APPEARANCE,
  );
  const storedCollapsed = useSyncExternalStore(
    subscribeStorage,
    getSidebarCollapsedSnapshot,
    () => false,
  );

  const [appearanceOverrides, setAppearanceOverrides] = useState<Partial<AppearanceSettings>>({});
  const [sidebarCollapsedOverride, setSidebarCollapsedOverride] = useState<boolean | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const appearance = useMemo(() => {
    if (Object.keys(appearanceOverrides).length === 0) return storedAppearance;
    return { ...storedAppearance, ...appearanceOverrides };
  }, [storedAppearance, appearanceOverrides]);
  const sidebarCollapsed = sidebarCollapsedOverride ?? storedCollapsed;

  useEffect(() => {
    applyAppearance(appearance);
    writeAppearanceSnapshot(appearance);
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
    setAppearanceOverrides((prev) => {
      const next = { ...prev, ...partial };
      const merged = { ...storedAppearance, ...next };
      writeAppearanceSnapshot(merged);
      return next;
    });
  }, [storedAppearance]);

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
