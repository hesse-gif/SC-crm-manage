"use client";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { FeedbackHover } from "@/components/ui/FeedbackHover";
import { WorkflowActionMenu } from "@/components/ui/WorkflowActionMenu";
import { SENTIMENT, type CommunityPost, type Sentiment } from "@/lib/data";

export function normalizeSentiment(value: unknown): Sentiment {
  return value === "positive" || value === "negative" || value === "neutral" ? value : "neutral";
}

export function sortTime(post: CommunityPost): number {
  const value = post.createdAtIso ?? post.time;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function displayTime(post: CommunityPost): string {
  const value = post.createdAtIso ?? post.time;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return post.time;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(parsed));
}

// 외부 원문 주소만 링크로 만든다. http(s) 가 아니면(javascript:, data: 등) 링크를 만들지 않는다.
export function communitySourceHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function CommunityPostCard({
  post,
  showActions = false,
}: {
  post: CommunityPost;
  showActions?: boolean;
}) {
  const { label, tone } = SENTIMENT[normalizeSentiment(post.sentiment)];
  const sourceHref = communitySourceHref(post.sourceUrl);
  return (
    <FeedbackHover
      target="priority"
      pipelineDomain="priority"
      artifactRef={`community_posts/${post.id}`}
      excerpt={post.title}
      globalScope="global"
      locale="und"
    >
      <Card className="transition-colors hover:border-ink-4">
        <div className="px-5 py-3.5">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-ink-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{post.subreddit}</span>
              <span>·</span>
              <span>{displayTime(post)}</span>
            </div>
            {showActions ? (
              <WorkflowActionMenu entity="communityPost" id={post.id} label={post.title} compact />
            ) : null}
          </div>

          {/* sourceUrl 이 있는데 카드가 아무 데도 가지 않으면 운영자는 원문을 확인할 방법이 없다.
              제목 자체를 원문 링크로 만든다. 주소가 없으면 링크를 만들지 않는다. */}
          {sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="community-post-source-link"
              onClick={(event) => event.stopPropagation()}
              className="mb-2.5 block text-sm font-semibold leading-snug text-ink underline-offset-2 hover:text-accent hover:underline"
            >
              {post.title}
            </a>
          ) : (
            <p className="mb-2.5 text-sm font-semibold leading-snug text-ink">{post.title}</p>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <Badge tone={tone}>{label}</Badge>
            <Badge tone="neutral">{post.source}</Badge>
            <span className="font-medium text-ink-2">▲ {post.score}</span>
            <span>댓글 {post.comments}</span>
            <Badge tone="neutral">{post.game}</Badge>
            {sourceHref ? (
              <a
                href={sourceHref}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="community-post-source-action"
                onClick={(event) => event.stopPropagation()}
                className="font-semibold text-accent underline-offset-2 hover:underline"
              >
                원문 열기
              </a>
            ) : (
              <span className="text-ink-4">원문 링크 없음</span>
            )}
          </div>
        </div>
      </Card>
    </FeedbackHover>
  );
}
