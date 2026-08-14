import { ResultsPageClient } from "@/components/results/results-page-client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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

export default async function ResultsPage() {
  const assets = await getAssets();
  return <ResultsPageClient initialAssets={assets} />;
}
