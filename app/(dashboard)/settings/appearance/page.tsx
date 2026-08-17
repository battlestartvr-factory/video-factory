"use client";

import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { useTheme } from "@/components/providers/theme-provider";
import { t } from "@/lib/i18n/dictionary";

const ACCENT_COLORS = ["amber", "violet", "emerald", "rose", "sky"] as const;
const ACCENT_SWATCHES: Record<(typeof ACCENT_COLORS)[number], string> = {
  amber: "#f59e0b",
  violet: "#8b5cf6",
  emerald: "#10b981",
  rose: "#f43f5e",
  sky: "#0ea5e9",
};

type SaveState = "idle" | "saving" | "saved" | "error";

export default function AppearanceSettingsPage() {
  const { appearance, setAppearance } = useTheme();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const save = (partial: Parameters<typeof setAppearance>[0]) => {
    // Apply instantly in the current tab, then serialize PATCH requests so a
    // slower older request can never overwrite a newer appearance choice.
    setAppearance(partial);
    setSaveState("saving");

    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch("/api/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appearance: partial }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error?.message ?? "Failed to save appearance");
        }
      });

    const pendingSave = saveQueue.current;
    void pendingSave
      .then(() => {
        if (saveQueue.current === pendingSave) setSaveState("saved");
      })
      .catch(() => {
        if (saveQueue.current === pendingSave) setSaveState("error");
      });
  };

  return (
    <SettingsLayout>
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold">{t("settings.appearance")}</h1>
          <span
            className={`text-xs ${saveState === "error" ? "text-rose-400" : "text-muted-foreground"}`}
            aria-live="polite"
          >
            {saveState === "saving"
              ? "Сохранение…"
              : saveState === "saved"
                ? "Сохранено"
                : saveState === "error"
                  ? "Не удалось сохранить"
                  : ""}
          </span>
        </div>

        <Card>
          <CardHeader><CardTitle>{t("settings.theme")}</CardTitle></CardHeader>
          <CardContent>
            <Select
              value={appearance.theme ?? "dark"}
              onChange={(e) => save({ theme: e.target.value as "dark" | "light" | "system" })}
            >
              <option value="dark">Тёмная</option>
              <option value="light">Светлая</option>
              <option value="system">Системная</option>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.accent")}</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {ACCENT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => save({ accentColor: color })}
                  className={`h-9 w-9 rounded-full border-2 transition-transform hover:scale-110 ${
                    appearance.accentColor === color ? "scale-110 border-foreground" : "border-transparent"
                  }`}
                  style={{ backgroundColor: ACCENT_SWATCHES[color] }}
                  aria-label={`Акцент: ${color}`}
                  aria-pressed={appearance.accentColor === color}
                />
              ))}
            </div>
            <Select
              value={appearance.accentColor ?? "amber"}
              onChange={(e) => save({ accentColor: e.target.value as (typeof ACCENT_COLORS)[number] })}
              className="mt-3"
            >
              {ACCENT_COLORS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.font")}</CardTitle></CardHeader>
          <CardContent>
            <Select
              value={appearance.font ?? "geist"}
              onChange={(e) => save({ font: e.target.value as "geist" | "system" | "mono" })}
            >
              <option value="geist">Geist Sans</option>
              <option value="system">System</option>
              <option value="mono">Geist Mono</option>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.density")}</CardTitle></CardHeader>
          <CardContent>
            <Select
              value={appearance.density ?? "comfortable"}
              onChange={(e) => save({ density: e.target.value as "comfortable" | "compact" })}
            >
              <option value="comfortable">Комфортная</option>
              <option value="compact">Компактная</option>
            </Select>
          </CardContent>
        </Card>
      </div>
    </SettingsLayout>
  );
}
