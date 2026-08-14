"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n/dictionary";
import { useTheme } from "@/components/providers/theme-provider";
import type { Chat } from "@/lib/types/workspace";
import type { Project } from "@/lib/types/database";

const mainNavItems = [
  { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
  { href: "/chat", label: t("nav.chat"), icon: MessageSquare },
  { href: "/images", label: t("nav.images"), icon: ImageIcon },
  { href: "/video", label: t("nav.video"), icon: Video },
  { href: "/projects", label: t("nav.projects"), icon: FolderKanban },
  { href: "/knowledge", label: t("nav.knowledge"), icon: BookOpen },
  { href: "/results", label: t("nav.results"), icon: Layers },
  { href: "/settings", label: t("nav.settings"), icon: Settings },
];

interface SidebarProps {
  recentProjects?: Pick<Project, "id" | "name">[];
  recentChats?: Pick<Chat, "id" | "title">[];
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

export function Sidebar({ recentProjects = [], recentChats = [] }: SidebarProps) {
  const { sidebarCollapsed, setSidebarCollapsed, mobileSidebarOpen, setMobileSidebarOpen } = useTheme();
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
              <Link
                key={chat.id}
                href={`/chat/${chat.id}`}
                onClick={closeMobile}
                className="block truncate rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              >
                {chat.title}
              </Link>
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
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-border bg-surface/90 backdrop-blur-md transition-all duration-200 md:flex",
          sidebarCollapsed ? "w-[var(--sidebar-collapsed-width)]" : "w-[var(--sidebar-width)]",
        )}
      >
        {sidebarContent}
      </aside>

      {/* Mobile drawer overlay */}
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
