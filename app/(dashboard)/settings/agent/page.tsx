"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { t } from "@/lib/i18n/dictionary";
import { AGENT_RUNTIME_POLICY_VERSION } from "@/lib/agent/runtime-policy";

interface AgentConfigData {
  id: string;
  system_prompt: string;
  version: number;
  updated_at: string;
}

export default function AgentSettingsPage() {
  const [config, setConfig] = useState<AgentConfigData | null>(null);
  const [runtimePolicy, setRuntimePolicy] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/agent-config")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setConfig(d.data.config);
          setSystemPrompt(d.data.config.system_prompt ?? "");
          setRuntimePolicy(d.data.runtimePolicy?.text ?? "");
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    const res = await fetch("/api/agent-config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt }),
    });
    const data = await res.json();
    if (data.ok) {
      setConfig(data.data.config);
      setSystemPrompt(data.data.config.system_prompt);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const handleReset = async () => {
    if (!window.confirm("Восстановить базовый вариант глобальных инструкций?")) return;
    const res = await fetch("/api/agent-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    const data = await res.json();
    if (data.ok) {
      setConfig(data.data.config);
      setSystemPrompt(data.data.config.system_prompt);
    }
  };

  if (loading) {
    return (
      <SettingsLayout>
        <div className="mx-auto max-w-2xl p-8 text-muted-foreground">{t("common.loading")}</div>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout>
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{t("settings.agent")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("settings.agentDescription")}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("settings.globalAgentInstructions")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={16}
              placeholder="Глобальные инструкции агента…"
            />
            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <span>Версия: {config?.version ?? 1}</span>
              {config?.updated_at ? (
                <span>
                  Последнее изменение:{" "}
                  {new Date(config.updated_at).toLocaleString("ru-RU")}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSave}>
                {saved ? t("settings.saved") : t("settings.save")}
              </Button>
              <Button variant="ghost" onClick={handleReset}>
                {t("settings.restoreDefaultAgent")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left"
              onClick={() => setPolicyOpen((v) => !v)}
            >
              {policyOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <CardTitle className="text-base">{t("settings.runtimePolicy")}</CardTitle>
            </button>
          </CardHeader>
          {policyOpen ? (
            <CardContent>
              <p className="mb-2 text-xs text-muted-foreground">
                v{AGENT_RUNTIME_POLICY_VERSION} — только для чтения
              </p>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-hover p-4 text-xs text-muted-foreground">
                {runtimePolicy}
              </pre>
            </CardContent>
          ) : null}
        </Card>
      </div>
    </SettingsLayout>
  );
}
