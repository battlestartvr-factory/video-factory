import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-lg bg-zinc-800/80", className)}
      aria-hidden
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-zinc-900/30 px-6 py-16 text-center">
      <h3 className="text-lg font-medium text-zinc-200">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm text-zinc-500">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
      role="alert"
    >
      {message}
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-200">
      Demo mode — mock-воркфлоу активен
    </div>
  );
}
