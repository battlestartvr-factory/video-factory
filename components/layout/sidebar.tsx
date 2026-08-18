"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  LayoutDashboard,
  MessageSquare,
  Search,
  ImageIcon,
  Video,
  FolderKanban,
  BookOpen,
  Layers,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Plus,
  X,
  Coins,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n/dictionary";
import { useTheme } from "@/components/providers/theme-provider";
import { useRecentChats } from "@/components/providers/recent-chats-provider";
import { ChatActionsMenu } from "@/components/chat/chat-actions-menu";
import type { Project } from "@/lib/types/database";

const mainNavItems = [
  { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
  { href: "/chat", label: t("nav.chat"), icon: MessageSquare },
  { href: "/discovery", label: t("nav.discovery"), icon: Search },
  { href: "/images", label: t("nav.images"), icon: ImageIcon },
  { href: "/video", label: t("nav.video"), icon: Video },
  { href: "/projects", label: t("nav.projects"), icon: FolderKanban },
  { href: "/knowledge", label: t("nav.knowledge"), icon: BookOpen },
  { href: "/results", label: t("nav.results"), icon: Layers },
  { href: "/settings", label: t("nav.settings"), icon: Settings },
];

interface SidebarProps {
  recentProjects?: Pick<Project, "id" | "name">[];
}

function NavLink({
  href,
  label,
  icon: Icon,
  collapsed,
  onClick,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  collapsed: boolean;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));

  return (
    <Link
      href={href}
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150",
        active
          ? "bg-accent-muted text-accent font-medium shadow-sm"
          : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        collapsed && "justify-center px-2",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className={cn("h-4 w-4 shrink-0", active && "text-accent")} aria-hidden />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

function KieCreditsBadge({ collapsed }: { collapsed: boolean }) {
  const [credits, setCredits] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/kie/credits", { cache: "no-store" });
      const payload = await response.json();
      const value = payload?.ok ? payload?.data?.credits : null;
      if (!response.ok || typeof value !== "number") {
        setAvailable(false);
        return;
      }
      setCredits(value);
      setAvailable(true);
    } catch {
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const formatted = credits === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(credits);
  const title = available ? `KIE: ${formatted} credits` : "Баланс KIE временно недоступен";

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => void refresh()}
        title={title}
        aria-label={title}
        className="mb-1 flex w-full justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <Coins className={cn("h-4 w-4", !available && "opacity-45")} />
      </button>
    );
  }

  return (
    <div className="mb-2 rounded-xl border border-border bg-surface-elevated/55 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
            <Coins className="h-3.5 w-3.5" />
            KIE баланс
          </p>
          <p className={cn("mt-1 text-sm font-semibold tabular-nums", available ? "text-foreground" : "text-muted-foreground")}>
            {loading ? "Проверяем…" : available ? `${formatted} credits` : "Недоступен"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          aria-label="Обновить баланс KIE"
          title="Обновить баланс KIE"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
    </div>
  );
}

export function Sidebar({ recentProjects = [] }: SidebarProps) {
  const { sidebarCollapsed, setSidebarCollapsed, mobileSidebarOpen, setMobileSidebarOpen } = useTheme();
  const { recentChats } = useRecentChats();
  const closeMobile = () => setMobileSidebarOpen(false);

  const sidebarContent = (
    <>
      <div className={cn("flex items-center border-b border-border px-4 py-4", sidebarCollapsed ? "justify-center" : "justify-between")}>
        {!sidebarCollapsed && (
          <Link href="/dashboard" className="text-base font-bold text-accent">
            {t("appName")}
          </Link>
        )}
        <button
          type="button"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="hidden rounded-lg p-1.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground md:block"
          aria-label={sidebarCollapsed ? "Развернуть sidebar" : "Свернуть sidebar"}
        >
          {sidebarCollapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={closeMobile}
          className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground md:hidden"
          aria-label="Закрыть меню"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-3">
        <Link
          href="/chat"
          onClick={closeMobile}
          className={cn(
            "flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-black shadow-sm transition-colors hover:bg-accent-hover",
            sidebarCollapsed && "justify-center px-2",
          )}
        >
          <Plus className="h-4 w-4 shrink-0" />
          {!sidebarCollapsed && t("nav.newChat")}
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3" aria-label="Основная навигация">
        {mainNavItems.map((item) => (
          <NavLink key={item.href} {...item} collapsed={sidebarCollapsed} onClick={closeMobile} />
        ))}

        {!sidebarCollapsed && recentChats.length > 0 && (
          <div className="mt-4">
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {t("nav.recentChats")}
            </p>
            {recentChats.slice(0, 5).map((chat) => (
              <div key={chat.id} className="group relative flex items-center">
                <Link
                  href={`/chat/${chat.id}`}
                  onClick={closeMobile}
                  className="block flex-1 truncate rounded-lg px-3 py-1.5 pr-8 text-xs text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                >
                  {chat.title}
                </Link>
                <div className="absolute right-1 top-1/2 -translate-y-1/2">
                  <ChatActionsMenu chatId={chat.id} title={chat.title} variant="sidebar" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!sidebarCollapsed && recentProjects.length > 0 && (
          <div className="mt-4">
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {t("nav.recentProjects")}
            </p>
            {recentProjects.slice(0, 5).map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                onClick={closeMobile}
                className="block truncate rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              >
                {project.name}
              </Link>
            ))}
          </div>
        )}
      </nav>

      <div className="border-t border-border p-3">
        <KieCreditsBadge collapsed={sidebarCollapsed} />
        <form action="/api/auth/logout" method="POST">
          <button
            type="submit"
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground",
              sidebarCollapsed && "justify-center px-2",
            )}
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden />
            {!sidebarCollapsed && t("nav.logout")}
          </button>
        </form>
      </div>
    </>
  );

  return (
    <>
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-border bg-surface/90 backdrop-blur-md transition-all duration-200 md:flex",
          sidebarCollapsed ? "w-[var(--sidebar-collapsed-width)]" : "w-[var(--sidebar-width)]",
        )}
      >
        {sidebarContent}
      </aside>

      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={closeMobile}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 flex h-full w-72 flex-col bg-surface shadow-lg">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}

const mobileNavItems = mainNavItems.slice(0, 5);

export function MobileNav() {
  const pathname = usePathname();
  const { setMobileSidebarOpen } = useTheme();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-border bg-surface/95 backdrop-blur md:hidden"
      aria-label="Мобильная навигация"
    >
      {mobileNavItems.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] transition-colors",
              active ? "text-accent" : "text-muted",
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
            <span className="truncate max-w-[60px]">{label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={() => setMobileSidebarOpen(true)}
        className="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] text-muted"
        aria-label="Ещё"
      >
        <PanelLeft className="h-5 w-5" />
        <span>Ещё</span>
      </button>
    </nav>
  );
}
