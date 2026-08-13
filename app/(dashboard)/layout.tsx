import { Sidebar, MobileNav } from "@/components/layout/sidebar";
import { DemoBanner } from "@/components/ui/states";
import { isMockWorkflowsEnabled } from "@/lib/env/mock-workflows";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="gradient-bg flex min-h-dvh flex-col">
      {isMockWorkflowsEnabled() && <DemoBanner />}
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-h-dvh flex-1 flex-col pb-20 md:pb-0">
          <main className="flex-1 p-4 md:p-8">{children}</main>
        </div>
      </div>
      <MobileNav />
    </div>
  );
}
