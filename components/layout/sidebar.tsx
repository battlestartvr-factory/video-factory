"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  ImageIcon,
  Settings,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n/dictionary";

const navItems = [
  { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
  { href: "/projects", label: t("nav.projects"), icon: FolderKanban },
  { href: "/assets", label: t("nav.assets"), icon: ImageIcon },
  { href: "/settings", label: t("nav.settings"), icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 border-r border-zinc-800 bg-zinc-950/80 md:flex md:flex-col">
      <div className="border-b border-zinc-800 px-6 py-5">
        <Link href="/dashboard" className="text-lg font-bold text-amber-400">
          {t("appName")}
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-4" aria-label="Основная навигация">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-zinc-800 text-amber-300"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-zinc-800 p-4">
        <form action="/api/auth/logout" method="POST">
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {t("nav.logout")}
          </button>
        </form>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-zinc-800 bg-zinc-950/95 backdrop-blur md:hidden"
      aria-label="Мобильная навигация"
    >
      {navItems.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 py-3 text-[10px]",
              active ? "text-amber-400" : "text-zinc-500",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="h-5 w-5" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
