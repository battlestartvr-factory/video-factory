import { cn } from "@/lib/utils";
import type { JobStatus } from "@/lib/types/database";

const statusStyles: Record<JobStatus, string> = {
  draft: "bg-zinc-700/50 text-zinc-300 border-zinc-600",
  queued: "bg-zinc-700/50 text-zinc-300 border-zinc-600",
  processing: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  review: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-red-500/15 text-red-300 border-red-500/30",
  cancelled: "bg-zinc-700/50 text-zinc-400 border-zinc-600",
};

export function Badge({
  status,
  label,
  className,
}: {
  status?: JobStatus;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        status ? statusStyles[status] : "bg-zinc-800 text-zinc-300 border-zinc-700",
        className,
      )}
    >
      {label}
    </span>
  );
}
