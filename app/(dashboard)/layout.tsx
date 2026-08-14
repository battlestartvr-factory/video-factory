import { Sidebar, MobileNav } from "@/components/layout/sidebar";
import { DemoBanner } from "@/components/ui/states";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { RecentChatsProvider } from "@/components/providers/recent-chats-provider";
import { isMockWorkflowsEnabled } from "@/lib/env/mock-workflows";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Chat } from "@/lib/types/workspace";
import type { Project } from "@/lib/types/database";

async function getSidebarData() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { recentProjects: [], recentChats: [] };

    const [{ data: projects }, { data: chats }] = await Promise.all([
      supabase.from("projects").select("id, name").eq("status", "active").order("updated_at", { ascending: false }).limit(5),
      supabase.from("chats").select("id, title").eq("user_id", user.id).is("archived_at", null).order("updated_at", { ascending: false }).limit(5),
    ]);

    return {
      recentProjects: (projects ?? []) as Pick<Project, "id" | "name">[],
      recentChats: (chats ?? []) as Pick<Chat, "id" | "title">[],
    };
  } catch {
    return { recentProjects: [], recentChats: [] };
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { recentProjects, recentChats } = await getSidebarData();

  return (
    <ThemeProvider>
      <RecentChatsProvider
        key={recentChats.map((chat) => chat.id).join(",")}
        initialChats={recentChats}
      >
        <div className="gradient-bg flex min-h-dvh flex-col">
          {isMockWorkflowsEnabled() && <DemoBanner />}
          <div className="flex min-h-0 flex-1">
            <Sidebar recentProjects={recentProjects} />
            <div className="flex min-h-dvh min-w-0 flex-1 flex-col pb-16 md:pb-0">
              <main className="flex min-h-0 flex-1 flex-col">{children}</main>
            </div>
          </div>
          <MobileNav />
        </div>
      </RecentChatsProvider>
    </ThemeProvider>
  );
}
