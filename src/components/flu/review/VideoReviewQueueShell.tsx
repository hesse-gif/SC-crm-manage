import type { ReactNode } from "react";

export function VideoReviewQueueShell({
  queue,
  summary,
  modal,
}: {
  queue: ReactNode;
  summary: ReactNode;
  modal?: ReactNode;
}) {
  return (
    <div data-testid="video-review-queue-section" className="grid gap-5 xl:grid-cols-[minmax(330px,410px)_1fr]">
      <div className="xl:sticky xl:top-6 xl:max-h-[calc(100vh-96px)] xl:overflow-y-auto xl:pr-1">
        {queue}
      </div>
      <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-6 xl:max-h-[calc(100vh-96px)] xl:overflow-y-auto xl:pr-1">
        {summary}
      </div>
      {modal}
    </div>
  );
}
