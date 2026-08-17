"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n/dictionary";

const settingsNav = [
  { href: "/settings", label: t("settings.general") },
  { href: "/settings/appearance", label: t("settings.appearance") },
  { href: "/settings/agent", label: t("settings.agent") },
  { href: "/settings/memory", label: t("settings.memory") },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap gap-1 border-b border-border pb-4 md:flex-col md:border-b-0 md:pb-0 md:pr-6 md:border-r">
      {settingsNav.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-accent-muted text-accent font-medium"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col p-4 md:flex-row md:p-8">
      <div className="mb-4 md:mb-0 md:w-48 md:shrink-0">
        <SettingsNav />
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
