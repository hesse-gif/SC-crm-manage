"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { externalFluHref } from "@/lib/flu-external-link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  AUTO_REPLY,
  getChatAutoCasebookSnapshot,
  getChatAutoCaseHeldBacklogCount,
  listConversations,
  logBehavior,
  runChatAutoCasePermitEval,
  sendChatAutoCaseHeldBacklogNow,
  setChatAutoCasePermitArming,
  updateAutoReply,
  type AutoRule,
  type BehaviorLogPayload,
  type ChatAutoCaseCommittedSendRow,
  type ChatAutoCasebookPendingBreakdown,
  type ChatAutoCasebookPendingStatus,
  type ChatAutoCasebookReplyLink,
  type ChatAutoCasebookSnapshotEnvelope,
  type ChatAutoCasebookReplyText,
  type ChatAutoCasebookSnapshotRow,
  type ChatAutoNeedsReviewCandidate,
  type SendChatAutoCaseHeldBacklogNowEnvelope,
} from "@/lib/data";
import { fetchSavedReplyPreview, type SavedReplyPreviewState } from "./savedReplyPreview";
import { useRole } from "@/lib/role";
import { permitManageRoleGate } from "@/lib/permitRoleGate";
import { useViewAs } from "@/lib/viewAs";
import {
  CASEBOOK_DEFAULT_FILTER,
  CASEBOOK_ITEMS_NO_REPLY_NEEDED,
  breakdownEquation,
  normalizeCasebookRowExtras,
  normalizePendingBreakdown,
  normalizeReplyLinkCatalog,
  pendingCountLabel,
  pendingDisplayKind,
  replyNeededHeadline,
  type CasebookInboxFilter,
  type PendingDisplayKind,
} from "@/lib/casebookInbox";
import { CaseItemsPanel } from "./CaseItemsPanel";
import { ReviewBoardPanel } from "./ReviewBoardPanel";
import { PermitCasePanel } from "./PermitCasePanel";

import { callableBusinessErrorCode, publicCallableErrorMessage, useLive, useLiveAutoReply } from "@/lib/live";

// 자동발송 대상 대화 확인은 한 페이지 조회로 끝낸다. 더 있으면 그 사실을 화면에 밝힌다.
const ARMED_SCAN_LIMIT = 200;
const CANDIDATE_SCAN_LIMIT = 50;

// ── 인라인 Toggle 컴포넌트 ─────────────────────────────────
function Toggle({ on, onToggle, disabled = false }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className={[
        "relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
        on ? "bg-accent" : "bg-fill-3",
      ].join(" ")}
    >
      <span
        className={[
          "pointer-events-none absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-200",
          on ? "translate-x-[19px]" : "translate-x-[3px]",
        ].join(" ")}
      />
    </button>
  );
}

// ── 페이지 ────────────────────────────────────────────────
export default function AutoReplyPage() {
  const autoReplyList = useLiveAutoReply<typeof AUTO_REPLY>([]);
  const { data: liveData } = useLive();
  const livePartialLoadError = liveData?.partialLoadError ?? "";
  // 2026-09-07 프로드 Aside 실측: 프로드 auto_reply/default 는 픽스처 표식(source "mvp-live-test")이라
  // 운영 읽기에서 숨겨져 0행이 오는데, 화면은 "불러오는 중"을 90초 넘게 그대로 보여줬다.
  // "아직 로드 전"과 "로드됐는데 문서 없음"을 구분한다.
  const autoReplyLoaded = Boolean(liveData?.loadedKeys?.includes("autoReply"));
  const { role } = useRole();
  const { isViewingAs: viewAsFlagActive, target: viewAsTarget, stopViewAs } = useViewAs();
  // A stored preview is already known before RoleProvider resolves the caller. Never
  // mount a self-scope reader during that guest-to-super-admin initialization gap.
  const isViewingAs = viewAsFlagActive;
  const autoReply = autoReplyList[0];
  const [masterOn, setMasterOn] = useState(false);
  const [ruleStates, setRuleStates] = useState<Record<string, boolean>>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [countingArmed, setCountingArmed] = useState(false);
  const [armedPreflight, setArmedPreflight] = useState<{ armed: number; scanned: number; truncated: boolean } | null>(null);
  const settingsWriteRef = useRef(false);
  const armedCountRef = useRef(false);
  const confirmedSettingsRef = useRef<{ enabled: boolean; rules: Record<string, boolean> } | null>(null);
  const canChangeSettings = permitManageRoleGate(role) && !isViewingAs && Boolean(autoReply) && confirmedSettingsRef.current !== null;
  const settingsControlsDisabled = !canChangeSettings || saving || countingArmed || Boolean(armedPreflight);
  const canManagePermits = permitManageRoleGate(role) && !isViewingAs;
  const canManageOperatorOverride = role === "super_admin" && !isViewingAs;
  const canEditCaseReplies = (role === "admin" || role === "super_admin") && !isViewingAs;
  const canSuggestCaseReplies = permitManageRoleGate(role) && !isViewingAs;

  async function returnToOwnAccount() {
    if (!isViewingAs || !viewAsTarget) return;
    const endedTarget = viewAsTarget;
    stopViewAs();
    try {
      await logBehavior({
        action: `viewAs.end(${endedTarget.userId})`,
        gameId: "global",
        result: "success",
        costKRW: 0,
        time: new Date().toISOString(),
      } as BehaviorLogPayload);
    } catch {
      // Returning to the real account must not depend on the audit service being available.
    }
  }

  useEffect(() => {
    if (!autoReply || settingsWriteRef.current) return;
    confirmedSettingsRef.current = {
      enabled: autoReply.enabled,
      rules: Object.fromEntries(autoReply.rules.map((r) => [r.id, r.enabled])),
    };
    setMasterOn(autoReply.enabled);
    setRuleStates(Object.fromEntries(autoReply.rules.map((r) => [r.id, r.enabled])));
  }, [autoReply]);

  async function persist(nextEnabled: boolean, nextRuleStates: Record<string, boolean>) {
    if (!autoReply || !canChangeSettings || settingsWriteRef.current) return;
    settingsWriteRef.current = true;
    const previous = confirmedSettingsRef.current ?? {
      enabled: autoReply.enabled,
      rules: Object.fromEntries(autoReply.rules.map((r) => [r.id, r.enabled])),
    };
    setSaving(true);
    setError("");
    try {
      await updateAutoReply({
        enabled: nextEnabled,
        model: autoReply.model,
        tone: autoReply.tone,
        workingHours: autoReply.workingHours,
        rules: autoReply.rules.map((rule) => ({ ...rule, enabled: nextRuleStates[rule.id] ?? rule.enabled })),
      });
      confirmedSettingsRef.current = { enabled: nextEnabled, rules: { ...nextRuleStates } };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "자동응답 설정 저장에 실패했습니다.");
      setMasterOn(previous.enabled);
      setRuleStates(previous.rules);
    } finally {
      settingsWriteRef.current = false;
      setSaving(false);
    }
  }

  // 전역 스위치를 켜는 순간, OFF 기간에 만들어졌거나 운영자가 개별로 켜 둔 대화가 한꺼번에
  // 자동응답 사정권에 들어간다(대화별 스위치와 전역 게이트는 분리 저장 — 발사 시점 AND 판정).
  // 그래서 켜기 전에 대상 대화 수를 실제로 세어 보여주고, 그 수를 본 뒤에만 켠다.
  async function countArmedConversations(): Promise<{ armed: number; scanned: number; truncated: boolean }> {
    const page = await listConversations({ limit: ARMED_SCAN_LIMIT });
    const rows = page.rows ?? [];
    const armed = rows.filter((row) => (row as { aiActive?: unknown }).aiActive !== false).length;
    return { armed, scanned: rows.length, truncated: Boolean(page.pageInfo?.truncated) };
  }

  const toggleMaster = () => {
    if (!canChangeSettings || settingsWriteRef.current || armedCountRef.current || armedPreflight) return;
    const next = !masterOn;
    if (!next) {
      setMasterOn(false);
      setArmedPreflight(null);
      void persist(false, ruleStates);
      return;
    }
    setError("");
    armedCountRef.current = true;
    setCountingArmed(true);
    void countArmedConversations()
      .then((result) => setArmedPreflight(result))
      .catch((caught) => setError(caught instanceof Error ? caught.message : "자동발송 대상 대화 수를 확인하지 못했습니다."))
      .finally(() => {
        armedCountRef.current = false;
        setCountingArmed(false);
      });
  };

  const confirmMasterOn = () => {
    if (!canChangeSettings || settingsWriteRef.current || armedCountRef.current || !armedPreflight) return;
    setArmedPreflight(null);
    setMasterOn(true);
    void persist(true, ruleStates);
  };

  const toggleRule = (id: string) => {
    if (!canChangeSettings || settingsWriteRef.current || armedCountRef.current || armedPreflight) return;
    const next = { ...ruleStates, [id]: !ruleStates[id] };
    setRuleStates(next);
    void persist(masterOn, next);
  };

  return (
    <div className="mx-auto max-w-content px-6 py-7">
      <PageHeader
        title="AI 자동응답 설정"
        desc="가이드 범위 내 회신을 AI가 자동 처리 — 경계는 비용 가이드 기준"
      />

      {/* MASTER 카드 */}
      <Card className="mb-4">
        <div className="px-5 py-4">
          {/* 마스터 토글 행 */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Toggle on={masterOn} onToggle={toggleMaster} disabled={settingsControlsDisabled} />
              <span className="text-[15px] font-bold text-ink">AI 자동응답</span>
            </div>
            <span
              className={[
                "text-sm font-semibold",
                masterOn ? "text-ok" : "text-ink-3",
              ].join(" ")}
            >
              {!autoReply ? "확인 불가" : masterOn ? "켜짐" : "꺼짐"}
            </span>
          </div>

          {/* 키-값 칩 행 */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Chip label="처리 방식" value={autoReply?.model ? "내부 Gateway" : "—"} />
            <Chip label="톤" value={autoReply?.tone ?? "—"} />
            <Chip label="응답 시간" value={autoReply?.workingHours ?? "—"} />
          </div>
        </div>
      </Card>

      {/* INFO 배너 */}
      <div className="mb-5 rounded-md border border-info/20 bg-info-soft p-3 text-sm text-ink-2">
        단가 자동/사람 개입 경계는{" "}
        <Link
          href={externalFluHref("/flu/cost-guide")}
          className="font-medium text-accent underline underline-offset-2 hover:opacity-80"
        >
          비용 가이드
        </Link>
        에서 관리합니다.
      </div>
      {countingArmed && <div className="mb-3 text-xs font-medium text-accent">자동발송 대상 대화 수 확인 중</div>}
      {armedPreflight && (
        <div data-testid="auto-reply-arm-preflight" className="mb-3 rounded-md border border-warn/30 bg-warn-soft p-3 text-sm text-ink-2">
          <div className="font-semibold text-warn">
            전역 자동응답을 켜면 지금 대화별 자동응답이 켜진 대화 {armedPreflight.armed}건이 함께 대상에 들어갑니다.
          </div>
          <div className="mt-1 text-xs text-ink-3">
            최근 대화 {armedPreflight.scanned}건을 확인한 결과입니다{armedPreflight.truncated ? " (더 있는 경우 이 수보다 많습니다)" : ""}.
            개별 대화 스위치는 각 대화 헤더에서 끌 수 있습니다.
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={confirmMasterOn}
              disabled={!canChangeSettings || saving || countingArmed}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white"
            >
              확인하고 켜기
            </button>
            <button
              type="button"
              onClick={() => setArmedPreflight(null)}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink-2"
            >
              취소
            </button>
          </div>
        </div>
      )}
      {saving && <div className="mb-3 text-xs font-medium text-accent">설정 저장 중</div>}
      {error && <div role="alert" data-testid="auto-reply-settings-error" className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}
      {isViewingAs ? <div className="mb-3 rounded-md border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-ink-2">대신 보기 중에는 자동응답 설정을 변경할 수 없고, 아래 케이스북 콘솔은 사용할 수 없습니다.</div> : null}

      {/* 자동화 규칙 카드 */}
      <Card>
        <CardHeader title="자동화 규칙" />
        <div>
          {(autoReply?.rules ?? []).map((rule: AutoRule) => (
            <div
              key={rule.id}
              className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-0"
            >
              <Toggle
                on={ruleStates[rule.id]}
                onToggle={() => toggleRule(rule.id)}
                disabled={settingsControlsDisabled}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">{rule.label}</div>
                <div className="mt-0.5 text-xs text-ink-3">{rule.desc}</div>
              </div>
              <div className="shrink-0">
                {rule.scope === "ai" ? (
                  <Badge tone="ai">AI 자동</Badge>
                ) : (
                  <Badge tone="warn">사람 개입</Badge>
                )}
              </div>
            </div>
          ))}
          {autoReply && autoReply.rules.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-ink-3" data-testid="auto-reply-rules-unconfigured">
              등록된 추가 자동화 규칙이 없습니다. 케이스별 자동발송은 아래에서 관리합니다.
            </div>
          ) : null}
          {!autoReply && (
            <div className="px-5 py-8 text-center text-sm text-ink-4" data-testid="auto-reply-rules-empty-state">
              {livePartialLoadError
                ? `자동응답 설정을 불러오지 못했습니다. ${livePartialLoadError}`
                : autoReplyLoaded
                  ? "자동응답 설정이 아직 없습니다. 실제 자동발송 상태는 운영 설정과 아래 케이스별 승인 상태를 확인하세요."
                  : "자동응답 설정 데이터를 불러오는 중입니다."}
            </div>
          )}
        </div>
      </Card>

      {/* Casebook 콘솔 (2026-09-28, "simplify in place" 방향 전환, 헤세 승인): 대신 보기 중에는
          이 콘솔 전체(대기 헤드라인 + 케이스별 자동발송 + 검토 후보)를 완전히 막는다. 이 콘솔의
          데이터는 scp 권한이 있는 모든 운영자에게 프로그램 전체 기준으로 동일하므로, 대신 보기는
          "이 사람이 권한이 있는가"라는 이진 사실만 미리 볼 수 있을 뿐이다 — 다섯 라운드의 리뷰 중
          세 라운드가 대신 보기 스코프 상태 결함이었다. 서버도 이 콘솔의 유일한 읽기 콜러블
          (getChatAutoCasebookSnapshot)에 대한 대신 보기 신원 페이로드를 거부한다
          (functions/chatAutoCasePermitCallables.ts 참고) — 이 블록은 그 사실을 보여주는 UI일 뿐,
          단독 방어선이 아니다. */}
      {isViewingAs ? (
        <div
          className="mt-6 rounded-md border border-line bg-fill px-5 py-10 text-center text-sm text-ink-3"
          data-testid="casebook-view-as-blocked"
        >
          <p>다른 사용자로 보기 중에는 사용할 수 없음</p>
          <p className="mt-2">본인 슈퍼어드민 화면으로 돌아가면 자동응답 설정과 케이스북을 관리할 수 있습니다.</p>
          <button
            type="button"
            onClick={() => void returnToOwnAccount()}
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            내 슈퍼어드민 화면으로 돌아가기
          </button>
        </div>
      ) : role === "guest" ? (
        <p className="mt-6 py-10 text-center text-sm text-ink-3" role="status" data-testid="casebook-permissions-pending">
          자동응답 관리 권한을 확인하는 중입니다.
        </p>
      ) : (
        <CasebookSection
          canManagePermits={canManagePermits}
          canManageOperatorOverride={canManageOperatorOverride}
          canEditCaseReplies={canEditCaseReplies}
          canSuggestCaseReplies={canSuggestCaseReplies}
        />
      )}
    </div>
  );
}

// codex+devin 방향 리뷰 합의(2026-09-28): 케이스별 자동발송/대기 헤드라인을 하나의
// getChatAutoCasebookSnapshot 읽기로 통합했다. 대신 보기가 이 콘솔에서 완전히 막혀 있으므로(위
// AutoReplyPage 참고) round 4~5의 스코프-키 기반 리마운트 장치는 더 이상 필요하지 않다 — 이
// 컴포넌트는 언제나 운영자 자신의 단일 스코프만 본다.
//
// codex adversarial review round 7 (2026-09-28): "검토 후보"(listConversations 기반, 케이스북
// 이전부터 있던 별개 패널)의 상태/조회 effect를 AutoReplyPage에서 여기로 옮겼다 — 이전에는
// AutoReplyPage에 무조건 걸려 있어 대신 보기로 이 콘솔 전체가 막혀 있는 동안에도 그 조회 하나는
// 계속 나갔다(화면에는 안 보여도 네트워크 요청은 살아있었다). 이 컴포넌트로 옮기면 대신 보기 중엔
// 마운트 자체가 안 되므로 조회도 같이 막힌다 — getChatAutoCasebookSnapshot 하나만 쓴다는 계약과는
// 별개의, 명시적으로 분리된 두 번째 읽기임을 유지하되 같은 차단 규칙을 적용한다.
function CasebookSection({
  canManagePermits,
  canManageOperatorOverride,
  canEditCaseReplies,
  canSuggestCaseReplies,
}: {
  canManagePermits: boolean;
  canManageOperatorOverride: boolean;
  canEditCaseReplies: boolean;
  canSuggestCaseReplies: boolean;
}) {
  const sectionActiveRef = useRef(true);
  useEffect(() => {
    sectionActiveRef.current = true;
    return () => {
      sectionActiveRef.current = false;
    };
  }, []);
  const [candidateError, setCandidateError] = useState("");
  const [candidateConversations, setCandidateConversations] = useState<CandidateConversation[]>([]);

  useEffect(() => {
    let active = true;
    setCandidateError("");
    void listConversations({ limit: CANDIDATE_SCAN_LIMIT })
      .then((conversations) => {
        if (!active) return;
        setCandidateConversations(
          (conversations.rows ?? [])
            .map(candidateConversationFromRecord)
            .filter((row): row is CandidateConversation => Boolean(row)),
        );
      })
      .catch(() => {
        if (!active) return;
        setCandidateConversations([]);
        setCandidateError("검토 후보를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, []);

  const [rows, setRows] = useState<ChatAutoCasebookSnapshotRow[]>([]);
  const [pendingTotal, setPendingTotal] = useState<{
    count: number;
    truncated: boolean;
    status: ChatAutoCasebookPendingStatus;
    computedAtIso: string | null;
    exact: boolean;
    countStatus: "exact" | "lower_bound" | "unknown";
    asOfIso: string | null;
  }>({ count: 0, truncated: false, status: "missing", computedAtIso: null, exact: false, countStatus: "unknown", asOfIso: null });
  const [unclassifiedPendingCount, setUnclassifiedPendingCount] = useState(0);
  // Casebook inbox (2026-10-01): optional snapshot additions — absent from an older server.
  const [pendingBreakdown, setPendingBreakdown] = useState<ChatAutoCasebookPendingBreakdown | undefined>(undefined);
  const [replyLinkCatalog, setReplyLinkCatalog] = useState<ChatAutoCasebookReplyLink[] | undefined>(undefined);
  // View-only filter: never sent to the server, so changing it can never change what is armed/sent.
  const [inboxFilter, setInboxFilter] = useState<CasebookInboxFilter>(CASEBOOK_DEFAULT_FILTER);
  // Cases whose reply editor is open or holds unsaved text — kept visible whatever the filter says.
  const [engagedEditorIds, setEngagedEditorIds] = useState<Record<string, true>>({});
  const handleEditorEngagedChange = (caseId: string, engaged: boolean) => {
    setEngagedEditorIds((current) => {
      if (engaged) return current[caseId] ? current : { ...current, [caseId]: true };
      if (!current[caseId]) return current;
      const next = { ...current };
      delete next[caseId];
      return next;
    });
  };
  const [loading, setLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState("");
  const [actionBusyKey, setActionBusyKey] = useState("");
  const permitActionRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  // Keyed by caseId + saved-reply revisionHash + eval runId (overrideConfirmKey): any change to the saved reply or
  // the eval invalidates a previous confirmation, so it can never carry over to a different revision.
  const [overrideConfirmed, setOverrideConfirmed] = useState<Record<string, boolean>>({});
  // Server-resolved final outgoing body of each saved reply (the dispatch resolver, via the read-only preview callable).
  const [savedReplyPreviews, setSavedReplyPreviews] = useState<Record<string, SavedReplyPreviewState>>({});
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedSends, setSelectedSends] = useState<ChatAutoCaseCommittedSendRow[] | null>(null);
  const [sendsLoading, setSendsLoading] = useState(false);
  const [sendsError, setSendsError] = useState("");
  // codex adversarial review round 7 (2026-09-28): rapidly selecting case A then case B can let
  // A's getChatAutoCasebookSnapshot({selectedCaseId: "A"}) response resolve AFTER B's — applying it
  // unconditionally would paint A's confirmed sends under B's row. Kept in sync SYNCHRONOUSLY with
  // selectedCaseId (set directly in selectCase below, never via a passive effect — see the
  // round 4/5 lesson elsewhere in this codebase about effect-timing races) so applySnapshot always
  // compares against what the user is ACTUALLY looking at right now, regardless of which call
  // (selectCase's own fetch, or reloadSnapshot after an arm/eval/override mutation) produced the
  // response.
  const selectedCaseIdRef = useRef<string | null>(null);

  const applySnapshot = (snapshot: ChatAutoCasebookSnapshotEnvelope) => {
    setRows((snapshot.rows ?? []).map(normalizeSnapshotRow));
    setPendingTotal(
      snapshot.pendingTotal ?? { count: 0, truncated: false, status: "missing", computedAtIso: null, exact: false, countStatus: "unknown", asOfIso: null },
    );
    setUnclassifiedPendingCount(numberValue(snapshot.unclassifiedPendingCount));
    setPendingBreakdown(normalizePendingBreakdown(snapshot.pendingBreakdown));
    setReplyLinkCatalog(normalizeReplyLinkCatalog(snapshot.replyLinkCatalog));
    if (snapshot.selected && snapshot.selected.caseId === selectedCaseIdRef.current) {
      setSelectedSends(snapshot.selected.sends ?? []);
    }
  };

  useEffect(() => {
    let active = true;
    void getChatAutoCasebookSnapshot({})
      .then((snapshot) => {
        if (!active) return;
        applySnapshot(snapshot);
      })
      .catch(() => {
        if (!active) return;
        setSnapshotError("케이스북 스냅샷을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadSnapshot = async () => {
    const snapshot = await getChatAutoCasebookSnapshot(selectedCaseId ? { selectedCaseId } : {});
    if (sectionActiveRef.current) applySnapshot(snapshot);
  };

  const reloadCaseReply = async (caseId: string): Promise<ChatAutoCasebookReplyText | null> => {
    const snapshot = await getChatAutoCasebookSnapshot(selectedCaseId ? { selectedCaseId } : {});
    if (!sectionActiveRef.current) return null;
    applySnapshot(snapshot);
    // Same normalization as applySnapshot's rows, so the editor never receives a raw/partial replyText.
    const row = (snapshot.rows ?? []).find((candidate) => candidate.caseId === caseId);
    return row ? normalizeSnapshotRow(row).replyText : null;
  };

  // codex adversarial review round 7 (2026-09-28): a monotonic request id, bumped synchronously
  // (not via a passive effect) every time the selection changes — discards a stale request's
  // loading/error/data outcome outright when a newer selection has since superseded it, rather
  // than relying solely on the selectedCaseIdRef check in applySnapshot above (which only guards
  // the `selected` payload, not this call's own loading/error indicators).
  const selectCaseRequestRef = useRef(0);

  const selectCase = (caseId: string) => {
    const next = selectedCaseId === caseId ? null : caseId;
    setSelectedCaseId(next);
    selectedCaseIdRef.current = next;
    setSendsError("");
    selectCaseRequestRef.current += 1;
    const requestId = selectCaseRequestRef.current;
    if (!next) {
      setSelectedSends(null);
      return;
    }
    setSendsLoading(true);
    setSelectedSends(null);
    void getChatAutoCasebookSnapshot({ selectedCaseId: next })
      .then((snapshot) => {
        if (requestId !== selectCaseRequestRef.current) return;
        applySnapshot(snapshot);
      })
      .catch(() => {
        if (requestId !== selectCaseRequestRef.current) return;
        setSendsError("최근 발송 내역을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (requestId !== selectCaseRequestRef.current) return;
        setSendsLoading(false);
      });
  };

  // "보류 N건 지금 보내기" (case-backlog-send, 2026-09-28) — lazy per-case count/send, mirroring the
  // selectCase pattern above: state is non-null only for the ONE currently-expanded armed case,
  // never fetched (getChatAutoCaseHeldBacklogCount) for every row at once.
  const [backlogSendCaseId, setBacklogSendCaseId] = useState<string | null>(null);
  const [backlogSendHeldCount, setBacklogSendHeldCount] = useState<number | null>(null);
  const [backlogSendScanCap, setBacklogSendScanCap] = useState(0);
  const [backlogSendScannedCapped, setBacklogSendScannedCapped] = useState(false);
  const [backlogSendCountLoading, setBacklogSendCountLoading] = useState(false);
  const [backlogSendCountError, setBacklogSendCountError] = useState("");
  const [backlogSendConfirming, setBacklogSendConfirming] = useState(false);
  // [codex review round 9, 2026-09-28] keyed BY caseId (not a single shared boolean) — a global busy
  // flag left the button permanently disabled after collapsing/switching away from a case mid-send:
  // the in-flight response's `.finally()` used to bail out via the "still viewing this case" guard
  // (backlogSendCaseIdRef), which meant it never cleared the flag, so re-expanding that SAME case
  // later showed it as still busy forever, and a DIFFERENT case's send could be blocked by a stale
  // flag from a case the user is no longer even looking at. Each case's own entry is cleared in its
  // own `.finally()` UNCONDITIONALLY (see runBacklogSend below) — never gated on which case is
  // currently expanded — so a late response after collapse/switch always self-heals.
  const [backlogSendBusyByCase, setBacklogSendBusyByCase] = useState<Record<string, boolean>>({});
  const [backlogSendError, setBacklogSendError] = useState("");
  const [backlogSendResult, setBacklogSendResult] = useState<SendChatAutoCaseHeldBacklogNowEnvelope | null>(null);
  // Guards a still-in-flight count/send response from painting over a DIFFERENT case's state after
  // the user collapses/switches the expanded row mid-request — same lesson as selectedCaseIdRef.
  const backlogSendCaseIdRef = useRef<string | null>(null);
  const backlogSendCountRequestRef = useRef(0);

  const toggleBacklogSend = (caseId: string) => {
    const next = backlogSendCaseId === caseId ? null : caseId;
    setBacklogSendCaseId(next);
    backlogSendCaseIdRef.current = next;
    setBacklogSendConfirming(false);
    setBacklogSendError("");
    setBacklogSendResult(null);
    backlogSendCountRequestRef.current += 1;
    const requestId = backlogSendCountRequestRef.current;
    if (!next) {
      setBacklogSendHeldCount(null);
      setBacklogSendCountError("");
      return;
    }
    setBacklogSendHeldCount(null);
    setBacklogSendCountError("");
    setBacklogSendCountLoading(true);
    void getChatAutoCaseHeldBacklogCount({ caseId: next })
      .then((result) => {
        if (requestId !== backlogSendCountRequestRef.current) return;
        setBacklogSendHeldCount(result.heldCount);
        setBacklogSendScanCap(result.scanCap);
        setBacklogSendScannedCapped(result.scannedCapped);
      })
      .catch(() => {
        if (requestId !== backlogSendCountRequestRef.current) return;
        setBacklogSendCountError("보류 건수를 확인하지 못했습니다.");
      })
      .finally(() => {
        if (requestId !== backlogSendCountRequestRef.current) return;
        setBacklogSendCountLoading(false);
      });
  };

  const requestBacklogSend = (caseId: string) => {
    if (!canManagePermits || backlogSendCaseId !== caseId) return;
    setBacklogSendError("");
    setBacklogSendResult(null);
    setBacklogSendConfirming(true);
  };

  const cancelBacklogSend = (caseId: string) => {
    if (backlogSendCaseId !== caseId) return;
    setBacklogSendConfirming(false);
  };

  const runBacklogSend = (caseId: string, cursor?: string) => {
    if (!canManagePermits || backlogSendCaseId !== caseId || backlogSendBusyByCase[caseId]) return;
    setBacklogSendBusyByCase((current) => ({ ...current, [caseId]: true }));
    setBacklogSendError("");
    setBacklogSendConfirming(false);
    void sendChatAutoCaseHeldBacklogNow({ caseId, ...(cursor ? { cursor } : {}) })
      .then((result) => {
        if (backlogSendCaseIdRef.current !== caseId) return;
        setBacklogSendResult(result);
        // Sending changes both the program-wide pending headline and this case's own held count —
        // refresh both, best-effort (a refresh failure must never hide the send result itself).
        void reloadSnapshot().catch(() => undefined);
        void getChatAutoCaseHeldBacklogCount({ caseId })
          .then((countResult) => {
            if (backlogSendCaseIdRef.current !== caseId) return;
            setBacklogSendHeldCount(countResult.heldCount);
            setBacklogSendScanCap(countResult.scanCap);
            setBacklogSendScannedCapped(countResult.scannedCapped);
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (backlogSendCaseIdRef.current !== caseId) return;
        setBacklogSendError("보류 발송 처리에 실패했습니다.");
      })
      .finally(() => {
        // UNCONDITIONAL — never gated on backlogSendCaseIdRef. This case's own busy flag must clear
        // the moment ITS OWN request settles, regardless of whether the user has since collapsed
        // this row or switched to viewing a different case (see the state's own doc comment above).
        setBacklogSendBusyByCase((current) => {
          if (!(caseId in current)) return current;
          const next = { ...current };
          delete next[caseId];
          return next;
        });
      });
  };

  const confirmBacklogSend = (caseId: string) => runBacklogSend(caseId);
  const continueBacklogSend = (caseId: string) => runBacklogSend(caseId, backlogSendResult?.nextCursor ?? undefined);

  const handlePermitAction = (row: ChatAutoCasebookSnapshotRow, action: "arm" | "disarm" | "eval") => {
    if (!canManagePermits || permitActionRef.current) return;
    if (action !== "disarm" && row.replyText.state !== "auto_ok") return;
    // A saved (operator-edited) reply is armed only through the super_admin override card below.
    if (action === "arm" && row.replyText.source === "operator_override") return;
    permitActionRef.current = true;
    setActionError("");
    setActionBusyKey(`${row.caseId}:${action}`);
    const request = action === "eval"
      ? runChatAutoCasePermitEval({
        caseIds: [row.caseId],
        confirm: `RUN_CHAT_AUTO_CASE_PERMIT_EVAL:${row.caseId}`,
        bypassGatewayCache: true,
      })
      : setChatAutoCasePermitArming({
        caseId: row.caseId,
        action,
        expectedCasebookHash: row.pins.casebookHash,
        expectedModelVersion: row.pins.modelVersion,
        expectedEvalRunId: row.eval.runId ?? undefined,
        expectedCounterFloor: 20,
      });

    void request
      .then(() => reloadSnapshot().catch(() => undefined))
      .catch((caught) => {
        setActionError(callableBusinessErrorCode(caught) ? publicCallableErrorMessage(caught) : "케이스별 자동발송 작업이 실패했습니다.");
      })
      .finally(() => {
        permitActionRef.current = false;
        setActionBusyKey("");
      });
  };

  const handleOperatorOverride = (row: ChatAutoCasebookSnapshotRow) => {
    if (!canManageOperatorOverride || permitActionRef.current || !isOperatorOverrideEligible(row)) return;
    const reason = (overrideReasons[row.caseId] ?? "").trim();
    const confirmKey = overrideConfirmKey(row);
    const savedReply = row.replyText.source === "operator_override";
    if (!overrideConfirmed[confirmKey] || reason.length < 10 || reason.length > 300 || !row.eval.runId) return;
    if (savedReply && (!row.replyText.revisionHash || savedReplyPreviews[confirmKey]?.state !== "ok")) return;
    permitActionRef.current = true;
    setActionError("");
    setActionBusyKey(`${row.caseId}:override`);
    void setChatAutoCasePermitArming({
      caseId: row.caseId,
      action: "arm",
      expectedCasebookHash: row.pins.casebookHash,
      expectedModelVersion: row.pins.modelVersion,
      expectedEvalRunId: row.eval.runId,
      expectedCounterFloor: 20,
      operatorOverride: true,
      overrideReason: reason,
      ...(savedReply ? { expectedReplyRevisionHash: row.replyText.revisionHash } : {}),
    })
      .then(() => {
        setOverrideConfirmed((current) => ({ ...current, [confirmKey]: false }));
        return reloadSnapshot();
      })
      .catch((caught) => {
        setActionError(callableBusinessErrorCode(caught) ? publicCallableErrorMessage(caught) : "운영자 예외 승인에 실패했습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.");
      })
      .finally(() => {
        permitActionRef.current = false;
        setActionBusyKey("");
      });
  };

  // Fetch the server-resolved outgoing body for every saved reply shown in the override card.
  const savedReplyPreviewTargets = canManageOperatorOverride
    ? rows.filter((row) => isOperatorOverrideEligible(row) && row.replyText.source === "operator_override" && row.replyText.text)
    : [];
  const savedReplyPreviewSignature = savedReplyPreviewTargets.map(overrideConfirmKey).join("|");
  useEffect(() => {
    for (const row of savedReplyPreviewTargets) {
      const key = overrideConfirmKey(row);
      if (savedReplyPreviews[key]) continue;
      setSavedReplyPreviews((current) => ({ ...current, [key]: { state: "loading", text: "" } }));
      void fetchSavedReplyPreview(row.caseId, row.replyText.text ?? "").then((next) => {
        setSavedReplyPreviews((current) => ({ ...current, [key]: next }));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedReplyPreviewSignature]);

  const pendingKind = pendingDisplayKind(pendingTotal);
  const breakdownAvailable = pendingBreakdown?.status === "available" ? pendingBreakdown : null;
  const pendingAsOfIso = pendingTotal.asOfIso ?? pendingTotal.computedAtIso;

  return (
    <>
      <PendingHeadlineCard
        count={pendingTotal.count}
        kind={pendingKind}
        status={pendingTotal.status}
        computedAtIso={pendingAsOfIso}
        unclassifiedCount={unclassifiedPendingCount}
        breakdown={breakdownAvailable}
        loading={loading}
        error={snapshotError}
      />
      {/* 검토 보드 (2026-10-05): read-only, above the existing case cards; existing panels unchanged. */}
      <ReviewBoardPanel pendingTotalLabel={loading ? null : pendingCountLabel(pendingKind, pendingTotal.count)} />
      <PermitCasePanel
        rows={rows}
        loading={loading}
        error={snapshotError}
        candidateError={candidateError}
        canManage={canManagePermits}
        canEditReplies={canEditCaseReplies}
        canSuggestReplies={canSuggestCaseReplies}
        actionBusyKey={actionBusyKey}
        actionError={actionError}
        candidateConversations={candidateConversations}
        onAction={handlePermitAction}
        selected={selectedCaseId ? { caseId: selectedCaseId, sends: selectedSends, loading: sendsLoading, error: sendsError } : null}
        onSelectCase={selectCase}
        onReloadReply={reloadCaseReply}
        onSavedReply={reloadSnapshot}
        pendingKind={pendingKind}
        pendingStatus={pendingTotal.status}
        pendingTotalCount={pendingTotal.count}
        filter={inboxFilter}
        onFilterChange={setInboxFilter}
        // Rendered whenever the backlog is non-zero OR not yet a proven number (집계 중/집계 전/하한)
        // — an unknown 미분류 count is never hidden; only a known FRESH 0 without a breakdown drops it.
        unclassified={breakdownAvailable || unclassifiedPendingCount > 0 || pendingKind !== "exact" || pendingTotal.status !== "fresh"
          ? {
            count: breakdownAvailable ? breakdownAvailable.unclassified.total : unclassifiedPendingCount,
            byReason: breakdownAvailable ? breakdownAvailable.unclassified.byReason : null,
            legacyCount: breakdownAvailable?.unclassified.neverClassifiedBeforeStampLaunch ?? null,
            asOfLabel: formatPendingComputedAt(pendingAsOfIso),
          }
          : null}
        pinnedKeys={new Set(Object.keys(engagedEditorIds))}
        onEditorEngagedChange={handleEditorEngagedChange}
        replyLinkCatalog={replyLinkCatalog}
        backlogSend={backlogSendCaseId ? {
          caseId: backlogSendCaseId,
          heldCount: backlogSendHeldCount,
          scanCap: backlogSendScanCap,
          scannedCapped: backlogSendScannedCapped,
          countLoading: backlogSendCountLoading,
          countError: backlogSendCountError,
          confirming: backlogSendConfirming,
          sendBusy: Boolean(backlogSendBusyByCase[backlogSendCaseId]),
          sendError: backlogSendError,
          result: backlogSendResult,
        } : null}
        onToggleBacklogSend={toggleBacklogSend}
        onRequestBacklogSend={requestBacklogSend}
        onCancelBacklogSend={cancelBacklogSend}
        onConfirmBacklogSend={confirmBacklogSend}
        onContinueBacklogSend={continueBacklogSend}
      />
      {canManageOperatorOverride ? (
        <Card className="mt-4" data-testid="permit-operator-override">
          <CardHeader
            title="운영자 예외 승인"
            desc="최신 검증을 통과했지만 승인 발송 수가 부족한 auto_ok 케이스에 한해, 수량 기준만 예외로 승인합니다. 운영자가 저장한 답신은 이 승인으로만 켤 수 있으며, 저장한 문구가 그대로 자동발송됩니다. 메일함 자동답장 허용 목록과는 별개입니다."
            action={<Badge tone="warn">super_admin 전용</Badge>}
          />
          <div className="divide-y divide-line">
            {rows.filter(isOperatorOverrideEligible).map((row) => {
              const reason = overrideReasons[row.caseId] ?? "";
              const confirmKey = overrideConfirmKey(row);
              const confirmed = overrideConfirmed[confirmKey] === true;
              const preview = savedReplyPreviews[confirmKey];
              const busy = actionBusyKey === `${row.caseId}:override`;
              const reasonValid = reason.trim().length >= 10 && reason.trim().length <= 300;
              const savedReply = row.replyText.source === "operator_override";
              return (
                <div key={row.caseId} className="px-5 py-4" data-testid={`permit-operator-override-${row.caseId}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-ink">{row.caseTitle || row.caseId}</div>
                      <div className="mt-1 text-xs text-ink-3">케이스 {row.caseId} · 승인 발송 {row.counters.consecutiveHumanUneditedApprovedSent}/{row.counterFloor} · 최신 검증 통과 · {formatPermitExpiry(row.eval.expiresAtIso)}까지</div>
                    </div>
                    <Badge tone="warn">{savedReply ? "저장 답신 · 수량 기준 예외" : "수량 기준 예외"}</Badge>
                  </div>
                  {savedReply ? (
                    <div className="mt-3" data-testid={`permit-operator-override-saved-${row.caseId}`}>
                      <p className="text-xs font-semibold text-warn">승인하면 아래 최종 본문(서버가 링크·정본 요율 문장까지 풀어 낸 실제 발송 내용)이 그대로 자동발송됩니다. (정본 템플릿이 아닙니다)</p>
                      <p className="mt-1 whitespace-pre-line rounded-md border border-line bg-fill px-3 py-2 text-xs text-ink-2" data-testid={`permit-operator-override-saved-text-${row.caseId}`}>
                        {preview?.state === "ok" ? preview.text : preview?.state === "error" ? `최종 본문을 만들 수 없어 승인할 수 없습니다.${preview.text ? ` (${preview.text})` : ""}` : "최종 본문을 불러오는 중…"}
                      </p>
                    </div>
                  ) : null}
                  <label className="mt-3 block text-xs font-semibold text-ink-2">
                    예외 승인 사유 (10–300자)
                    <textarea
                      value={reason}
                      maxLength={300}
                      onChange={(event) => setOverrideReasons((current) => ({ ...current, [row.caseId]: event.target.value }))}
                      placeholder="이번 케이스의 수량 기준을 예외로 승인하는 운영 판단을 남겨 주세요."
                      className="mt-1.5 w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
                      rows={2}
                    />
                  </label>
                  <label className="mt-3 flex items-start gap-2 text-xs text-ink-2">
                    <input type="checkbox" checked={confirmed} disabled={savedReply && preview?.state !== "ok"} onChange={(event) => setOverrideConfirmed((current) => ({ ...current, [confirmKey]: event.target.checked }))} className="mt-0.5 h-4 w-4 rounded border-line text-accent focus:ring-accent" />
                    <span>{savedReply
                      ? "위 저장 문구가 사람 검토 없이 그대로 자동발송됨을 확인했습니다. 최신 통과 검증과 현재 핀(저장 revision 포함)은 서버가 다시 확인하며, 저장하거나 되돌리면 승인은 해제됩니다."
                      : "최신 통과 검증과 현재 핀은 서버가 다시 확인하며, 이 작업은 발송 수 기준만 예외로 승인함을 확인했습니다."}</span>
                  </label>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-[11px] text-ink-4">{reason.trim().length}/300자</span>
                    <button
                      type="button"
                      disabled={actionBusyKey.length > 0 || !confirmed || !reasonValid}
                      onClick={() => handleOperatorOverride(row)}
                      className="rounded-md bg-warn px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy ? "승인 중" : savedReply ? "저장 답신을 수량 기준 예외로 자동발송 켜기" : "수량 기준 예외로 자동발송 켜기"}
                    </button>
                  </div>
                </div>
              );
            })}
            {rows.filter(isOperatorOverrideEligible).length === 0 ? <div className="px-5 py-5 text-sm text-ink-3">현재 예외 승인 조건을 모두 충족한 케이스가 없습니다.</div> : null}
          </div>
        </Card>
      ) : null}
    </>
  );
}

// Count reads are cache-only. Display integers only for a completed full scan;
// incomplete/legacy snapshots never prove an exact zero. Keep the cached as-of time visible.
function PendingHeadlineCard({
  count,
  kind,
  status,
  computedAtIso,
  unclassifiedCount,
  breakdown,
  loading,
  error,
}: {
  count: number;
  kind: PendingDisplayKind;
  status: ChatAutoCasebookPendingStatus;
  computedAtIso: string | null;
  unclassifiedCount: number;
  breakdown: ChatAutoCasebookPendingBreakdown | null;
  loading: boolean;
  error: string;
}) {
  const equation = kind === "exact" ? breakdownEquation(count, breakdown) : null;
  // 0.6.105: "답장 필요 N건" (N = 전체 − 답장 불필요) only over a consistent exact breakdown of a FRESH
  // snapshot; a stale one keeps the plain total headline (with its stale label) below. The total is
  // never rewritten — it stays in the explanation line.
  const replyNeeded = equation && equation.consistent ? replyNeededHeadline(count, kind, status, breakdown) : null;
  return (
    <Card className="mt-4" data-testid="pending-headline-card">
      <CardHeader
        title="대기 중인 문의"
        desc="마지막 전체 집계 기준의 대기 대화 수입니다. 이후의 새 메일과 발송은 다음 집계에 반영됩니다."
      />
      {loading ? (
        <div className="px-5 py-8 text-sm text-ink-3" role="status">
          대기 건수를 불러오는 중입니다.
        </div>
      ) : null}
      {error ? (
        <div className="border-b border-danger/20 bg-danger-soft px-5 py-3 text-sm font-semibold text-danger" role="alert">
          {error}
        </div>
      ) : null}
      {!loading && !error && (kind === "missing" || kind === "computing") ? (
        <div className="px-5 py-8 text-sm text-ink-3" data-testid="pending-headline-computing">
          전체 건수를 집계하고 있습니다. 완료된 집계가 저장되면 정확한 숫자를 표시합니다.
        </div>
      ) : null}
      {/* A capped scan only proves a floor: show it as "N건 이상", never as an exact-looking number. */}
      {!loading && !error && kind === "lower_bound" ? (
        <div className="px-5 py-6" data-testid="pending-headline-lower-bound">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-4xl font-bold tabular-nums text-ink" data-testid="pending-headline-lower-bound-count">
              {count}
            </span>
            <span className="text-sm text-ink-3">건 이상 대기 중</span>
          </div>
          <div className="mt-2 text-xs text-warn">
            집계가 일부만 끝나 실제 건수는 더 많을 수 있습니다. 전체 집계가 완료되면 정확한 숫자와 구성을 표시합니다.
          </div>
          <div className="mt-2 text-xs text-ink-4" data-testid="pending-headline-computed-at">
            {formatPendingComputedAt(computedAtIso)}{status === "stale" ? " · 최신 집계 지연 중" : ""}
          </div>
        </div>
      ) : null}
      {!loading && !error && kind === "exact" ? (
        <div className="px-5 py-6">
          {replyNeeded ? (
            <>
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-sm font-semibold text-ink-2">답장 필요</span>
                <span className="text-4xl font-bold tabular-nums text-ink" data-testid="pending-headline-reply-needed-count">
                  {replyNeeded.replyNeeded}
                </span>
                <span className="text-sm text-ink-3">건</span>
              </div>
              <div className="mt-2 text-sm text-ink-2" data-testid="pending-no-reply-equation">
                전체 대기 {replyNeeded.total}건 = 답장 필요 {replyNeeded.replyNeeded}건 + 답장 불필요 {replyNeeded.noReplyNeeded}건
                {replyNeeded.parts.length > 0
                  ? ` (${replyNeeded.parts.map((part) => `${part.label} ${part.count}`).join(" · ")})`
                  : ""}
              </div>
              {/* 답장 불필요 묶음의 실제 건 (부재중 + 종결 인사) — N 은 위 식의 답장 불필요 건수. */}
              {replyNeeded.noReplyNeeded > 0 ? (
                <CaseItemsPanel
                  caseId={CASEBOOK_ITEMS_NO_REPLY_NEEDED}
                  count={replyNeeded.noReplyNeeded}
                  kind={kind}
                  testId="case-items-no-reply-needed"
                />
              ) : null}
            </>
          ) : (
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-4xl font-bold tabular-nums text-ink" data-testid="pending-headline-count">
                {count}
              </span>
              <span className="text-sm text-ink-3">건 대기 중</span>
              {equation ? null : unclassifiedPendingCountLabel(unclassifiedCount)}
            </div>
          )}
          {equation && equation.consistent ? (
            <div className="mt-2 text-sm text-ink-2" data-testid="pending-breakdown-equation">
              전체 대기 {equation.total}건 = 케이스 {equation.managed}건 + 미분류 {equation.unclassified}건
              {equation.closed > 0 ? ` (+ 종결 ${equation.closed}건)` : ""}
            </div>
          ) : null}
          {equation && !equation.consistent ? (
            <div className="mt-2 text-xs text-warn" data-testid="pending-breakdown-mismatch">
              구성: 케이스 {equation.managed}건 · 미분류 {equation.unclassified}건 · 종결 {equation.closed}건 — 합계 {equation.sum}건이
              전체 {equation.total}건과 달라, 다음 집계 뒤에 다시 확인합니다.
            </div>
          ) : null}
          <div className="mt-2 text-xs text-ink-4" data-testid="pending-headline-computed-at">
            {formatPendingComputedAt(computedAtIso)}{status === "stale" ? " · 최신 집계 지연 중" : ""}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function formatPendingComputedAt(computedAtIso: string | null): string {
  if (!computedAtIso) return "계산 시각 확인 필요";
  const computedAtMs = Date.parse(computedAtIso);
  if (Number.isNaN(computedAtMs)) return "계산 시각 확인 필요";
  const minutesAgo = Math.max(0, Math.round((Date.now() - computedAtMs) / 60000));
  const relative = minutesAgo <= 0 ? "방금 전" : `${minutesAgo}분 전`;
  return `${relative} 기준 (${new Date(computedAtIso).toLocaleTimeString("ko-KR")})`;
}

function unclassifiedPendingCountLabel(unclassifiedCount: number) {
  if (unclassifiedCount <= 0) return null;
  return <span className="text-xs text-ink-3">(미분류 {unclassifiedCount}건 포함)</span>;
}

// ── 키-값 칩 (로컬 헬퍼) ──────────────────────────────────
function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-line bg-fill px-2.5 py-1.5 text-xs">
      <span className="font-medium text-ink-3">{label}</span>
      <span className="text-ink-2">{value}</span>
    </div>
  );
}

type CandidateConversation = {
  conversationId: string;
  title: string;
  candidates: ChatAutoNeedsReviewCandidate[];
  permitDenyReasons: string[];
  clampReasonIds: string[];
  autoRepliedCaseIds: string[];
};

function normalizeSnapshotRow(row: ChatAutoCasebookSnapshotRow): ChatAutoCasebookSnapshotRow {
  return {
    ...row,
    caseDescription: stringValue(row.caseDescription),
    state: row.state ?? "default_off",
    armed: row.armed === true,
    counterFloor: 20,
    counters: {
      consecutiveHumanUneditedApprovedSent: numberValue(row.counters?.consecutiveHumanUneditedApprovedSent),
      totalHumanUneditedApprovedSent: numberValue(row.counters?.totalHumanUneditedApprovedSent),
      unavailableEvidenceCount: numberValue(row.counters?.unavailableEvidenceCount),
    },
    pins: {
      casebookHash: stringValue(row.pins?.casebookHash),
      casebookMatchesCurrent: row.pins?.casebookMatchesCurrent === true,
      modelVersion: stringValue(row.pins?.modelVersion),
      modelMatchesCurrent: row.pins?.modelMatchesCurrent === true,
    },
    eval: {
      status: row.eval?.status ?? "missing",
      runId: nullableString(row.eval?.runId),
      evaluatedAtIso: nullableString(row.eval?.evaluatedAtIso),
      expiresAtIso: nullableString(row.eval?.expiresAtIso),
      heldoutTotal: numberValue(row.eval?.heldoutTotal),
      heldoutPassed: numberValue(row.eval?.heldoutPassed),
      rerollTotal: numberValue(row.eval?.rerollTotal),
      rerollStable: numberValue(row.eval?.rerollStable),
      transports: stringArray(row.eval?.transports),
      estimatedCostUsd: numberValue(row.eval?.estimatedCostUsd),
    },
    lastDisarmReason: nullableString(row.lastDisarmReason),
    caseCandidates: sanitizeCandidates(row.caseCandidates),
    replyText: {
      state: row.replyText?.state === "auto_ok"
        || row.replyText?.state === "needs_review"
        || row.replyText?.state === "non_auto_ok"
        ? row.replyText.state
        : "unavailable",
      text: nullableString(row.replyText?.text),
      label: nullableString(row.replyText?.label),
      source: row.replyText?.source === "static" || row.replyText?.source === "operator_override"
        ? row.replyText.source
        : "none",
      editable: row.replyText?.editable === true,
      suggestionAllowed: row.replyText?.suggestionAllowed === true,
      revision: numberValue(row.replyText?.revision),
      revisionHash: stringValue(row.replyText?.revisionHash),
      casebookHash: stringValue(row.replyText?.casebookHash),
      unavailableReason: nullableString(row.replyText?.unavailableReason),
      reviewRequired: row.replyText?.reviewRequired === true,
      automaticStatus: row.replyText?.automaticStatus === "blocked"
        || row.replyText?.automaticStatus === "permit_gated"
        || row.replyText?.automaticStatus === "no_reply"
        ? row.replyText.automaticStatus
        : "human_review_only",
    },
    pendingCount: numberValue(row.pendingCount),
    ...normalizeCasebookRowExtras(row),
  };
}

function overrideConfirmKey(row: ChatAutoCasebookSnapshotRow): string {
  return `${row.caseId}:${row.replyText.revisionHash}:${row.eval.runId ?? ""}`;
}

function isOperatorOverrideEligible(row: ChatAutoCasebookSnapshotRow): boolean {
  const expiresAt = row.eval.expiresAtIso ? Date.parse(row.eval.expiresAtIso) : Number.NaN;
  return !row.armed
    && row.replyText.state === "auto_ok"
    // A saved reply is armable ONLY through this override path (the normal arm button is disabled for it), so it
    //   stays eligible whatever the counter is — otherwise it would lose every arm path once the counter reaches 20.
    && (row.replyText.source === "operator_override" || row.counters.consecutiveHumanUneditedApprovedSent < row.counterFloor)
    && row.eval.status === "passed"
    && Boolean(row.eval.runId)
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
    && row.pins.casebookMatchesCurrent
    && row.pins.modelMatchesCurrent
    && row.eval.transports.length > 0;
}

function formatPermitExpiry(value: string | null): string {
  if (!value) return "만료 시각 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "만료 시각 확인 필요" : date.toLocaleString("ko-KR");
}

function candidateConversationFromRecord(record: Record<string, unknown>): CandidateConversation | null {
  const candidates = sanitizeCandidates(record.caseCandidates);
  if (candidates.length === 0) return null;
  const conversationId = stringValue(record.id || record.conversationId);
  if (!conversationId) return null;
  return {
    conversationId,
    title: stringValue(record.creatorName || record.creatorDisplayName || record.title || record.subject) || conversationId,
    candidates,
    permitDenyReasons: stringArray(record.permitDenyReasons),
    clampReasonIds: stringArray(record.clampReasonIds),
    autoRepliedCaseIds: stringArray(record.autoRepliedCaseIds),
  };
}

function sanitizeCandidates(value: unknown): ChatAutoNeedsReviewCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).map((item) => {
    const record = recordValue(item);
    return {
      caseId: stringValue(record.caseId),
      title: stringValue(record.title),
      reasonCode: stringValue(record.reasonCode),
      clampReasonIds: stringArray(record.clampReasonIds),
    };
  }).filter((item) => item.caseId && item.title && item.reasonCode);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
