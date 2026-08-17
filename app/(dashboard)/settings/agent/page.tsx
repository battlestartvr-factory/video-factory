"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { t } from "@/lib/i18n/dictionary";

interface PolicyBlock {
  version: string;
  text: string;
}

interface AgentConfigResponse {
  productMission: PolicyBlock;
  operatingInstructions: PolicyBlock;
  runtimePolicy: PolicyBlock;
}

function ReadOnlyBlock({ title, description, block }: {
  title: string;
  description: string;
  block: PolicyBlock | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        {block ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground">v{block.version} · только для чтения</p>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-hover p-4 text-xs leading-relaxed text-muted-foreground">
              {block.text}
            </pre>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function AgentSettingsPage() {
  const [data, setData] = useState<AgentConfigResponse | null>(null);

  useEffect(() => {
    fetch("/api/agent-config")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setData(d.data as AgentConfigResponse);
      });
  }, []);

  return (
    <SettingsLayout>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{t("settings.agent")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Главная миссия и правила агента едины для всего завода и управляются кодом. Пользовательские промты не могут их переопределить.
          </p>
        </div>

        <ReadOnlyBlock
          title="Миссия продукта"
          description="Главная оптимизационная функция: поиск и доказательная валидация идеи реальной PC/Steam co-op игры. Этот слой всегда присутствует в контексте агента."
          block={data?.productMission ?? null}
        />

        <ReadOnlyBlock
          title="Рабочие инструкции агента"
          description="Как Universal Agent использует инструменты, документы, web, генерацию и память для выполнения задач внутри этой миссии."
          block={data?.operatingInstructions ?? null}
        />

        <ReadOnlyBlock
          title="Технические правила агента"
          description="Нередактируемые runtime-ограничения: безопасность источников, честное состояние задач, правила записи памяти и порядок работы с инструментами."
          block={data?.runtimePolicy ?? null}
        />
      </div>
    </SettingsLayout>
  );
}
