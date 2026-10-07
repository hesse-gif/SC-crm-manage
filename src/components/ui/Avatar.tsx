"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

function firstGrapheme(value: string): string {
  return Array.from(value.trim())[0] ?? "";
}

export function avatarFallbackLabel(label: string): string {
  const safeLabel = label.trim().replace(/^@+/, "");
  if (!safeLabel) return "?";
  const words = safeLabel.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const initials = words.slice(0, 2).map(firstGrapheme).join("").toUpperCase();
    return initials || "?";
  }
  const graphemes = Array.from(safeLabel);
  return graphemes.slice(0, 2).join("") || "?";
}

// label이 http(s) URL이면 실제 썸네일 이미지를, 아니면 이모지/이니셜을 렌더.
// (Infly 실제 채널 썸네일을 녹일 때 데이터만 URL로 바꾸면 소비처 변경 불필요.)
export function Avatar({
  label,
  fallback,
  size = 40,
  className,
}: {
  label: unknown;
  // label이 이미지 URL이면 그 문자열로는 이니셜을 만들 수 없다. 이미지가 없거나 로드에 실패했을 때
  // 쓸 표시용 문자열(예: 서버가 계산한 profileImage.fallbackInitials)을 여기로 받는다.
  fallback?: unknown;
  size?: number;
  className?: string;
}) {
  const safeLabel = typeof label === "string" && label.trim() ? label.trim() : "?";
  const safeFallback = typeof fallback === "string" && fallback.trim() ? fallback.trim() : "";
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [safeLabel]);

  const isImageUrl = /^(https?:\/\/|\/)/.test(safeLabel);

  if (isImageUrl && !imageFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={safeLabel}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setImageFailed(true)}
        className={cn("shrink-0 rounded-full bg-fill object-cover outline outline-1 -outline-offset-1 outline-black/10", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  // 이미지 URL은 이니셜 재료가 아니므로 fallback을 먼저 본다 — 로드 실패(onError) 시에도 리터럴
  // "?" 대신 이니셜이 남는다. 재료가 정말 아무것도 없을 때만 "?".
  const fallbackSource = safeFallback || (isImageUrl ? "" : safeLabel);
  const fallbackLabel = fallbackSource ? avatarFallbackLabel(fallbackSource) : "?";
  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-fill text-center leading-none text-ink-2",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}
      title={fallbackSource && fallbackSource !== fallbackLabel ? fallbackSource : undefined}
    >
      {fallbackLabel}
    </span>
  );
}
