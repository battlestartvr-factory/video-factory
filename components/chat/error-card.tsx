"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ErrorCardData } from "@/lib/types/workspace";

interface ErrorCardProps {
  error: ErrorCardData;
  onRetry?: () => void;
}

export function ErrorCard({ error, onRetry }: ErrorCardProps) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div className="flex-1">
          {error.code && (
            <p className="text-xs font-medium text-red-400">{error.code}</p>
          )}
          <p className="mt-1 text-sm text-red-200">{error.message}</p>
          {error.retryable && onRetry && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" />
              Повторить
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
