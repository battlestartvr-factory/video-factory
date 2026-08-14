import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { getIntegrationsStatus } from "@/lib/integrations/status";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n/dictionary";

async function getProfile() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    return profile;
  } catch {
    return null;
  }
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-zinc-600"}`}
      aria-hidden
    />
  );
}

export default async function SettingsGeneralPage() {
  const profile = await getProfile();
  const integrations = await getIntegrationsStatus();

  const rows = [
    { key: "supabase" as const, label: "Supabase" },
    { key: "n8n" as const, label: "n8n Cloud" },
    { key: "googleDrive" as const, label: "Google Drive" },
    { key: "mockWorkflows" as const, label: "Mock workflows" },
  ];

  return (
    <SettingsLayout>
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-bold">{t("settings.title")}</h1>

        <Card>
          <CardHeader>
            <CardTitle>{t("settings.profile")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-foreground">{profile?.display_name ?? "—"}</p>
            <p className="text-muted-foreground">{profile?.email ?? "—"}</p>
            <p className="text-muted-foreground">Роль: {profile?.role ?? "—"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("settings.integrations")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {rows.map(({ key, label }) => {
              const status = integrations[key];
              return (
                <div key={key} className="flex items-center justify-between gap-4">
                  <span className="text-foreground">{label}</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <StatusDot connected={status.reachable} />
                    {status.reachable ? t("settings.connected") : t("settings.notConfigured")}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </SettingsLayout>
  );
}
