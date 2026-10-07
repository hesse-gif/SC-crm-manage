"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { SETTINGS, getAiHubKeyStatus, getApiQuotaStatus, getMailSafetyStatus, getSettings, updateSettings, type AiHubKeyStatusEnvelope, type ApiQuotaStatusEnvelope, type LlmUsage, type MailSafetyStatusEnvelope, type Role } from "@/lib/data";
import { llmProvenanceLabel } from "@/lib/statusLabels";
import { callableErrorCode, requestDataRefresh, useLive, useLiveLlmUsage } from "@/lib/live";
import { subscribeAuthState } from "@/lib/auth";
// W90: 키워드 코퍼스 가시성 패널(읽기 전용).
import { KeywordCorpusPanel } from "./KeywordCorpusPanel";

type ModelRouteKey = keyof typeof SETTINGS.llmModelRoutes;
type ModelRoute = typeof SETTINGS.llmModelRoutes[ModelRouteKey];
type RouteMode = "cost" | "quality";

// 141차: "지식 적재"·"후보 탐색" 모델 라우트 카드(runtime consumer 없음, 설정만 저장됨) 삭제 —
// 죽은 설정 UI였다. 실제로 런타임이 소비하는 라우트만 이 화면에 남긴다. SETTINGS.llmModelRoutes
// 자체의 knowledge_ingest/candidate_discovery 값은 보존된다(연결되면 다시 추가).
type DisplayedModelRouteKey = Extract<ModelRouteKey, "mail_gateway_triage" | "auto_reply_draft">;

const routeOrder: DisplayedModelRouteKey[] = ["mail_gateway_triage", "auto_reply_draft"];

const routeRuntimeStatus: Record<DisplayedModelRouteKey, { connected: boolean; evidence: string }> = {
  mail_gateway_triage: { connected: true, evidence: "chat-ai gateway triage가 매 호출마다 이 설정을 읽음" },
  auto_reply_draft: { connected: true, evidence: "chat-ai 자동 회신 초안이 매 호출마다 이 설정을 읽음" },
};

type UsageStatus = "live" | "cache_hit" | "historical_mock" | "legacy_unverified";
type LlmUsageWithMeta = LlmUsage & { seedWrite?: boolean };

const VERIFIED_LLM_TRANSPORTS = new Set(["ai_hub_gateway", "vertex_direct"]);
const TRUSTED_LLM_USAGE_SOURCES = new Set(["gateway-reportLlmUsage"]);

function expectedUsageAggregationIdentity(row: LlmUsageWithMeta): string {
  return [
    row.model.trim(),
    row.tier.trim(),
    (row.provider ?? "unverified").trim().toLowerCase(),
    row.transport ?? "unverified",
  ].join("|");
}

function usageStatus(row: LlmUsageWithMeta): UsageStatus {
  const evidence = `${row.model} ${row.source ?? ""} ${row.provider ?? ""} ${row.transport ?? ""}`.toLowerCase();
  if (/mock|demo[_ -]?seed|emulator[_ -]?mock/.test(evidence)) return "historical_mock";
  const trustedWriter = TRUSTED_LLM_USAGE_SOURCES.has(row.source ?? "");
  const verifiedIdentity = row.schemaVersion === "llm-usage-v2"
    && row.aggregationIdentity === expectedUsageAggregationIdentity(row)
    && row.provider !== "unverified";
  if (trustedWriter && verifiedIdentity && row.transport === "cache") return "cache_hit";
  if (trustedWriter && verifiedIdentity && VERIFIED_LLM_TRANSPORTS.has(row.transport ?? "")) return "live";
  return "legacy_unverified";
}

function usageStatusPresentation(status: UsageStatus): { label: string; tone: "ok" | "warn" | "neutral" } {
  if (status === "live") return { label: "현재 실호출", tone: "ok" };
  if (status === "cache_hit") return { label: "캐시 적중", tone: "neutral" };
  if (status === "historical_mock") return { label: "과거 mock", tone: "warn" };
  return { label: "과거·출처 미확인", tone: "neutral" };
}

function normalizeModelRoutes(routes?: Partial<Record<ModelRouteKey, Partial<ModelRoute>>>) {
  const normalized = { ...SETTINGS.llmModelRoutes };
  for (const taskKey of routeOrder) {
    const merged = { ...SETTINGS.llmModelRoutes[taskKey], ...(routes?.[taskKey] ?? {}) };
    const currentModel = merged.mode === "quality" ? merged.premiumModel : merged.costModel;
    normalized[taskKey] = {
      ...merged,
      currentModel: currentModel || merged.currentModel,
    };
  }
  return normalized;
}

function displayModel(model: string): string {
  if (model === "gemini-2.5-flash-lite") return "Gemini 2.5 Flash-Lite";
  if (model === "gemini-2.5-flash") return "Gemini 2.5 Flash";
  if (model === "gemini-2.5-pro") return "Gemini 2.5 Pro";
  if (model === "minisearch-bm25") return "MiniSearch BM25";
  return model;
}

function displayMode(mode: string): "비용 우선" | "품질 우선" {
  return mode === "quality" ? "품질 우선" : "비용 우선";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function costMilliKRW(row: LlmUsage): number {
  const precise = finiteNumber(row.costMilliKRW);
  if (precise !== null) return Math.max(0, Math.round(precise));
  return Math.max(0, Math.round(row.costKRW * 1000));
}

function displayCostKRW(milliKRW: number): string {
  if (milliKRW <= 0) return "₩0";
  if (milliKRW < 1000) return "<₩1";
  const krw = milliKRW / 1000;
  if (krw < 1000 && !Number.isInteger(krw)) return `₩${krw.toFixed(2)}`;
  return `₩${Math.round(krw).toLocaleString()}`;
}

// S12(d): reportLlmUsage toolId → 한글 기능명/목적 라벨. 매핑에 없는 신규 toolId는 원문 그대로 표시(누락 방지).
const TOOL_ID_LABELS: Record<string, string> = {
  "mail.coldmail_translate": "콜드메일 번역",
  "scp.ad_proposal_draft": "광고 제안 초안 생성",
  "community.sentiment": "커뮤니티 감성 분석",
  "community.redditComments": "레딧 댓글 분석",
  "video.comment_analysis": "영상 댓글 인사이트",
  "video.ad_classification": "영상 광고 분류",
  "video.classification.tier_one": "영상 1차 분류",
  "video.video_deep_analysis": "영상 심층 분석",
  "video.video_review_judge": "영상 검수 판정(멀티모달)",
  "trend_report.headline": "주간 트렌드 헤드라인",
  scp_qualification_judge: "크리에이터 자격 판정",
  scp_creator_accent_gate: "크리에이터 언어/억양 게이트",
  scp_video_review_judge: "영상 검수 판정",
  gatewayProxy: "챗 게이트웨이(초안·요약)",
  receiveEmail: "수신 메일 요약/게이트",
  unknown: "미분류",
};
function toolLabel(toolId: string): string {
  return TOOL_ID_LABELS[toolId] ?? toolId;
}

function lastUsageDisplay(updatedAtIso?: string): string {
  if (!updatedAtIso) return "—";
  const parsed = new Date(updatedAtIso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function quotaTone(percent: number): "ok" | "warn" | "danger" {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warn";
  return "ok";
}

function QuotaBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const barColor = clamped >= 90 ? "bg-danger" : clamped >= 70 ? "bg-warn" : "bg-ok";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-fill">
      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function QuotaStat({ label, value, cap, tone }: { label: string; value: number; cap?: number; tone?: "danger" | "warn" }) {
  const valueColor = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="rounded-md bg-fill px-3 py-2.5">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className={`mt-0.5 text-sm font-bold ${valueColor}`}>
        {value.toLocaleString()}
        {cap != null && cap > 0 ? <span className="text-xs font-normal text-ink-3"> / {cap.toLocaleString()}</span> : null}
      </div>
    </div>
  );
}

type ApiQuotaStatus = NonNullable<ApiQuotaStatusEnvelope["status"]>;
type ApiQuotaMailStatus = NonNullable<ApiQuotaStatus["mail"]>;
type MailSafetyStatus = NonNullable<MailSafetyStatusEnvelope["status"]>;

function resolveMailOutboundLockPresentation(
  status: MailSafetyStatus | null,
  quotaMail?: ApiQuotaMailStatus,
) {
  const manualSendAllowed = status?.manualSendAllowed ?? status?.operational?.manualSend.allowed;
  const automatedSendLocked = status?.automatedSendLocked
    ?? (status?.operational?.automatedSend
      ? !status.operational.automatedSend.allowed
      : status?.outboundLocked === true || quotaMail?.outboundLocked === true);
  const allOutboundLocked = status?.allOutboundLocked
    ?? (automatedSendLocked && manualSendAllowed === false);
  const lockedReason = allOutboundLocked
    ? status?.operational?.manualSend.blockerReason
      ?? status?.lockedReason
      ?? quotaMail?.lockedReason
    : status?.operational?.automatedSend.blockerReason
      ?? status?.lockedReason
      ?? quotaMail?.lockedReason;
  return { automatedSendLocked, allOutboundLocked, manualSendAllowed, lockedReason };
}

export default function LlmPage() {
  const live = useLive();
  const llmUsage = useLiveLlmUsage<LlmUsage>([]);
  const [modelRoutes, setModelRoutes] = useState(normalizeModelRoutes());
  const [routeSaving, setRouteSaving] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [settingsRevision, setSettingsRevision] = useState<number | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [quota, setQuota] = useState<NonNullable<ApiQuotaStatusEnvelope["status"]> | null>(null);
  const [mailSafetyStatus, setMailSafetyStatus] = useState<MailSafetyStatus | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<AiHubKeyStatusEnvelope["keyStatus"] | null>(null);
  const [failureStatus, setFailureStatus] = useState<AiHubKeyStatusEnvelope["failureStatus"]>(null);
  const [keyStatusError, setKeyStatusError] = useState<string | null>(null);
  const isSuperAdmin = role === "super_admin";
  // R7 P10: llmUsage 키 단위 로드 상태만으로 판정 — 무관 라우트 데이터(NOTIFICATION_DATASET_KEYS 등)를
  // 기다리는 벌크 live.loading에는 더 이상 의존하지 않는다(conversations 블로킹 제거).
  const llmUsageLoaded = live.perKeyLoaded("llmUsage");
  const llmUsageFetching = Boolean(live.loadingKeys.llmUsage);
  const isUsageLoading = !live.authReady || (live.canRead && (!llmUsageLoaded || llmUsageFetching));
  const cannotRead = live.authReady && !live.canRead;
  const totalLlmUsage = live.data?.counts?.llmUsage ?? 0;
  const isLlmTruncated = totalLlmUsage > llmUsage.length && llmUsage.length > 0;
  const liveUsage = llmUsage.filter((row) => usageStatus(row as LlmUsageWithMeta) === "live");
  const historicalUsage = llmUsage.filter((row) => {
    const status = usageStatus(row as LlmUsageWithMeta);
    return status === "historical_mock" || status === "legacy_unverified";
  });
  const totalCalls = liveUsage.reduce((s, r) => s + r.calls, 0);
  const totalTokensK = liveUsage.reduce((s, r) => s + r.tokensK, 0);
  const totalCostMilliKRW = liveUsage.reduce((s, r) => s + costMilliKRW(r), 0);
  const historicalCalls = historicalUsage.reduce((sum, row) => sum + row.calls, 0);
  const rows = llmUsage.map((row) => ({
    ...row,
    costMilliKRW: costMilliKRW(row),
    displayName: row.tier === "빠른" ? "저비용 언어 처리" : "정밀 판단 처리",
    source: (row as LlmUsageWithMeta).source ?? "출처 미기록",
    provider: (row as LlmUsageWithMeta).provider ?? "unverified",
    transport: (row as LlmUsageWithMeta).transport ?? "unverified",
    usageStatus: usageStatus(row as LlmUsageWithMeta),
    sharePercent: usageStatus(row as LlmUsageWithMeta) === "live" && totalTokensK > 0
      ? Math.round((row.tokensK / totalTokensK) * 100)
      : 0,
  }));
  const modelRouteRows = routeOrder.map((taskKey) => ({ taskKey, ...modelRoutes[taskKey] }));
  const mailLockPresentation = resolveMailOutboundLockPresentation(mailSafetyStatus, quota?.mail);

  // S12(d): byTool은 Firestore에 이미 쌓이지만 UI에서 버려지고 있었다 — 모델·티어 차원과 별개로
  // "무슨 기능이 얼마나 쓰였는지"를 보여주는 가장 싼 개선. 전 llmUsage 문서의 byTool을 합산한다.
  const toolTotals = new Map<string, { calls: number; tokensK: number; costMilliKRW: number }>();
  for (const row of liveUsage) {
    for (const [toolId, usage] of Object.entries(row.byTool ?? {})) {
      const prev = toolTotals.get(toolId) ?? { calls: 0, tokensK: 0, costMilliKRW: 0 };
      toolTotals.set(toolId, {
        calls: prev.calls + (finiteNumber(usage?.calls) ?? 0),
        tokensK: prev.tokensK + (finiteNumber(usage?.tokensK) ?? 0),
        costMilliKRW: prev.costMilliKRW + (finiteNumber(usage?.costMilliKRW) ?? 0),
      });
    }
  }
  const byToolRows = Array.from(toolTotals.entries())
    .map(([toolId, usage]) => ({ toolId, label: toolLabel(toolId), ...usage }))
    .sort((left, right) => right.costMilliKRW - left.costMilliKRW);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await getSettings();
        if (active) {
          setModelRoutes(normalizeModelRoutes(result.settings.llmModelRoutes));
          setSettingsRevision(result.revision);
        }
      } catch (caught) {
        if (active) setRouteError(caught instanceof Error ? caught.message : "모델 라우팅 설정을 불러오지 못했습니다.");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => subscribeAuthState((state) => setRole(state.role)), []);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let active = true;
    getApiQuotaStatus()
      .then((result) => {
        if (!active) return;
        setQuota(result.status ?? null);
        setQuotaError(null);
      })
      .catch((caught) => {
        if (active) setQuotaError(caught instanceof Error ? caught.message : "API 쿼터 현황을 불러오지 못했습니다.");
      });
    getMailSafetyStatus()
      .then((result) => {
        if (active) setMailSafetyStatus(result.status ?? null);
      })
      .catch(() => {
        // The quota payload still carries the legacy automated-lane boolean, so retain a truthful
        // "자동 발송 잠금" fallback instead of failing the entire quota card.
        if (active) setMailSafetyStatus(null);
      });
    return () => {
      active = false;
    };
  }, [isSuperAdmin]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let active = true;
    getAiHubKeyStatus()
      .then((result) => {
        if (!active) return;
        setKeyStatus(result.keyStatus ?? null);
        setFailureStatus(result.failureStatus ?? null);
        setKeyStatusError(null);
      })
      .catch((caught) => {
        if (active) setKeyStatusError(caught instanceof Error ? caught.message : "AI Hub 키 상태를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, [isSuperAdmin]);

  async function toggleModelRoute(taskKey: DisplayedModelRouteKey) {
    if (!routeRuntimeStatus[taskKey].connected || settingsRevision === null) return;
    const row = modelRoutes[taskKey];
    const nextMode: RouteMode = row.mode === "quality" ? "cost" : "quality";
    const nextCurrentModel = nextMode === "quality" ? row.premiumModel : row.costModel;
    const nextRoutes = {
      ...modelRoutes,
      [taskKey]: {
        ...row,
        mode: nextMode,
        currentModel: nextCurrentModel,
      },
    };
    setModelRoutes(nextRoutes);
    setRouteSaving(taskKey);
    setRouteError(null);
    try {
      const result = await updateSettings({
        patch: { llmModelRoutes: nextRoutes },
        expectedRevision: settingsRevision,
      });
      setSettingsRevision(result.revision);
      requestDataRefresh();
    } catch (caught) {
      if (callableErrorCode(caught) === "aborted") {
        try {
          const latest = await getSettings();
          setModelRoutes(normalizeModelRoutes(latest.settings.llmModelRoutes));
          setSettingsRevision(latest.revision);
          setRouteError("다른 운영자가 먼저 변경했습니다. 서버 최신 모델 라우팅을 다시 불러왔습니다.");
        } catch {
          setModelRoutes(modelRoutes);
          setSettingsRevision(null);
          setRouteError("설정 충돌 후 최신 모델 라우팅을 불러오지 못했습니다.");
        }
      } else {
        setModelRoutes(modelRoutes);
        setRouteError(caught instanceof Error ? caught.message : "모델 라우팅 설정 저장에 실패했습니다.");
      }
    } finally {
      setRouteSaving(null);
    }
  }

  return (
    <div className="mx-auto max-w-content px-6 py-7">
      <PageHeader
        title="LLM 모니터링"
        desc="AI 처리의 provider·transport별 호출·토큰·비용 (§8 COST)"
      />

      {/* INFO banner */}
      <div className="mb-6 rounded-lg border border-info/20 bg-info-soft px-4 py-3 text-sm text-info">
        현재 합계는 검증된 provider와 실제 transport(ai_hub_gateway 또는 vertex_direct)가 함께 기록된 호출만 포함합니다. 캐시·과거 mock·미확인 행은 분리합니다.
      </div>

      <Card className="mb-6">
        <CardHeader
          title="운영 모델 라우팅"
          desc="런타임 소비가 확인된 라우트만 변경할 수 있습니다. 설정만 있고 소비자가 없는 항목은 읽기 전용으로 표시합니다."
        />
        <div className="divide-y divide-line">
          {modelRouteRows.map((row) => (
            <div key={row.taskKey} className="grid gap-3 px-5 py-4 lg:grid-cols-[1.2fr_1fr_1fr_0.7fr]">
              <div>
                <div className="text-sm font-bold text-ink">{row.label}</div>
                <div className="mt-1 text-xs font-medium text-ink-3">{row.taskKey} · {row.source}</div>
                <div className="mt-1"><Badge tone={routeRuntimeStatus[row.taskKey].connected ? "ok" : "neutral"} dot>{routeRuntimeStatus[row.taskKey].connected ? "런타임 연결" : "설정만 저장됨"}</Badge></div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-ink-4">현재 모델</div>
                <div className="mt-1 text-sm font-semibold text-ink-2">{displayModel(row.currentModel)}</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-ink-4">토글 후보</div>
                <div className="mt-1 text-sm font-semibold text-ink-2">{displayModel(row.mode === "quality" ? row.costModel : row.premiumModel)}</div>
              </div>
              <div className="flex flex-wrap items-start gap-1.5">
                <Badge tone={row.mode === "cost" ? "info" : "accent"}>{displayMode(row.mode)}</Badge>
                {routeRuntimeStatus[row.taskKey].connected ? (
                  <button
                    type="button"
                    data-testid={`model-route-toggle-${row.taskKey}`}
                    onClick={() => toggleModelRoute(row.taskKey)}
                    disabled={routeSaving === row.taskKey || settingsRevision === null}
                    className="rounded-full border border-line bg-paper px-2 py-0.5 text-[11px] font-semibold text-ink-2 transition-colors hover:bg-fill disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {routeSaving === row.taskKey ? "저장 중" : row.mode === "cost" ? "품질 우선으로" : "비용 우선으로"}
                  </button>
                ) : <Badge tone="neutral">변경 비활성</Badge>}
              </div>
              <p className="lg:col-span-4 text-xs leading-relaxed text-ink-3">{row.reason} · {routeRuntimeStatus[row.taskKey].evidence}</p>
            </div>
          ))}
        </div>
        {routeError ? <div className="border-t border-line px-5 py-3 text-xs font-semibold text-danger">{routeError}</div> : null}
      </Card>

      {isSuperAdmin ? (
        <Card className="mb-6">
          <CardHeader
            title="API 쿼터 소진 현황"
            desc="오늘(KST) 외부 API 사용량 — YouTube Data API 유닛 + 메일 발송. super_admin 전용. (AI Hub/LLM은 아래 사용량 표에.)"
          />
          {quotaError ? (
            <div className="px-5 py-3 text-xs font-semibold text-danger">{quotaError}</div>
          ) : !quota ? (
            <div className="px-5 py-6 text-center text-xs text-ink-4">쿼터 현황을 불러오는 중입니다</div>
          ) : (
            <div className="divide-y divide-line">
              <div className="px-5 py-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-sm font-bold text-ink">YouTube Data API</div>
                  <Badge tone={quotaTone(quota.youtube?.percentUsed ?? 0)}>
                    {(quota.youtube?.unitsUsed ?? 0).toLocaleString()} / {(quota.youtube?.dailyCap ?? 0).toLocaleString()} 유닛 · {quota.youtube?.percentUsed ?? 0}%
                  </Badge>
                </div>
                <QuotaBar percent={quota.youtube?.percentUsed ?? 0} />
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
                  <span>잔여 {(quota.youtube?.remaining ?? 0).toLocaleString()} 유닛</span>
                  <span>호출 {(quota.youtube?.calls ?? 0).toLocaleString()}회</span>
                  {Object.entries(quota.youtube?.byOperation ?? {})
                    .sort((left, right) => right[1] - left[1])
                    .map(([operation, units]) => (
                      <span key={operation} className="tabular-nums">{operation} {units.toLocaleString()}</span>
                    ))}
                </div>
              </div>
              <div className="px-5 py-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-sm font-bold text-ink">메일 발송 쿼터</div>
                  <div data-testid="mail-outbound-lock-status" className="flex items-center gap-1.5">
                    {mailLockPresentation.allOutboundLocked ? (
                      <Badge tone="danger">전체 발송 잠금</Badge>
                    ) : mailLockPresentation.automatedSendLocked ? (
                      <>
                        <Badge tone="warn">자동 발송 잠금</Badge>
                        {mailLockPresentation.manualSendAllowed === true ? <Badge tone="ok">수동 발송 허용</Badge> : null}
                      </>
                    ) : null}
                    <Badge tone="neutral">{quota.mail?.reputationStatus ?? "pilot"}</Badge>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <QuotaStat label="오늘 발송" value={quota.mail?.todaySent ?? 0} cap={quota.mail?.dailyCap ?? 0} />
                  <QuotaStat label="시간당 발송" value={quota.mail?.hourSent ?? 0} cap={quota.mail?.hourlyCap ?? 0} />
                  <QuotaStat label="버스트 캡" value={quota.mail?.burstCap ?? 0} />
                  <QuotaStat label="반송" value={quota.mail?.bounced ?? 0} tone="danger" />
                  <QuotaStat label="지연" value={quota.mail?.deferred ?? 0} tone="warn" />
                  <QuotaStat label="수신거부" value={quota.mail?.suppressed ?? 0} />
                </div>
                {mailLockPresentation.automatedSendLocked && mailLockPresentation.lockedReason ? (
                  <div data-testid="mail-outbound-lock-reason" className="mt-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[11px] leading-relaxed text-danger">
                    {mailLockPresentation.lockedReason}
                    {mailLockPresentation.manualSendAllowed === true ? " · 수동 1:1 발송은 허용됩니다." : ""}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {isSuperAdmin ? (
        <Card className="mb-6">
          <CardHeader
            title="AI Hub 연동 상태"
            desc="secret/env 설정 여부(boolean만 — 값은 절대 표시하지 않음, G-SECRET) + 외부 리포팅 실패 현황."
          />
          {keyStatusError ? (
            <div className="px-5 py-3 text-xs font-semibold text-danger">{keyStatusError}</div>
          ) : !keyStatus ? (
            <div className="px-5 py-6 text-center text-xs text-ink-4">키 상태를 불러오는 중입니다</div>
          ) : (
            <div className="px-5 py-4">
              <div className="flex flex-wrap gap-1.5" data-testid="ai-hub-key-status">
                <Badge tone={keyStatus.enabled ? "ok" : "neutral"}>AI_HUB_ENABLED {keyStatus.enabled ? "on" : "off"}</Badge>
                <Badge tone={keyStatus.hasProjectId ? "ok" : "danger"}>PROJECT_ID {keyStatus.hasProjectId ? "설정됨" : "누락"}</Badge>
                <Badge tone={keyStatus.hasApiKey ? "ok" : "danger"}>API_KEY {keyStatus.hasApiKey ? "설정됨" : "누락"}</Badge>
                <Badge tone={keyStatus.hasSessionEndpoint ? "ok" : "warn"}>SESSION_ENDPOINT {keyStatus.hasSessionEndpoint ? "설정됨" : "누락"}</Badge>
                <Badge tone={keyStatus.hasReportEndpoint ? "ok" : "warn"}>REPORT_ENDPOINT {keyStatus.hasReportEndpoint ? "설정됨" : "누락"}</Badge>
                <Badge tone={keyStatus.hasGatewayApiKey ? "ok" : "warn"}>GATEWAY_API_KEY {keyStatus.hasGatewayApiKey ? "설정됨" : "누락"}</Badge>
              </div>
              {failureStatus && (failureStatus.failureCount ?? 0) > 0 ? (
                <div className="mt-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs leading-relaxed text-danger" data-testid="ai-hub-failure-banner">
                  <div className="font-semibold">외부 리포팅 실패 {failureStatus.failureCount}건</div>
                  {failureStatus.lastFailureCode ? (
                    <div className="mt-0.5">
                      최근 코드: {failureStatus.lastFailureCode}
                      {typeof failureStatus.lastHttpStatus === "number" ? ` (HTTP ${failureStatus.lastHttpStatus})` : ""}
                    </div>
                  ) : null}
                  {failureStatus.lastCorrelationIdHash ? (
                    <div className="mt-0.5 font-mono text-ink-4">상관 ID: {failureStatus.lastCorrelationIdHash}</div>
                  ) : null}
                  {failureStatus.lastFailureAtIso ? <div className="mt-0.5 text-ink-4">최근 발생: {lastUsageDisplay(failureStatus.lastFailureAtIso)}</div> : null}
                </div>
              ) : (
                <div className="mt-3 text-xs text-ink-4">외부 리포팅 실패 기록 없음(로컬 대시보드 집계는 이 상태와 무관하게 정상 동작).</div>
              )}
            </div>
          )}
        </Card>
      ) : null}

      {/* STAT row */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="llm-usage-truth-status">
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">현재 실호출</div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ink">
            {isUsageLoading ? "..." : totalCalls.toLocaleString()}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">현재 실토큰</div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ink">
            {isUsageLoading ? "..." : totalTokensK.toLocaleString()}
            <span className="ml-1 text-base font-semibold text-ink-3">K</span>
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">현재 실비용</div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ink">
            {isUsageLoading ? "..." : displayCostKRW(totalCostMilliKRW)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-ink-3">
            <span>과거·미확인 기록</span>
            <Badge tone={historicalUsage.length > 0 ? "warn" : "neutral"}>{historicalUsage.length}개 행</Badge>
          </div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ink">
            {isUsageLoading ? "..." : historicalCalls.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-ink-4">현재 실사용 합계에서 제외</div>
        </Card>
      </div>

      {/* TRUNCATION INDICATOR */}
      {isLlmTruncated ? (
        <div
          data-testid="truncation-indicator"
          className="mb-4 flex items-center justify-between rounded-lg border border-warn/40 bg-warn-soft px-4 py-2.5 text-sm text-warn"
        >
          <span>전체 {totalLlmUsage.toLocaleString()}건 중 {llmUsage.length}건 표시</span>
          <span className="text-xs font-semibold">더보기 준비 중</span>
        </div>
      ) : null}

      {/* TABLE */}
      <Card>
        <CardHeader title="처리 엔진별 사용 현황" desc="Provider는 모델 공급자, Transport는 실제 호출 경로입니다. 검증된 실호출만 합계에 포함합니다." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line bg-fill text-xs font-semibold text-ink-3">
                <th className="min-w-[140px] whitespace-nowrap px-5 py-2.5 text-left">처리 엔진</th>
                <th className="px-5 py-2.5 text-left">기록 상태</th>
                <th className="px-5 py-2.5 text-left">모델·소스</th>
                <th className="px-5 py-2.5 text-left">Provider</th>
                <th className="px-5 py-2.5 text-left">Transport</th>
                <th className="px-5 py-2.5 text-left">티어</th>
                <th className="px-5 py-2.5 text-right">호출</th>
                <th className="px-5 py-2.5 text-right">토큰</th>
                <th className="px-5 py-2.5 text-right">비용</th>
                <th className="px-5 py-2.5 text-left w-40">비중</th>
                <th className="px-5 py-2.5 text-left">마지막 사용</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = usageStatusPresentation(row.usageStatus);
                return (
                <tr key={row.aggregationIdentity ?? `${row.model}-${row.tier}-${row.source}-${row.transport}`} className="border-b border-line last:border-0">
                  <td className="min-w-[140px] whitespace-nowrap px-5 py-3 font-medium text-ink">{row.displayName}</td>
                  <td className="px-5 py-3"><Badge tone={status.tone} dot>{status.label}</Badge></td>
                  <td className="px-5 py-3">
                    <div className="font-semibold text-ink-2">{row.model}</div>
                    <div className="mt-0.5 text-xs text-ink-4">{row.source}</div>
                  </td>
                  <td className="px-5 py-3 text-xs font-semibold text-ink-2">{llmProvenanceLabel(row.provider)}</td>
                  <td className="px-5 py-3 text-xs text-ink-3">{llmProvenanceLabel(row.transport)}</td>
                  <td className="px-5 py-3">
                    <Badge tone={row.tier === "빠른" ? "info" : "accent"}>{row.tier}</Badge>
                  </td>
                  <td className="px-5 py-3 text-right text-ink-2">{row.calls.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-ink-2">{row.tokensK.toLocaleString()}K</td>
                  <td className="px-5 py-3 text-right text-ink-2">{displayCostKRW(row.costMilliKRW)}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${row.sharePercent}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right text-xs text-ink-3">{row.sharePercent}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-3">{lastUsageDisplay(row.updatedAtIso)}</td>
                </tr>
                );
              })}
              {isUsageLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-5 py-10 text-center text-sm text-ink-4" role="status" aria-live="polite">
                    Gateway 집계를 불러오는 중입니다. 호출·토큰·비용을 0으로 확정 표시하지 않습니다.
                  </td>
                </tr>
              )}
              {!isUsageLoading && cannotRead && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-5 py-10 text-center text-sm text-ink-4">
                    LLM 사용량은 Admin 이상 권한에서만 볼 수 있습니다.
                  </td>
                </tr>
              )}
              {!isUsageLoading && !cannotRead && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-5 py-10 text-center text-sm text-ink-4">
                    아직 Gateway 집계가 없습니다. AI 초안 생성이나 메일 요약이 실행되면 자동으로 누적됩니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* BY-TOOL BREAKDOWN (S12 d) */}
      {byToolRows.length > 0 ? (
        <Card className="mt-6">
          <CardHeader title="기능별 사용 현황 (byTool)" desc="어떤 기능이 LLM 사용량을 발생시키는지 — toolId → 기능명 매핑." />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm" data-testid="llm-by-tool-table">
              <thead>
                <tr className="border-b border-line bg-fill text-xs font-semibold text-ink-3">
                  <th className="px-5 py-2.5 text-left">기능</th>
                  <th className="px-5 py-2.5 text-right">호출</th>
                  <th className="px-5 py-2.5 text-right">토큰</th>
                  <th className="px-5 py-2.5 text-right">비용</th>
                </tr>
              </thead>
              <tbody>
                {byToolRows.map((row) => (
                  <tr key={row.toolId} className="border-b border-line last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-medium text-ink">{row.label}</div>
                      <div className="mt-0.5 text-xs text-ink-4">{row.toolId}</div>
                    </td>
                    <td className="px-5 py-3 text-right text-ink-2">{row.calls.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-ink-2">{row.tokensK.toLocaleString()}K</td>
                    <td className="px-5 py-3 text-right text-ink-2">{displayCostKRW(row.costMilliKRW)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      <KeywordCorpusPanel />
    </div>
  );
}
