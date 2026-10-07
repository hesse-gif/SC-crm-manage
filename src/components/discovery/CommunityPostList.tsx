"use client";

import { useMemo } from "react";
import type { CommunityPost } from "@/lib/data";
import { CommunityPostCard, sortTime } from "./CommunityPostCard";

const DEFAULT_SUMMARY_LIMIT = 8;

function isVisibleCommunityPost(post: CommunityPost): boolean {
  return !post.deletedAt && !post.archivedAt;
}

export function CommunityPostList({
  posts,
  variant,
  limit = DEFAULT_SUMMARY_LIMIT,
}: {
  posts: CommunityPost[];
  variant: "summary" | "deep-dive";
  limit?: number;
}) {
  const sortedPosts = useMemo(
    () =>
      posts
        .filter(isVisibleCommunityPost)
        .sort((left, right) => sortTime(right) - sortTime(left) || left.id.localeCompare(right.id)),
    [posts],
  );
  const visiblePosts = variant === "summary" ? sortedPosts.slice(0, limit) : sortedPosts;
  const showActions = variant === "deep-dive";

  if (visiblePosts.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-paper py-16 text-center text-sm font-medium text-ink-3">
        아직 표시할 커뮤니티 반응이 없습니다
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {visiblePosts.map((post) => (
        <CommunityPostCard key={post.id} post={post} showActions={showActions} />
      ))}
    </div>
  );
}
