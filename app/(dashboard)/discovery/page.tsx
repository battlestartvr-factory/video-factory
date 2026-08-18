import { DiscoveryPageClient } from "@/components/discovery/discovery-page-client";
import { getSessionUser } from "@/lib/auth/session";
import { listGameDiscoveryBatches } from "@/lib/game-discovery/service";

export default async function DiscoveryPage() {
  const user = await getSessionUser();
  const batches = user
    ? await listGameDiscoveryBatches({ userId: user.id, limit: 30 }).catch(() => [])
    : [];

  return (
    <DiscoveryPageClient
      initialBatches={batches.map((batch) => ({
        id: batch.id,
        title: batch.title,
        status: batch.status,
        created_at: batch.created_at,
      }))}
    />
  );
}
