import { Sidebar, MobileNav } from "@/components/layout/sidebar";
import { DemoBanner } from "@/components/ui/states";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { RecentChatsProvider } from "@/components/providers/recent-chats-provider";
import { isMockWorkflowsEnabled } from "@/lib/env/mock-workflows";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AppearanceSettings, Chat } from "@/lib/types/workspace";
import type { Project } from "@/lib/types/database";

async function getDashboardData() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { recentProjects: [], recentChats: [], initialAppearance: null };

    const [{ data: projects }, { data: chats }, { data: preferences }] = await Promise.all([
      supabase.from("projects").select("id, name").eq("status", "active").order("updated_at", { ascending: false }).limit(5),
      supabase.from("chats").select("id, title").eq("user_id", user.id).is("archived_at", null).order("updated_at", { ascending: false }).limit(5),
      supabase.from("user_preferences").select("appearance").eq("user_id", user.id).maybeSingle(),
    ]);

    return {
      recentProjects: (projects ?? []) as Pick<Project, "id" | "name">[],
      recentChats: (chats ?? []) as Pick<Chat, "id" | "title">[],
      initialAppearance: (preferences?.appearance ?? null) as AppearanceSettings | null,
    };
  } catch {
    return { recentProjects: [], recentChats: [], initialAppearance: null };
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { recentProjects, recentChats, initialAppearance } = await getDashboardData();

  return (
    <ThemeProvider initialAppearance={initialAppearance}>
      <RecentChatsProvider
        key={recentChats.map((chat) => chat.id).join(",")}
        initialChats={recentChats}
      >
        <div className="gradient-bg flex h-dvh min-h-0 flex-col overflow-hidden">
          {isMockWorkflowsEnabled() && <DemoBanner />}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <Sidebar recentProjects={recentProjects} />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-16 md:pb-0">
              <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
            </div>
          </div>
          <MobileNav />
        </div>
      </RecentChatsProvider>
    </ThemeProvider>
  );
}
