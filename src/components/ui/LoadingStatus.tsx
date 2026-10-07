"use client";

import type { ReactNode } from "react";
import { Refresh } from "@/components/icons";
import { cn } from "@/lib/cn";

export function LoadingStatus({
  children,
  className,
  compact = false,
}: {
  children: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "flex items-center gap-2 text-xs font-medium text-ink-3",
        compact ? "py-1" : "py-3",
        className,
      )}
    >
      <Refresh className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
