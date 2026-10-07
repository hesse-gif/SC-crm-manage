import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  key: string;
  label: ReactNode;
  // string form (e.g. "37+") lets a caller whose count comes from a bounded/partial scan label it
  // honestly instead of presenting a lower bound as an exact number (Flu conversation org-filter
  // round 3 — src/components/flu/chat/UnrepliedInboxPanel.tsx useUnrepliedInboxCount).
  count?: number | string;
}

// 컨트롤드 pill 탭 (Substack 톤). 상태는 부모(클라이언트)에서 관리.
export function Tabs({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: TabItem[];
  value: string;
  onChange?: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-full bg-fill p-1", className)}>
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(t.key)}
            className={cn(
              "inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium transition-colors",
              active ? "bg-paper text-ink shadow-card" : "text-ink-2 hover:text-ink",
            )}
          >
            {t.label}
            {t.count != null && (
              <span className={cn("ml-1.5", active ? "text-ink-3" : "text-ink-4")}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
