"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { t } from "@/lib/i18n/dictionary";
import type { PersonalizationSettings } from "@/lib/types/workspace";

export default function PersonalizationSettingsPage() {
  const [settings, setSettings] = useState<PersonalizationSettings>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setSettings(d.data.personalization ?? {});
      });
  }, []);

  const handleSave = async () => {
    const rest = { ...settings };
    delete rest.globalInstructions;
    await fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personalization: rest }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <SettingsLayout>
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{t("settings.personalization")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("settings.personalizationDescription")}</p>
        </div>

        <Card>
          <CardHeader><CardTitle>{t("settings.aboutMe")}</CardTitle></CardHeader>
          <CardContent>
            <Textarea
              value={settings.aboutMe ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, aboutMe: e.target.value }))}
              rows={4}
              placeholder="Расскажите о себе, вашей роли и компании…"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.communicationStyle")}</CardTitle></CardHeader>
          <CardContent>
            <Textarea
              value={settings.communicationStyle ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, communicationStyle: e.target.value }))}
              rows={2}
              placeholder="Например: кратко, по делу, на русском…"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.preferredLanguage")}</CardTitle></CardHeader>
          <CardContent>
            <Select
              value={settings.preferredLanguage ?? "ru"}
              onChange={(e) => setSettings((s) => ({ ...s, preferredLanguage: e.target.value }))}
            >
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("settings.behaviorPreferences")}</CardTitle></CardHeader>
          <CardContent>
            <Textarea
              value={settings.agentBehavior ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, agentBehavior: e.target.value }))}
              rows={3}
              placeholder="Ваши предпочтения по поведению агента…"
            />
          </CardContent>
        </Card>

        <Button onClick={handleSave}>
          {saved ? t("settings.saved") : t("settings.save")}
        </Button>
      </div>
    </SettingsLayout>
  );
}
