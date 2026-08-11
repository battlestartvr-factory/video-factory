import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { t } from "@/lib/i18n/dictionary";
import type { Asset } from "@/lib/types/database";

async function getAssets(): Promise<Asset[]> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase
      .from("assets")
      .select("*")
      .neq("kind", "source")
      .order("created_at", { ascending: false })
      .limit(50);
    return (data ?? []) as Asset[];
  } catch {
    return [];
  }
}

export default async function AssetsPage() {
  const assets = await getAssets();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-bold">{t("assets.title")}</h1>

      {assets.length === 0 ? (
        <EmptyState title={t("assets.empty")} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((asset) => (
            <Card key={asset.id}>
              <CardContent className="p-4">
                <div className="reference-placeholder mb-3 flex h-32 items-center justify-center rounded-lg text-xs text-zinc-500">
                  {asset.kind === "image" ? "Preview" : asset.kind}
                </div>
                <p className="font-medium capitalize text-zinc-200">{asset.kind}</p>
                <p className="text-xs text-zinc-500">{formatDate(asset.created_at)}</p>
                {asset.url && (
                  <a
                    href={asset.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-sm text-amber-400 hover:underline"
                  >
                    {t("assets.openDrive")}
                  </a>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
