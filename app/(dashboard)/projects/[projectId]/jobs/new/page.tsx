"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, Select } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { JOB_MODE_LABELS, JOB_TYPE_LABELS } from "@/lib/jobs/status-transitions";
import { t } from "@/lib/i18n/dictionary";

const STEPS = ["type", "source", "params", "mode", "confirm"] as const;

const JOB_TYPES = Object.keys(JOB_TYPE_LABELS);
const MODES = Object.keys(JOB_MODE_LABELS);
const PLATFORMS = ["youtube_shorts", "instagram", "tiktok", "telegram", "vk"];

export default function NewJobPage() {
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const [step, setStep] = useState(0);
  const [type, setType] = useState("short_video");
  const [sourceInput, setSourceInput] = useState("");
  const [language, setLanguage] = useState("ru");
  const [targetPlatform, setTargetPlatform] = useState("youtube_shorts");
  const [brief, setBrief] = useState("");
  const [mode, setMode] = useState("balanced");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    setError(null);

    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: params.projectId,
        type,
        sourceInput,
        language,
        targetPlatform,
        brief: brief || null,
        mode,
      }),
    });

    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? t("common.error"));
      setLoading(false);
      return;
    }

    router.push(`/jobs/${json.data.id}`);
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">{t("jobs.new")}</h1>

      <div className="flex gap-2">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full ${i <= step ? "bg-amber-500" : "bg-zinc-800"}`}
            aria-hidden
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {step === 0 && t("jobs.type")}
            {step === 1 && t("jobs.source")}
            {step === 2 && "Параметры"}
            {step === 3 && t("jobs.mode")}
            {step === 4 && t("jobs.confirm")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <ErrorState message={error} />}

          {step === 0 && (
            <Select value={type} onChange={(e) => setType(e.target.value)} aria-label={t("jobs.type")}>
              {JOB_TYPES.map((jt) => (
                <option key={jt} value={jt}>
                  {JOB_TYPE_LABELS[jt]}
                </option>
              ))}
            </Select>
          )}

          {step === 1 && (
            <div className="space-y-2">
              <Label htmlFor="source">Google Drive URL или file_id</Label>
              <Input
                id="source"
                placeholder="https://drive.google.com/file/d/..."
                value={sourceInput}
                onChange={(e) => setSourceInput(e.target.value)}
                required
              />
            </div>
          )}

          {step === 2 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="language">{t("jobs.language")}</Label>
                <Input id="language" value={language} onChange={(e) => setLanguage(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="platform">{t("jobs.platform")}</Label>
                <Select id="platform" value={targetPlatform} onChange={(e) => setTargetPlatform(e.target.value)}>
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="brief">{t("jobs.brief")}</Label>
                <Textarea id="brief" value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={5000} />
              </div>
            </>
          )}

          {step === 3 && (
            <Select value={mode} onChange={(e) => setMode(e.target.value)} aria-label={t("jobs.mode")}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {JOB_MODE_LABELS[m]}
                </option>
              ))}
            </Select>
          )}

          {step === 4 && (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-zinc-500">Тип</dt>
                <dd>{JOB_TYPE_LABELS[type]}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Источник</dt>
                <dd className="max-w-[200px] truncate">{sourceInput}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Режим</dt>
                <dd>{JOB_MODE_LABELS[mode]}</dd>
              </div>
            </dl>
          )}

          <div className="flex gap-2 pt-4">
            {step > 0 && (
              <Button type="button" variant="secondary" onClick={() => setStep(step - 1)}>
                {t("common.back")}
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button
                type="button"
                onClick={() => setStep(step + 1)}
                disabled={step === 1 && !sourceInput.trim()}
              >
                {t("common.next")}
              </Button>
            ) : (
              <Button type="button" onClick={handleSubmit} disabled={loading}>
                {loading ? t("common.loading") : t("jobs.confirm")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
