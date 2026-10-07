import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/cn";

// haru-ui: 보더보다 배경/그림자로 영역 구분. 카드는 꼭 분리가 필요할 때만.
// data-testid 등 임의 DOM 속성이 그대로 통과되도록 나머지 section props를 spread한다 —
// 이전에는 className/children만 받아 data-testid 같은 값이 타입체크는 통과하지만(TS는
// data-*/aria-*를 초과 프로퍼티 검사에서 예외 처리) 실제 DOM에는 렌더되지 않는 문제가 있었다.
type CardProps = { className?: string; children: ReactNode } & Omit<
  ComponentPropsWithoutRef<"section">,
  "className" | "children"
>;

export function Card({ className, children, ...rest }: CardProps) {
  return (
    <section className={cn("overflow-hidden rounded-lg border border-line bg-paper", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <h3 className="text-[15px] font-bold text-ink">{title}</h3>
        {desc && <p className="mt-0.5 text-xs text-ink-3">{desc}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
