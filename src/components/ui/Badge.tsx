import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "info" | "accent" | "warn" | "ai" | "ok" | "danger";

const toneMap: Record<Tone, string> = {
  neutral: "bg-fill text-ink-2",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
  ai: "bg-ai-soft text-ai",
  ok: "bg-ok-soft text-ok",
  danger: "bg-danger-soft text-danger",
};

export function Badge({
  tone = "neutral",
  dot = false,
  children,
  className,
  title,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
  // 후보 탭 Aside 적대 리뷰(2026-09-27): 호출부가 배지를 감싸는 별도 <span title="…">로 툴팁을
  // 달면, 텍스트 노드를 직접 찾는 접근성/자동화 쿼리(getByText 등)는 안쪽 배지 자신에서 title이
  // null로 보인다 — 실제 브라우저 hover는 조상 title로도 동작하지만, 배지 자신이 title을 직접
  // 받도록 옵션을 열어 그 경우를 없앤다. 기존 호출부(값을 안 주면 undefined)는 그대로 동작한다.
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap",
        toneMap[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}
