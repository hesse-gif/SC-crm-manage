"use client";

import type { ReactNode } from "react";
import { FeedbackControl, type FeedbackControlProps } from "./FeedbackControl";
import { cn } from "@/lib/cn";

// 임의의 AI 산출물 블록을 감싸 hover 시 우상단에 피드백 컨트롤(👍/👎)을 노출.
// "모든 구역에 마우스오버하면 피드백" 메커니즘 (청사진 docs/FEEDBACK.md).
export type FeedbackHoverProps = FeedbackControlProps & {
  children: ReactNode;
  className?: string;
};

export function FeedbackHover({
  children,
  className,
  ...feedbackProps
}: FeedbackHoverProps) {
  return (
    <div className={cn("group/fb relative", className)}>
      {children}
      <div className="absolute right-1.5 top-1.5 z-20 opacity-0 transition-opacity duration-150 group-hover/fb:opacity-100">
        <div className="rounded-md border border-line bg-paper/95 px-2 py-1 shadow-pop backdrop-blur">
          <FeedbackControl {...feedbackProps} />
        </div>
      </div>
    </div>
  );
}
