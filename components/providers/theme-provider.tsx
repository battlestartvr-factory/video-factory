"use client";

import { createContext, useContext, useEffect, useState, useCallback, useSyncExternalStore, useMemo } from "react";
import type { AppearanceSettings } from "@/lib/types/workspace";

const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "dark",
  accentColor: "amber",
  font: "geist",
  density: "comfortable",
};

function subscribeStorage(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) as T };
  } catch {
    return fallback;
  }
}

function getAppearanceSnapshot(): AppearanceSettings {
  return readJsonStorage("acf-appearance", DEFAULT_APPEARANCE);
}

function getSidebarCollapsedSnapshot(): boolean {
  return localStorage.getItem("acf-sidebar-collapsed") === "true";
}

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

  const appearance = useMemo(
    () => ({ ...storedAppearance, ...appearanceOverrides }),
    [storedAppearance, appearanceOverrides],
  );
  const sidebarCollapsed = sidebarCollapsedOverride ?? storedCollapsed;

  useEffect(() => {
    applyAppearance(appearance);
    localStorage.setItem("acf-appearance", JSON.stringify(appearance));
  }, [appearance]);

  useEffect(() => {
    localStorage.setItem("acf-sidebar-collapsed", String(sidebarCollapsed));
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
      localStorage.setItem("acf-appearance", JSON.stringify({ ...storedAppearance, ...next }));
      return next;
    });
  }, [storedAppearance]);

  const setSidebarCollapsed = useCallback((v: boolean) => {
    setSidebarCollapsedOverride(v);
    localStorage.setItem("acf-sidebar-collapsed", String(v));
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        appearance,
        setAppearance,
        sidebarCollapsed,
        setSidebarCollapsed,
        mobileSidebarOpen,
        setMobileSidebarOpen,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
