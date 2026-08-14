"use client";

import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { useTheme } from "@/components/providers/theme-provider";
import { t } from "@/lib/i18n/dictionary";

const ACCENT_COLORS = ["amber", "violet", "emerald", "rose", "sky"] as const;

export default function AppearanceSettingsPage() {
  const { appearance, setAppearance } = useTheme();

  useEffect(() => {
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.data.appearance) {
          setAppearance(d.data.appearance);
        }
      });
  }, [setAppearance]);

  const save = (partial: Parameters<typeof setAppearance>[0]) => {
    setAppearance(partial);
    fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appearance: { ...appearance, ...partial } }),
    });
  };

  return (
    <SettingsLayout>
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-bold">{t("settings.appearance")}</h1>

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
            <div className="flex flex-wrap gap-2">
              {ACCENT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => save({ accentColor: color })}
                  className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${
                    appearance.accentColor === color ? "border-foreground scale-110" : "border-transparent"
                  }`}
                  style={{ background: `var(--accent)` }}
                  data-accent={color}
                  aria-label={color}
                />
              ))}
            </div>
            <Select
              value={appearance.accentColor ?? "amber"}
              onChange={(e) => save({ accentColor: e.target.value as typeof ACCENT_COLORS[number] })}
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
