"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { Card, CardHeader } from "@/components/ui/Card";
import { ThumbUp, ThumbDown } from "@/components/icons";
import {
  FEEDBACK,
  getFeedbackKbGovernanceStatus,
  indexFeedbackKb,
  listKbReviewQueue,
  queueFineTuneExample,
  resolveKbReview,
  type Feedback,
  type FeedbackGovernanceScope,
  type FeedbackKbGovernanceStatusEnvelope,
  type KbReviewQueueItem,
} from "@/lib/data";
import { requestDataRefresh, useLive, useLiveFeedback, useLiveKnowledgeEdges, useLiveKnowledgeNodes } from "@/lib/live";
import { fineTuneStatusLabel } from "@/lib/statusLabels";

type KnowledgeSourceRef = {
  ref?: string;
  type?: string;
  summary?: string;
};

type KnowledgeNode = {
  id: string;
  type?: string;
  title?: string;
  summary?: string;
  sourceRefs?: KnowledgeSourceRef[];
  entityRefs?: string[];
  createdAtIso?: string;
};

type KnowledgeEdge = {
  id: string;
  type?: string;
  from?: string;
  to?: string;
  createdAtIso?: string;
};

type GovernedFeedback = Omit<Feedback, "promotionStatus" | "retrievalStatus"> & {
  promotionStatus?: "not_promoted" | "promoted" | "revoked";
  retrievalStatus?: "excluded_unreviewed" | "active" | "excluded_rejected" | "excluded_eval_failed";
  reviewedExampleRef?: string;
  evalDatasetItemRef?: string;
  evalResultRef?: string;
  reviewRef?: string;
  latestReviewEventRef?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  promotedAt?: string;
};

function redactForDisplay(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[redacted-phone]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(api[_-]?key|client[_-]?secret|secret|token|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted-secret]")
    .replace(/\s+/g, " ")
    .trim();
}

// Casebook hard-rule case ids (functions/chatCasebook.ts) — informational only here.
// This screen never gates auto-send; it just nudges a reviewer toward rejecting an
// implicit-manual-reply candidate whose paired inbound was classified as one of these
// (e.g. a reply containing a negotiated price for a fixed_terms_inquiry).
const CASEBOOK_HARD_RULE_IDS = new Set([
  "fixed_terms_inquiry",
  "call_request",
  "contact_channel_request",
  "settlement_dispute",
  "out_of_scope_request",
  "opt_out_or_legal",
]);

const IMPLICIT_MANUAL_REPLY_REJECT_PRESETS = [
  "casebook 하드룰 위반 (예: 협상된 단가 노출)",
  "개인정보·민감정보 포함",
  "발신자 오판 · 실제로는 정형 답변이 아님",
  "품질이 낮음 (톤·정확도)",
];

function exactScopePayload(scope: FeedbackGovernanceScope | undefined) {
  if (scope?.kind === "campaign" && scope.programId && scope.campaignId && scope.locale) {
    return { programId: scope.programId, campaignId: scope.campaignId, locale: scope.locale };
  }
  if (scope?.kind === "global" && scope.locale) {
    return { globalScope: "global" as const, locale: scope.locale };
  }
  return null;
}

function sortByCreatedAt<T extends { createdAtIso?: string; time?: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const rightTime = right.createdAtIso ?? right.time ?? "";
    const leftTime = left.createdAtIso ?? left.time ?? "";
    return rightTime.localeCompare(leftTime);
  });
}

function feedbackGovernance(feedback: GovernedFeedback): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (feedback.reviewStatus === "rejected" || feedback.status === "rejected" || feedback.promotionStatus === "revoked") {
    return { label: "검토 거절 · 생성 제외", tone: "danger" };
  }
  if (feedback.evalStatus === "failed" || feedback.status === "eval_failed") {
    return { label: "무결성 검사 실패 · 생성 제외", tone: "danger" };
  }
  if (
    feedback.reviewStatus === "approved"
    && feedback.evalStatus === "passed"
    && feedback.promotionStatus === "promoted"
    && feedback.retrievalStatus === "active"
  ) {
    return { label: "승인·무결성 검사 통과 · 생성 반영", tone: "ok" };
  }
  if (feedback.reviewStatus === "pending" || feedback.status === "review_pending") {
    return { label: "검토 대기 · 생성 미반영", tone: "warn" };
  }
  return { label: "이전 데이터 · 생성 미반영", tone: "neutral" };
}

export default function KnowledgePage() {
  const live = useLive();
  const feedback = useLiveFeedback<GovernedFeedback>(FEEDBACK);
  const knowledgeNodes = useLiveKnowledgeNodes<KnowledgeNode>([]);
  const knowledgeEdges = useLiveKnowledgeEdges<KnowledgeEdge>([]);
  const recentFeedback = sortByCreatedAt(feedback);
  const recentKnowledgeNodes = sortByCreatedAt(knowledgeNodes).slice(0, 20);

  const feedbackLoaded = live.perKeyLoaded("feedback");
  const feedbackLoadError = live.perKeyError("feedback");
  const feedbackLoading = Boolean(live.loadingKeys.feedback) || (!feedbackLoaded && !feedbackLoadError);
  const feedbackPageInfo = live.data?.pageInfo?.feedback;
  const upCount = feedback.filter((f) => f.rating === "up").length;
  const downCount = feedback.filter((f) => f.rating === "down").length;
  const feedbackKbCount = knowledgeNodes.filter((node) => node.type === "feedback_kb").length;
  // P9/S10 교차(A12): knowledgeNodes.length는 페이지 캡(최대 100)일 뿐 실제 총계가 아니다 —
  // read.ts가 audit 컬렉션과 동일하게 count() 보정한 counts.knowledgeNodes를 쓴다.
  // 아직 로드 전이면(집계 미도착) 화면에 보이는 배열 길이로 폴백.
  const knowledgeNodesTotal = live.data?.counts?.knowledgeNodes ?? knowledgeNodes.length;

  const [kbReviewItems, setKbReviewItems] = useState<KbReviewQueueItem[]>([]);
  const [kbReviewTotal, setKbReviewTotal] = useState(0);
  const [kbReviewNextCursor, setKbReviewNextCursor] = useState<string | null>(null);
  const [kbReviewLoading, setKbReviewLoading] = useState(true);
  const [kbReviewError, setKbReviewError] = useState<string | null>(null);
  const [kbReviewBusyKey, setKbReviewBusyKey] = useState<string | null>(null);
  const [feedbackReviewBusyKey, setFeedbackReviewBusyKey] = useState<string | null>(null);
  const [feedbackReviewError, setFeedbackReviewError] = useState<string | null>(null);
  const [correctionNotes, setCorrectionNotes] = useState<Record<string, string>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [implicitReplyOnly, setImplicitReplyOnly] = useState(false);
  const [fineTuneBusyKey, setFineTuneBusyKey] = useState<string | null>(null);
  const [governanceStatus, setGovernanceStatus] = useState<FeedbackKbGovernanceStatusEnvelope | null>(null);
  const [governanceLoading, setGovernanceLoading] = useState(true);
  const [governanceError, setGovernanceError] = useState<string | null>(null);

  const implicitManualReplyCount = recentFeedback.filter((fb) => fb.source === "implicit_manual_reply").length;
  const visibleFeedback = implicitReplyOnly
    ? recentFeedback.filter((fb) => fb.source === "implicit_manual_reply")
    : recentFeedback;

  const totalCount = governanceStatus?.counts.feedback.total;
  const reviewPendingCount = governanceStatus?.counts.feedback.pending;
  const promotedCount = governanceStatus?.counts.knowledge.activeEntries;

  const loadKbReviewQueue = useCallback(async (cursor?: string, append = false) => {
    setKbReviewLoading(true);
    setKbReviewError(null);
    try {
      const res = await listKbReviewQueue({ limit: 50, ...(cursor ? { cursor } : {}) });
      setKbReviewItems((current) => append ? [...current, ...(res.items ?? [])] : res.items ?? []);
      setKbReviewTotal(res.total ?? 0);
      setKbReviewNextCursor(res.pageInfo?.nextCursor ?? null);
    } catch (e) {
      setKbReviewError(e instanceof Error ? e.message : "충돌 검수 큐 조회 실패");
    } finally {
      setKbReviewLoading(false);
    }
  }, []);

  const loadGovernanceStatus = useCallback(async () => {
    setGovernanceLoading(true);
    setGovernanceError(null);
    try {
      setGovernanceStatus(await getFeedbackKbGovernanceStatus());
    } catch (error) {
      setGovernanceStatus(null);
      setGovernanceError(error instanceof Error ? error.message : "지식 거버넌스 상태 조회 실패");
    } finally {
      setGovernanceLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKbReviewQueue();
    void loadGovernanceStatus();
  }, [loadGovernanceStatus, loadKbReviewQueue]);

  const handleResolveKbReview = async (item: KbReviewQueueItem, decision: "accept" | "keep") => {
    const busyKey = `${item.id}:${decision}`;
    setKbReviewBusyKey(busyKey);
    setKbReviewError(null);
    try {
      await resolveKbReview({
        reviewId: item.id,
        decision,
        expectedRevision: item.revision,
        transitionId: crypto.randomUUID(),
      });
      await loadKbReviewQueue();
      await loadGovernanceStatus();
    } catch (e) {
      setKbReviewError(e instanceof Error ? e.message : "충돌 처리 실패");
    } finally {
      setKbReviewBusyKey(null);
    }
  };

  const handleFeedbackReview = async (item: GovernedFeedback, decision: "approve" | "reject") => {
    if (!item.feedbackRef?.startsWith("feedback/")) return;
    const scopePayload = exactScopePayload(item.scope);
    if (!scopePayload) {
      setFeedbackReviewError("레거시 무범위 피드백은 안전상 검토할 수 없습니다.");
      return;
    }
    const correctionNote = correctionNotes[item.id]?.trim() ?? "";
    if (decision === "approve" && item.rating === "down" && correctionNote.length < 4) {
      setFeedbackReviewError("수정 필요 피드백을 승인하려면 올바른 가이드 문구를 4자 이상 입력해야 합니다.");
      return;
    }
    const rejectReason = rejectReasons[item.id]?.trim() ?? "";
    const isImplicitManualReply = item.source === "implicit_manual_reply";
    if (decision === "reject" && isImplicitManualReply && rejectReason.length < 2) {
      setFeedbackReviewError("수동 답장 학습 후보를 거절하려면 사유를 입력해야 합니다(예: casebook 하드룰 위반).");
      return;
    }
    const busyKey = `${item.id}:${decision}`;
    setFeedbackReviewBusyKey(busyKey);
    setFeedbackReviewError(null);
    try {
      await indexFeedbackKb({
        target: item.target,
        pipelineDomain: item.pipelineDomain,
        feedbackRef: item.feedbackRef,
        artifactRef: item.artifactRef,
        reviewDecision: decision,
        reviewNote: decision === "approve"
          ? "Knowledge admin에서 사람이 승인함"
          : rejectReason || "Knowledge admin에서 사람이 생성 반영을 거절 또는 철회함",
        correctionNote: decision === "approve" && item.rating === "down" ? correctionNote : undefined,
        expectedRevision: item.revision ?? 0,
        transitionId: crypto.randomUUID(),
        ...scopePayload,
      });
      requestDataRefresh();
      await loadGovernanceStatus();
    } catch (error) {
      setFeedbackReviewError(error instanceof Error ? error.message : "피드백 검토 처리 실패");
    } finally {
      setFeedbackReviewBusyKey(null);
    }
  };

  const handleFineTune = async (item: GovernedFeedback, action: "release" | "retry") => {
    if (!item.feedbackRef?.startsWith("feedback/")) return;
    const scopePayload = exactScopePayload(item.scope);
    if (!scopePayload) {
      setFeedbackReviewError("레거시 무범위 피드백은 외부 반출할 수 없습니다.");
      return;
    }
    const busyKey = `${item.id}:fine-tune:${action}`;
    setFineTuneBusyKey(busyKey);
    setFeedbackReviewError(null);
    try {
      await queueFineTuneExample({
        target: item.target,
        pipelineDomain: item.pipelineDomain,
        feedbackRef: item.feedbackRef,
        artifactRef: item.artifactRef,
        releaseApproved: true,
        fineTuneAction: action,
        expectedRevision: item.revision ?? 0,
        ...(action === "retry" ? { expectedOutboxRevision: item.fineTuneRevision ?? 0 } : {}),
        transitionId: crypto.randomUUID(),
        ...scopePayload,
      });
      requestDataRefresh();
      await loadGovernanceStatus();
    } catch (error) {
      setFeedbackReviewError(error instanceof Error ? error.message : "Fine-tune 반출 처리 실패");
    } finally {
      setFineTuneBusyKey(null);
    }
  };

  const reasonMap = new Map<string, number>();
  for (const f of feedback) {
    if (f.rating === "down" && f.reason) {
      reasonMap.set(f.reason, (reasonMap.get(f.reason) ?? 0) + 1);
    }
  }
  const topReasons = Array.from(reasonMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => ({ reason, n }));
  const maxReason = topReasons.length > 0 ? Math.max(...topReasons.map((r) => r.n)) : 1;
  return (
    <div className="mx-auto max-w-content px-6 py-7">
      <PageHeader
        title="지식 베이스"
        desc="휴먼 피드백을 검토하고 PII·원문·라인리지 무결성을 검사한 뒤 승인된 가이드만 Firestore 어휘 검색으로 AI 생성에 반영"
      />

      {feedbackLoading || kbReviewLoading || governanceLoading ? (
        <LoadingStatus className="mb-4">지식 베이스 데이터를 불러오는 중</LoadingStatus>
      ) : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="knowledge-capability-status">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-ink-2">어휘 검색</div>
            <Badge tone={governanceError ? "danger" : governanceStatus ? "ok" : "neutral"} dot>
              {governanceError ? "확인 실패" : governanceStatus ? "사용 중" : "확인 중"}
            </Badge>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            {governanceStatus
              ? `서버 집계 활성 엔트리 ${governanceStatus.counts.knowledge.activeEntries}건 · 레거시 무범위는 차단`
              : governanceError ?? "서버 capability를 확인하고 있습니다."}
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-ink-2">벡터 검색</div>
            <Badge tone={governanceStatus ? "neutral" : governanceError ? "danger" : "neutral"} dot>
              {governanceStatus ? "사용 불가" : governanceError ? "확인 실패" : "확인 중"}
            </Badge>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            {governanceStatus
              ? `서버 상태 ${governanceStatus.capabilities.vectorRetrieval.reason} · 적재 ${governanceStatus.capabilities.vectorRetrieval.indexedDocuments}건`
              : "고정 성공 문구 대신 서버 상태를 기다립니다."}
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-ink-2">피드백 검토</div>
            <Badge tone={reviewPendingCount === undefined ? "neutral" : reviewPendingCount > 0 ? "warn" : "ok"} dot>
              {reviewPendingCount === undefined ? "확인 중" : `${reviewPendingCount}건 대기`}
            </Badge>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            검토 전 피드백은 생성 컨텍스트에 들어가지 않습니다. 서버 집계 활성 반영 {promotedCount ?? "—"}건.
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-ink-2">Fine-tune 외부 반출</div>
            <Badge
              tone={governanceStatus?.capabilities.fineTuneRelease.status === "provider_configured" ? "ok" : governanceError ? "danger" : "warn"}
              dot
            >
              {governanceStatus?.capabilities.fineTuneRelease.status === "provider_configured"
                ? "Provider 연결"
                : governanceError
                  ? "확인 실패"
                  : "Durable outbox"}
            </Badge>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            {governanceStatus
              ? governanceStatus.counts.fineTuneOutbox.pending > 0
                || governanceStatus.counts.fineTuneOutbox.retryable > 0
                || governanceStatus.counts.fineTuneOutbox.compensationRequired > 0
                ? `대기 ${governanceStatus.counts.fineTuneOutbox.pending} · 재시도 ${governanceStatus.counts.fineTuneOutbox.retryable} · 보상 필요 ${governanceStatus.counts.fineTuneOutbox.compensationRequired}`
                // 141차: outbox 내부 카운터 3종을 상시 노출하던 것을 0일 때는 접는다.
                : "대기 중인 반출 없음"
              : "서버 outbox 상태를 확인하고 있습니다."}
          </p>
        </Card>
      </div>

      {governanceError ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          <span>{governanceError}</span>
          <Button size="sm" variant="secondary" disabled={governanceLoading} onClick={() => void loadGovernanceStatus()}>
            다시 확인
          </Button>
        </div>
      ) : null}

      {/* STAT row */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">총 피드백</div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ink">
            {totalCount ?? "—"}
            <span className="ml-2 text-[11px] font-medium text-ink-4">현재 로드 {feedback.length}</span>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-1 text-xs font-medium text-ok">
            <ThumbUp className="h-3.5 w-3.5" />
            <span>현재 로드 추천</span>
          </div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ok">
            {upCount}
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-1 text-xs font-medium text-danger">
            <ThumbDown className="h-3.5 w-3.5" />
            <span>현재 로드 수정 필요</span>
          </div>
          <div className="mt-2 text-[28px] font-bold leading-none text-danger">
            {downCount}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">전체 지식 노드</div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ai">
            {knowledgeNodesTotal}
          </div>
          <div className="mt-1 text-[11px] text-ink-3">
            최근 {knowledgeNodes.length}건 중 피드백 기반 {feedbackKbCount}건
          </div>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader title="주요 수정 사유" />
        <div className="space-y-3 px-5 py-4">
          {topReasons.length === 0 ? (
            <div className="py-2 text-sm text-ink-3">아직 수정 피드백이 없습니다.</div>
          ) : (
            topReasons.map((item) => (
              <div key={item.reason} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-xs text-ink-2">{item.reason}</span>
                <div className="flex flex-1 items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill">
                    <div
                      className="h-full rounded-full bg-danger"
                      style={{ width: `${(item.n / maxReason) * 100}%` }}
                    />
                  </div>
                  <span className="w-4 shrink-0 text-right text-xs font-semibold text-ink-2">
                    {item.n}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* 141차: 노드·엣지가 전혀 없으면(신규/미사용 환경) 아무도 안 읽는 그래프 설명문만 상시
          노출됐다 — 데이터가 생기기 전까지는 섹션 자체를 숨긴다. */}
      {recentKnowledgeNodes.length > 0 || knowledgeEdges.length > 0 ? (
        <Card className="mb-6">
          <CardHeader
            title="지식 그래프 노드"
            desc="감사·출처 추적용 그래프. 그래프 노드 자체는 생성에 자동 반영되지 않으며, 별도 검토·평가·프로모션을 통과한 피드백 엔트리만 검색됩니다."
            action={<Badge tone="ai">{knowledgeEdges.length} edges</Badge>}
          />
          {/* 2026-09-07 프로드 Aside 실측: 데이터가 있으면 노드 전체(원문 제목·출처)가 상시 덤프됐다 — 기본 접힘. */}
          <details data-testid="knowledge-graph-nodes">
            <summary className="cursor-pointer px-5 py-3 text-xs font-semibold text-accent">
              노드 {recentKnowledgeNodes.length}개 보기
            </summary>
          <div>
            {recentKnowledgeNodes.map((node) => (
              <div key={node.id} className="border-b border-line px-5 py-3.5 last:border-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone={node.type === "feedback_kb" ? "ai" : "neutral"}>{node.type ?? "knowledge"}</Badge>
                  <span className="text-xs text-ink-3">{node.createdAtIso ?? "시간 없음"}</span>
                  {node.sourceRefs && node.sourceRefs.length > 0 && (
                    <Badge tone="info">source {node.sourceRefs.length}</Badge>
                  )}
                  {node.entityRefs && node.entityRefs.length > 0 && (
                    <Badge tone="neutral">entity {node.entityRefs.length}</Badge>
                  )}
                </div>
                <div className="text-sm font-semibold text-ink">{redactForDisplay(node.title ?? node.id)}</div>
                {node.summary && (
                  <div className="mt-1 text-sm leading-relaxed text-ink-2">{redactForDisplay(node.summary)}</div>
                )}
                {node.sourceRefs && node.sourceRefs.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {node.sourceRefs.slice(0, 3).map((source) => (
                      <Badge key={`${node.id}-${source.ref ?? source.summary}`} tone="neutral">
                        {source.type ?? "출처"} · {redactForDisplay(source.summary ?? source.ref ?? "출처 미기록")}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          </details>
        </Card>
      ) : null}

      <Card className="mb-6" data-testid="kb-review-queue">
        <CardHeader
          title="지식 충돌 검수 큐"
          desc="같은 항목에 서로 다른 내용이 들어와 자동 반영을 보류한 건 — 사람이 최종 확인"
          action={<Badge tone={kbReviewTotal > 0 ? "warn" : "neutral"}>{kbReviewTotal}건 대기 · {kbReviewItems.length}건 로드</Badge>}
        />
        <div>
          {kbReviewLoading ? (
            <div className="px-5 py-8 text-center text-sm text-ink-3">불러오는 중…</div>
          ) : kbReviewError ? (
            <div className="px-5 py-8 text-center text-sm text-danger">{kbReviewError}</div>
          ) : kbReviewItems.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-ink-3">대기 중인 충돌 항목이 없습니다.</div>
          ) : (
            kbReviewItems.map((item) => {
              const existingTitle = redactForDisplay(typeof item.existing.title === "string" ? item.existing.title : "(제목 없음)");
              const incomingTitle = redactForDisplay(typeof item.incoming.title === "string" ? item.incoming.title : "(제목 없음)");
              const existingSummary = redactForDisplay(typeof item.existing.summary === "string" ? item.existing.summary : "");
              const incomingSummary = redactForDisplay(typeof item.incoming.summary === "string" ? item.incoming.summary : "");
              const acceptBusy = kbReviewBusyKey === `${item.id}:accept`;
              const keepBusy = kbReviewBusyKey === `${item.id}:keep`;
              return (
                <div key={item.id} className="border-b border-line px-5 py-3.5 last:border-0" data-testid="kb-review-item">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge tone="warn">{item.reason || "conflicting_content"}</Badge>
                    <span className="text-xs text-ink-3">{item.nodeId}</span>
                    <span className="text-xs text-ink-4">{item.createdAtIso}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded-md border border-line bg-fill/40 p-2.5">
                      <div className="text-[11px] font-semibold text-ink-2">기존(유지 시)</div>
                      <div className="mt-1 text-sm font-medium text-ink">{existingTitle}</div>
                      {existingSummary && <div className="mt-1 text-xs text-ink-3">{existingSummary}</div>}
                    </div>
                    <div className="rounded-md border border-line bg-paper p-2.5">
                      <div className="text-[11px] font-semibold text-ink-2">새 내용(수용 시)</div>
                      <div className="mt-1 text-sm font-medium text-ink">{incomingTitle}</div>
                      {incomingSummary && <div className="mt-1 text-xs text-ink-3">{incomingSummary}</div>}
                    </div>
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={acceptBusy || keepBusy}
                      data-testid="kb-review-accept"
                      onClick={() => void handleResolveKbReview(item, "accept")}
                    >
                      {acceptBusy ? "반영 중…" : "새 내용 수용"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acceptBusy || keepBusy}
                      data-testid="kb-review-keep"
                      onClick={() => void handleResolveKbReview(item, "keep")}
                    >
                      {keepBusy ? "처리 중…" : "기존 유지"}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
          {!kbReviewLoading && !kbReviewError && kbReviewNextCursor ? (
            <div className="border-t border-line px-5 py-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void loadKbReviewQueue(kbReviewNextCursor, true)}
              >
                다음 50건 불러오기
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      <Card data-testid="feedback-governance-review">
        <CardHeader
          title="최근 피드백"
          desc="사람이 승인하고 PII·원문·라인리지 무결성 검사를 통과한 항목만 생성에 반영됩니다. 이 검사는 답변 품질 평가가 아닙니다. 거절 또는 철회는 즉시 검색 대상에서 제외됩니다."
          action={
            <Button
              size="sm"
              variant={implicitReplyOnly ? "primary" : "secondary"}
              data-testid="implicit-manual-reply-filter"
              onClick={() => setImplicitReplyOnly((current) => !current)}
            >
              수동 답장 학습 후보만 {implicitReplyOnly ? "해제" : `보기 (${implicitManualReplyCount})`}
            </Button>
          }
        />
        <div className="border-b border-line bg-fill/35 px-5 py-2 text-[11px] text-ink-3">
          서버 총계 {totalCount ?? "확인 중"}건 · 현재 {feedback.length}건 로드
          {implicitReplyOnly ? ` · 수동 답장 학습 후보 ${implicitManualReplyCount}건 필터링 중` : ""}
          {feedbackPageInfo?.truncated ? " · 페이지가 잘려 있어 현재 목록은 전체가 아닙니다." : ""}
        </div>
        {feedbackReviewError ? (
          <div className="border-b border-line bg-danger/5 px-5 py-3 text-sm text-danger" role="alert">
            {feedbackReviewError}
          </div>
        ) : null}
        <div>
          {feedbackLoading ? (
            <div className="px-5 py-8 text-center text-sm text-ink-3">피드백 원장을 불러오는 중…</div>
          ) : feedbackLoadError ? (
            <div className="px-5 py-8 text-center text-sm text-danger" role="alert">{feedbackLoadError}</div>
          ) : visibleFeedback.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-ink-3">
              {implicitReplyOnly ? "수동 답장 학습 후보가 없습니다." : "아직 피드백이 없습니다."}
            </div>
          ) : visibleFeedback.map((fb) => {
            const governance = feedbackGovernance(fb);
            const targetTone =
              fb.target === "chat"
                ? "neutral"
                : fb.target === "email"
                  ? "info"
                  : "accent";
            const scopePayload = exactScopePayload(fb.scope);
            const canReview = Boolean(fb.feedbackRef?.startsWith("feedback/") && scopePayload);
            const approveBusy = feedbackReviewBusyKey === `${fb.id}:approve`;
            const rejectBusy = feedbackReviewBusyKey === `${fb.id}:reject`;
            const isActive = fb.promotionStatus === "promoted" && fb.retrievalStatus === "active";
            const canReleaseFineTune = isActive
              && (live.role === "admin" || live.role === "super_admin")
              && fb.fineTuneStatus !== "sent_to_aihub"
              && fb.fineTuneStatus !== "dispatching";
            const fineTuneAction = fb.fineTuneStatus === "retryable" || fb.fineTuneStatus === "approved_waiting_for_provider"
              ? "retry" as const
              : "release" as const;
            const fineTuneBusy = fineTuneBusyKey === `${fb.id}:fine-tune:${fineTuneAction}`;
            const isImplicitManualReply = fb.source === "implicit_manual_reply";
            const pairedCaseId = fb.pairedInboundCaseId ?? undefined;
            const isHardRuleCase = Boolean(pairedCaseId && CASEBOOK_HARD_RULE_IDS.has(pairedCaseId));
            const lineage = [
              ["검토 요약", fb.reviewRef],
              ["최근 결정", fb.latestReviewEventRef],
              ["검토 예시", fb.reviewedExampleRef],
              ["무결성 검사 데이터", fb.evalDatasetItemRef],
              ["무결성 검사 결과", fb.evalResultRef],
              ["프로모션", fb.promotionRef],
            ].filter((item): item is [string, string] => typeof item[1] === "string" && item[1].length > 0);
            return (
              <div
                key={fb.id}
                className="flex items-start gap-3 border-b border-line px-5 py-4 last:border-0"
                data-testid="feedback-governance-item"
                data-feedback-id={fb.id}
                data-feedback-source={fb.source ?? undefined}
              >
                {/* rating icon */}
                <span className="mt-0.5 shrink-0">
                  {fb.rating === "up" ? (
                    <ThumbUp className="h-[18px] w-[18px] text-ok" />
                  ) : (
                    <ThumbDown className="h-[18px] w-[18px] text-danger" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone={targetTone}>{fb.target}</Badge>
                    {isImplicitManualReply ? (
                      <Badge tone="ai">
                        수동 답장 학습 후보 · {fb.replyKind === "gmail_import" ? "Gmail 편입" : "Flu Chat"}
                      </Badge>
                    ) : null}
                    {isHardRuleCase ? (
                      <Badge tone="danger">casebook 하드룰: {pairedCaseId}</Badge>
                    ) : null}
                    {fb.reason && (
                      <Badge tone="danger">{fb.reason}</Badge>
                    )}
                    <Badge tone={governance.tone}>{governance.label}</Badge>
                    {fb.promptVersion ? <Badge tone="ai">prompt {fb.promptVersion}</Badge> : null}
                    {fb.scope ? (
                      <Badge tone="neutral">
                        {fb.scope.kind === "campaign"
                          ? `${fb.scope.programId}/${fb.scope.campaignId}/${fb.scope.locale}`
                          : `global/${fb.scope.locale}`}
                      </Badge>
                    ) : (
                      <Badge tone="danger">legacy unscoped · 차단</Badge>
                    )}
                  </div>
                  {/* excerpt */}
                  <div className="text-sm font-medium text-ink">{redactForDisplay(fb.excerpt)}</div>
                  {/* note */}
                  {fb.note && !isImplicitManualReply && (
                    <div className="mt-0.5 text-xs italic text-ink-3">{redactForDisplay(fb.note)}</div>
                  )}
                  {/* 수동 답장 학습 후보: inbound ↔ reply 나란히 비교 (kb-review-queue 와 같은 그리드 패턴) */}
                  {isImplicitManualReply ? (
                    <div className="mt-2" data-testid="manual-reply-pairing">
                      {isHardRuleCase ? (
                        <div className="mb-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
                          이 답장이 답한 inbound는 casebook 하드룰({pairedCaseId})로 분류되었습니다 — 답장 내용이 확정 조건(예: 협상된 단가)을 포함한다면 거절하세요.
                        </div>
                      ) : null}
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="rounded-md border border-line bg-fill/40 p-2.5">
                          <div className="text-[11px] font-semibold text-ink-2">
                            인바운드(크리에이터) {pairedCaseId ? `· ${pairedCaseId}` : ""}
                          </div>
                          <div className="mt-1 whitespace-pre-wrap text-xs text-ink-3">
                            {redactForDisplay(fb.pairedInboundExcerpt || fb.note || "(본문 없음)")}
                          </div>
                        </div>
                        <div className="rounded-md border border-line bg-paper p-2.5">
                          <div className="text-[11px] font-semibold text-ink-2">사람의 답장</div>
                          <div className="mt-1 whitespace-pre-wrap text-xs text-ink-3">
                            {redactForDisplay(fb.pairedReplyExcerpt || fb.excerpt || "(본문 없음)")}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {/* user · time */}
                  <div className="mt-1 text-[11px] text-ink-4">
                    {redactForDisplay(fb.user)} · {fb.time}
                    {fb.reviewedBy ? ` · 검토 ${fb.reviewedBy}` : ""}
                    {fb.reviewedAt ? ` · ${fb.reviewedAt}` : ""}
                  </div>
                  {lineage.length > 0 ? (
                    <div className="mt-2 grid gap-1 rounded-md border border-line bg-fill/35 px-3 py-2" data-testid="feedback-lineage">
                      {lineage.map(([label, ref]) => (
                        <div key={`${fb.id}-${label}`} className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2 text-[11px] leading-4">
                          <span className="font-semibold text-ink-3">{label}</span>
                          <span className="break-all font-mono text-ink-2">{ref}</span>
                        </div>
                      ))}
                      {fb.policyVersion ? (
                        <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2 text-[11px] leading-4">
                          <span className="font-semibold text-ink-3">정책</span>
                          <span className="break-all font-mono text-ink-2">{fb.policyVersion}</span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {fb.rating === "down" && canReview ? (
                    <div className="mt-2.5">
                      <label className="mb-1 block text-[11px] font-semibold text-ink-3" htmlFor={`correction-${fb.id}`}>
                        승인 시 사용할 올바른 가이드 문구 (필수)
                      </label>
                      <textarea
                        id={`correction-${fb.id}`}
                        value={correctionNotes[fb.id] ?? ""}
                        onChange={(event) => setCorrectionNotes((current) => ({ ...current, [fb.id]: event.target.value }))}
                        placeholder="잘못된 원문 대신 생성에 반영할 수정 가이드를 입력하세요"
                        className="min-h-16 w-full resize-y rounded-md border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-ink outline-none focus:border-accent"
                      />
                    </div>
                  ) : null}
                  {isImplicitManualReply && canReview ? (
                    <div className="mt-2.5">
                      <label className="mb-1 block text-[11px] font-semibold text-ink-3" htmlFor={`reject-reason-${fb.id}`}>
                        거절 사유 (거절 시 필수 — casebook 하드룰 위반 포함)
                      </label>
                      <textarea
                        id={`reject-reason-${fb.id}`}
                        value={rejectReasons[fb.id] ?? ""}
                        onChange={(event) => setRejectReasons((current) => ({ ...current, [fb.id]: event.target.value }))}
                        placeholder="예: casebook 하드룰 위반 (협상된 단가 노출)"
                        className="min-h-12 w-full resize-y rounded-md border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-ink outline-none focus:border-accent"
                      />
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {IMPLICIT_MANUAL_REPLY_REJECT_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3 hover:bg-fill"
                            onClick={() => setRejectReasons((current) => ({ ...current, [fb.id]: preset }))}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!canReview || approveBusy || rejectBusy}
                      data-testid="feedback-review-approve"
                      onClick={() => void handleFeedbackReview(fb, "approve")}
                    >
                      {approveBusy ? "무결성 검사·반영 중…" : isActive ? "재검사·승인" : "승인·무결성 검사·반영"}
                    </Button>
                    <Button
                      size="sm"
                      variant={isActive ? "danger" : "ghost"}
                      disabled={!canReview || approveBusy || rejectBusy || fb.reviewStatus === "rejected"}
                      data-testid="feedback-review-reject"
                      onClick={() => void handleFeedbackReview(fb, "reject")}
                    >
                      {rejectBusy ? "제외 중…" : isActive ? "생성 반영 철회" : "거절"}
                    </Button>
                    {!canReview ? (
                      <span className="text-[11px] text-ink-4">정확한 scope/revision이 없는 레거시 항목은 검토 대상이 아닙니다.</span>
                    ) : null}
                    {canReleaseFineTune ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={approveBusy || rejectBusy || fineTuneBusy}
                        onClick={() => void handleFineTune(fb, fineTuneAction)}
                      >
                        {fineTuneBusy
                          ? "Outbox 처리 중…"
                          : fineTuneAction === "retry"
                            ? "Fine-tune 재시도"
                            : "Fine-tune 반출 승인"}
                      </Button>
                    ) : null}
                    {fb.fineTuneStatus ? <Badge tone={fb.fineTuneStatus === "sent_to_aihub" ? "ok" : fb.fineTuneStatus === "compensation_required" ? "danger" : "neutral"}>{fineTuneStatusLabel(fb.fineTuneStatus)}</Badge> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <p className="mt-4 text-xs text-ink-3">
        현재 운영 기능은 Firestore 기반 어휘 검색입니다. 벡터/임베딩 검색은 사용할 수 없으며,
        검토되지 않은 피드백과 무결성 검사 실패 항목은 생성에 반영되지 않습니다.
      </p>
    </div>
  );
}
