import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n/dictionary";

async function getProfile() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();
    return profile;
  } catch {
    return null;
  }
}

async function getIntegrationStatus() {
  const res = await fetch(`${process.env.APP_URL ?? "http://localhost:3000"}/api/integrations/status`, {
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) {
    return {
      supabase: false,
      n8n: false,
      googleDrive: false,
      mockWorkflows: true,
    };
  }
  const json = await res.json();
  return json.ok ? json.data : {};
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-zinc-600"}`}
      aria-hidden
    />
  );
}

export default async function SettingsPage() {
  const profile = await getProfile();
  const integrations = await getIntegrationStatus();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">{t("settings.title")}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.profile")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-zinc-300">{profile?.display_name ?? "—"}</p>
          <p className="text-zinc-500">{profile?.email ?? "—"}</p>
          <p className="text-zinc-500">Роль: {profile?.role ?? "—"}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.integrations")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {[
            { key: "supabase", label: "Supabase" },
            { key: "n8n", label: "n8n Cloud" },
            { key: "googleDrive", label: "Google Drive" },
            { key: "mockWorkflows", label: "Mock workflows" },
          ].map(({ key, label }) => {
            const connected = integrations[key as keyof typeof integrations];
            return (
              <div key={key} className="flex items-center justify-between">
                <span className="text-zinc-300">{label}</span>
                <span className="flex items-center gap-2 text-zinc-500">
                  <StatusDot connected={Boolean(connected)} />
                  {connected ? t("settings.connected") : t("settings.notConfigured")}
                </span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Переменные окружения</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-zinc-400">
          <p>Секреты задаются в Vercel и n8n, не через этот интерфейс.</p>
          <ul className="mt-3 list-inside list-disc space-y-1">
            <li>Vercel: NEXT_PUBLIC_SUPABASE_*, SUPABASE_SERVICE_ROLE_KEY, N8N_*</li>
            <li>n8n: OpenRouter, fal.ai, Google Drive credentials</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
