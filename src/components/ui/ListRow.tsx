import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

type Padding = "s" | "m" | "l" | "xl";
const padMap: Record<Padding, string> = {
  s: "py-2.5",
  m: "py-3.5",
  l: "py-4",
  xl: "py-6",
};

// haru-ui의 핵심 컨테이너. 카드보다 ListRow 반복을 우선.
export function ListRow({
  left,
  title,
  subtitle,
  meta,
  right,
  padding = "m",
  onClick,
  href,
  className,
  metaInteractive = true,
}: {
  left?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  padding?: Padding;
  onClick?: () => void;
  href?: string;
  className?: string;
  /**
   * W100: meta 가 순수 표시(배지 등)뿐이면 false — 기본 z-10 스택이 href 오버레이 위에 있어
   * 배지 좌표 클릭이 죽은 영역이 된다(실브라우저 재현). 메뉴 등 진짜 컨트롤이 있으면 기본값(true).
   */
  metaInteractive?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-3 border-b border-line px-4 last:border-0",
        (onClick || href) && "cursor-pointer transition-colors hover:bg-surface",
        padMap[padding],
        className,
      )}
    >
      {href ? <Link href={href} className="absolute inset-0 z-0 rounded-inherit" aria-label={typeof title === "string" ? title : "상세 열기"} /> : null}
      {left && <div className="shrink-0">{left}</div>}
      <div className="pointer-events-none min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-xs text-ink-3">{subtitle}</div>}
      </div>
      {meta && (
        <div className={cn("shrink-0 text-right text-xs text-ink-2", metaInteractive ? "relative z-10" : "pointer-events-none")}>
          {meta}
        </div>
      )}
      {right && <div className="relative z-10 shrink-0">{right}</div>}
    </div>
  );
}
