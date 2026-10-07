"use client";

import { useState } from "react";
import { DOWN_REASONS, submitFeedback, type FeedbackCallablePayload } from "@/lib/data";
import { requestDataRefresh } from "@/lib/live";
import { ThumbUp, ThumbDown } from "@/components/icons";
import { cn } from "@/lib/cn";

type CampaignFeedbackScopeProps = {
  programId: string;
  campaignId: string;
  locale: string;
  globalScope?: never;
};

type GlobalFeedbackScopeProps = {
  globalScope: "global";
  locale: string;
  programId?: never;
  campaignId?: never;
};

export type FeedbackControlProps = {
  model?: string;
  target: FeedbackCallablePayload["target"];
  pipelineDomain: NonNullable<FeedbackCallablePayload["pipelineDomain"]>;
  artifactRef: string;
  excerpt: string;
  gameId?: string;
} & (CampaignFeedbackScopeProps | GlobalFeedbackScopeProps);

type FeedbackSaveState = "idle" | "saving" | "stored" | "error";

async function feedbackRevision(value: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
  }
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "") ?? `${Date.now()}-${Math.random()}`.replace(/[^0-9]/g, "");
}

async function stableFeedbackRef(
  target: FeedbackCallablePayload["target"],
  artifactRef: string,
  rating: "up" | "down",
  revisionInput: string,
) {
  const revision = await feedbackRevision(revisionInput);
  const baseLeaf = `${target}-${rating}-${artifactRef}`
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_.~-]+/gi, "-")
    .replace(/-+/g, "-")
    .slice(0, 72);
  const leaf = `${baseLeaf}-${revision}`;
  return `feedback/${leaf || `${target}-${rating}`}`;
}

export function FeedbackControl({
  model,
  target,
  pipelineDomain,
  artifactRef,
  excerpt,
  gameId = "flu-casual",
  programId,
  campaignId,
  locale,
  globalScope,
}: FeedbackControlProps) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [customReason, setCustomReason] = useState("");
  const [saveState, setSaveState] = useState<FeedbackSaveState>("idle");
  const [error, setError] = useState("");

  async function persistFeedback(nextRating: "up" | "down", nextReason?: string, note?: string) {
    setRating(nextRating);
    setReason(nextReason ?? null);
    setSaveState("saving");
    setError("");
    try {
      const scopeIdentity = globalScope === "global"
        ? ["global", locale]
        : ["campaign", programId, campaignId, locale];
      const feedbackRef = await stableFeedbackRef(
        target,
        artifactRef,
        nextRating,
        JSON.stringify([scopeIdentity, pipelineDomain, excerpt, nextReason ?? null, note?.trim() || null]),
      );
      await submitFeedback({
        target,
        pipelineDomain,
        rating: nextRating,
        reason: nextRating === "down" ? nextReason ?? "기타" : undefined,
        note: note?.trim() || undefined,
        excerpt,
        model,
        artifactRef,
        feedbackRef,
        ...(globalScope === "global" ? { globalScope } : { programId, campaignId }),
        locale,
        gameId,
      });
      setSaveState("stored");
      requestDataRefresh();
    } catch (e) {
      setSaveState("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleReasonClick(nextReason: string) {
    setReason(nextReason);
    setError("");
    if (nextReason === "기타") {
      setSaveState("idle");
      return;
    }
    void persistFeedback("down", nextReason);
  }

  const canSubmitCustomReason = customReason.trim().length > 0;

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-ink-4">AI 응답 평가</span>
        <button
          type="button"
          onClick={() => {
            void persistFeedback("up");
            setReason(null);
            setCustomReason("");
          }}
          title="따봉"
          className={cn(
            "grid h-6 w-6 place-items-center rounded-md transition-colors",
            rating === "up" ? "bg-ok-soft text-ok" : "text-ink-4 hover:bg-fill hover:text-ink-2",
          )}
        >
          <ThumbUp className="h-[14px] w-[14px]" />
        </button>
        <button
          type="button"
          onClick={() => {
            setRating("down");
            setSaveState("idle");
            setError("");
          }}
          title="비추"
          className={cn(
            "grid h-6 w-6 place-items-center rounded-md transition-colors",
            rating === "down" ? "bg-danger-soft text-danger" : "text-ink-4 hover:bg-fill hover:text-ink-2",
          )}
        >
          <ThumbDown className="h-[14px] w-[14px]" />
        </button>
        {saveState === "saving" && <span className="text-[10px] font-medium text-ink-3">저장 중</span>}
        {rating === "up" && saveState === "stored" && <span className="text-[10px] font-medium text-warn">기록됨 · 검토 대기</span>}
      </div>

      {rating === "down" && (
        <div className="mt-1.5 rounded-md border border-line bg-paper p-2">
          <div className="mb-1 text-[10px] font-semibold text-ink-3">왜 별로인가요? (저장 후 사람 검토)</div>
          <div className="flex flex-wrap gap-1">
            {DOWN_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => handleReasonClick(r)}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                  reason === r ? "bg-danger-soft font-semibold text-danger" : "bg-fill text-ink-2 hover:bg-fill-2",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          {reason === "기타" && (
            <div className="mt-2 flex items-start gap-1.5">
              <textarea
                value={customReason}
                onChange={(event) => setCustomReason(event.target.value)}
                placeholder="무엇이 별로였는지 자연어로 적어주세요"
                className="min-h-[56px] flex-1 resize-none rounded-md border border-line bg-paper px-2.5 py-2 text-[12px] leading-relaxed text-ink outline-none focus:border-accent"
              />
              <button
                type="button"
                disabled={!canSubmitCustomReason || saveState === "saving"}
                onClick={() => void persistFeedback("down", "기타", customReason)}
                className={cn(
                  "rounded-md px-2.5 py-2 text-[11px] font-semibold transition-colors",
                  canSubmitCustomReason && saveState !== "saving"
                    ? "bg-danger-soft text-danger hover:bg-danger-soft/80"
                    : "bg-fill text-ink-4",
                )}
              >
                저장
              </button>
            </div>
          )}
          {reason && saveState === "stored" && (
            <div className="mt-1.5 text-[10px] text-ink-4">
              ‘{reason}’ 기록됨 → 검토 전까지 AI 생성에는 반영되지 않음
            </div>
          )}
          {saveState === "error" && (
            <div className="mt-1.5 text-[10px] font-medium text-danger">
              저장 실패: {error || "다시 시도해주세요."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
