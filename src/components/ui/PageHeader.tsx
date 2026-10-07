import type { ReactNode } from "react";

// haru-ui Top: 화면의 정체성. 큰 타이틀 + 부제 한 줄 + (선택)단일 액션.
export function PageHeader({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-20 -mx-4 mb-4 flex items-end justify-between gap-3 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="min-w-0">
        <h1 className="text-xl font-black tracking-[-0.03em] text-ink sm:text-2xl">{title}</h1>
        {desc && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-2 sm:text-sm">{desc}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
