"use client";

// Tier-A shell + seven-tab router for the creator Management detail
// (.specs/spec_creator_management_profile_tabs/spec.md §3, §4). The header/Now-strip render
// immediately and independently of every tab (Tier A never waits on Tier B/C sources). Each tab lazy-
// loads on first visit via the bounded `manageProfileTab<Tab>List` callables in
// `@/lib/managementTabsData`; switching the selected enrollment remounts the whole tab-content subtree
// (`key={selectedEnrollmentId}`) so a previous enrollment's rows can never flash under the new scope
// (spec §4.1: "이전 scope 결과를 잠시라도 새 scope 아래 표시하지 않습니다").
import { useEffect, useState, type ReactNode } from "react";
import { Tabs } from "@/components/ui/Tabs";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { Alert, Refresh } from "@/components/icons";
import { useRole } from "@/lib/role";
import { useViewAs } from "@/lib/viewAs";
import {
  DEFAULT_MANAGEMENT_TAB,
  MANAGEMENT_TAB_KEYS,
  getManagementApplicationsList,
  getManagementAuditList,
  getManagementChannelIntelligenceList,
  getManagementContentReviewList,
  getManagementJourneyList,
  getManagementOnboardingList,
  getManagementOutreachList,
  normalizeManagementTabKey,
  type ApplicationManagementProjection,
  type AuditEventRow,
  type ChannelActivityRow,
  type JourneyEvent,
  type ManagementTabKey,
  type OnboardingStepRow,
  type OutreachActivityRow,
  type VideoRevisionProjection,
} from "@/lib/managementTabsData";
import { ManagementProfileHeader, type ManagementHeaderIdentity, type ManagementPartnerLink } from "./ManagementProfileHeader";
import { ManagementNowStrip, type ManagementEnrollmentOption } from "./ManagementNowStrip";
import { ManagementJourneyTab } from "./ManagementJourneyTab";
import { ManagementOutreachTab } from "./ManagementOutreachTab";
import { ManagementApplicationsTab } from "./ManagementApplicationsTab";
import { ManagementOnboardingTab } from "./ManagementOnboardingTab";
import { ManagementContentReviewTab } from "./ManagementContentReviewTab";
import { ManagementChannelIntelligenceTab } from "./ManagementChannelIntelligenceTab";
import { ManagementAuditTab } from "./ManagementAuditTab";

const TAB_LABELS: Record<ManagementTabKey, string> = {
  journey: "Journey",
  outreach: "아웃리치",
  applications: "지원서",
  onboarding: "온보딩",
  "content-review": "콘텐츠·검수",
  "channel-intelligence": "채널 정보",
  audit: "감사",
};

interface TabLoadState<T> {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  rows: T[];
  errorMessage?: string;
}

const IDLE: TabLoadState<never> = { status: "idle", rows: [] };

export interface ManagementCurrentAction {
  stateLabel: string;
  stateLoading?: boolean;
  actionLabel: string;
  actionHref?: string;
  actionEta?: string;
  blockerLabel?: string;
  freshnessLabel?: string;
  conflict?: boolean;
}

export function ManagementProfileShell({
  fluCreatorId,
  identity,
  active,
  currentAction,
  enrollments,
  selectedEnrollmentId,
  onSelectEnrollment,
  activeTab,
  onTabChange,
  partnerLink,
}: {
  fluCreatorId: string;
  identity: ManagementHeaderIdentity;
  active: boolean;
  currentAction: ManagementCurrentAction;
  enrollments: ManagementEnrollmentOption[];
  selectedEnrollmentId: string | null;
  onSelectEnrollment: (enrollmentId: string) => void;
  activeTab: ManagementTabKey;
  onTabChange: (tab: ManagementTabKey) => void;
  partnerLink?: ManagementPartnerLink;
}) {
  const tabs = MANAGEMENT_TAB_KEYS.map((key) => ({ key, label: TAB_LABELS[key] }));
  const selected = enrollments.find((e) => e.enrollmentId === selectedEnrollmentId) ?? null;
  // Flu conversation org-filter round 16 (codex adversarial review round 16, finding #3): without
  // this, the journey tab's conversation-outreach reader always evaluated the REAL caller's own
  // scp scope — a super_admin previewing a restricted member (viewAs) saw the super_admin's own
  // unrestricted scp visibility instead of that member's real (possibly denied) scope. Same
  // isViewingAs/viewAsParams pattern as src/app/(app)/chat/receipts/page.tsx's listMailOutbox
  // wiring (round 6, finding #4).
  const { role } = useRole();
  const { target: viewAsTarget, isViewingAs: viewAsFlagActive } = useViewAs();
  const isViewingAs = role === "super_admin" && viewAsFlagActive;
  const viewAsScope = isViewingAs && viewAsTarget
    ? { viewAsUserId: viewAsTarget.userId, viewAsEmail: viewAsTarget.email }
    : {};
  const viewAsScopeKey = isViewingAs && viewAsTarget ? `${viewAsTarget.userId}:${viewAsTarget.email}` : "self";

  return (
    <div className="flex flex-col gap-3" data-testid="management-profile-shell">
      <ManagementProfileHeader identity={identity} active={active} partnerLink={partnerLink} />

      <ManagementNowStrip
        stateLabel={currentAction.stateLabel}
        stateLoading={currentAction.stateLoading}
        actionLabel={currentAction.actionLabel}
        actionHref={currentAction.actionHref}
        actionEta={currentAction.actionEta}
        blockerLabel={currentAction.blockerLabel}
        freshnessLabel={currentAction.freshnessLabel}
        conflict={currentAction.conflict}
        enrollments={enrollments}
        selectedEnrollmentId={selectedEnrollmentId}
        onSelectEnrollment={onSelectEnrollment}
      />

      <div className="mt-2" role="tablist">
        <Tabs tabs={tabs} value={activeTab} onChange={(key) => onTabChange(normalizeManagementTabKey(key))} />
      </div>

      {/* Remounting on enrollment OR viewAs-target change guarantees no stale-scope flash: every lazy
          tab's local state starts fresh under the new key instead of carrying over the previous
          enrollment's (or the previous viewer's) rows. */}
      <ManagementTabsPanel
        key={`${selectedEnrollmentId ?? "unselected"}:${viewAsScopeKey}`}
        fluCreatorId={fluCreatorId}
        programId={selected?.programId ?? null}
        campaignId={selected?.campaignId}
        enrollmentId={selectedEnrollmentId}
        queryEnrollmentId={selected?.queryEnrollmentId}
        activeTab={activeTab}
        partnerLink={partnerLink}
        programLabel={selected?.programLabel}
        campaignLabel={selected?.campaignLabel}
        viewAsScope={viewAsScope}
      />
    </div>
  );
}

function ManagementTabsPanel({
  fluCreatorId,
  programId,
  campaignId,
  enrollmentId,
  queryEnrollmentId,
  activeTab,
  partnerLink,
  programLabel,
  campaignLabel,
  viewAsScope,
}: {
  fluCreatorId: string;
  programId: string | null;
  campaignId?: string;
  enrollmentId: string | null;
  // Real Portal v3 enrollmentId to narrow the query scope with — distinct from `enrollmentId`, which is
  // only the selector's React/remount key and may be a synthetic per-program value when no verified v3
  // enrollment identity is available yet (see ManagementEnrollmentOption).
  queryEnrollmentId?: string;
  activeTab: ManagementTabKey;
  partnerLink?: ManagementPartnerLink;
  programLabel?: string;
  campaignLabel?: string;
  // Flu conversation org-filter round 16 (codex adversarial review round 16, finding #3): forwarded
  // straight into every tab callable's request scope — see ManagementProfileShell's own comment.
  viewAsScope: { viewAsUserId?: string; viewAsEmail?: string };
}) {
  const [journey, setJourney] = useState<TabLoadState<JourneyEvent>>(IDLE);
  const [outreach, setOutreach] = useState<TabLoadState<OutreachActivityRow>>(IDLE);
  const [applications, setApplications] = useState<TabLoadState<ApplicationManagementProjection>>(IDLE);
  const [onboarding, setOnboarding] = useState<TabLoadState<OnboardingStepRow>>(IDLE);
  const [contentReview, setContentReview] = useState<TabLoadState<VideoRevisionProjection>>(IDLE);
  const [channelIntelligence, setChannelIntelligence] = useState<TabLoadState<ChannelActivityRow>>(IDLE);
  const [audit, setAudit] = useState<TabLoadState<AuditEventRow>>(IDLE);
  const [retryToken, setRetryToken] = useState(0);

  const scope = programId
    ? { fluCreatorId, programId, campaignId, enrollmentId: queryEnrollmentId, ...viewAsScope }
    : null;

  useEffect(() => {
    let cancelled = false;
    let requestStarted = false;
    if (!scope) return () => {
      cancelled = true;
    };
    if (activeTab === "journey" && journey.status === "idle") {
      requestStarted = true;
      setJourney({ status: "loading", rows: [] });
      getManagementJourneyList(scope)
        .then((page) => {
          if (cancelled) return;
          setJourney({ status: page.rows.length === 0 ? "empty" : "ready", rows: page.rows });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setJourney({ status: "error", rows: [], errorMessage: err instanceof Error ? err.message : "조회 실패" });
        });
    }
    if (activeTab === "outreach" && outreach.status === "idle") {
      requestStarted = true;
      setOutreach({ status: "loading", rows: [] });
      getManagementOutreachList(scope)
        .then((page) => {
          if (cancelled) return;
          setOutreach({ status: page.rows.length === 0 ? "empty" : "ready", rows: page.rows });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setOutreach({ status: "error", rows: [], errorMessage: err instanceof Error ? err.message : "조회 실패" });
        });
    }
    if (activeTab === "applications" && applications.status === "idle") {
      requestStarted = true;
      setApplications({ status: "loading", rows: [] });
      getManagementApplicationsList(scope)
        .then((page) => {
          if (cancelled) return;
          setApplications({ status: page.rows.length === 0 ? "empty" : "ready", rows: page.rows });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setApplications({ status: "error", rows: [], errorMessage: err instanceof Error ? err.message : "조회 실패" });
        });
    }
    if (activeTab === "onboarding" && onboarding.status === "idle") {
      requestStarted = true;
      setOnboarding({ status: "loading", rows: [] });
      getManagementOnboardingList(scope)
        .then((page) => {
          if (cancelled) return;
          setOnboarding({ status: page.rows.length === 0 ? "empty" : "ready", rows: page.rows });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setOnboarding({ status: "error", rows: [], errorMessage: err instanceof Error ? err.message : "조회 실패" });
        });
    }
    if (activeTab === "content-review" && contentReview.status === "idle") {
      requestStarted = true;
      setContentReview({ status: "loading", rows: [] });
      getManagementContentReviewList(scope)
        .then((page) => {
          if (cancelled) return;
          setContentReview({ status: page.rows.length === 0 ? "empty" : "ready", rows: page.rows });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setContentReview({ status: "error", rows: [], errorMessage: err instanceof Error ? err.message : "조회 실패" });
        });
    }
    if (activeTab === "channel-intelligence" && channelIntelligence.status === "idle") {
      requestStarted = true;
      setChannelIntelligence({ status: "loading", rows: [] });
      getManagementChannelIntelligenceList(scope)
        .then((page) => {
          if (cancelled) return;
          setChannelIntelligence({ status: page.rows.length === 0 ? "empty" : "ready", rows: page.rows });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setChannelIntelligence({ status: "error", rows: [], errorMessage: err instanceof Error ? err.message : "조회 실패" });
        });
    }
    if (activeTab === "audit" && audit.status === "idle") {
      requestStarted = true;
      setAudit({ status: "loading", rows: [] });
      getManagementAuditList(scope)
        .then((page) => {
          if (cancelled) return;
          setAudit({ status: page.rows.length === 0 ? "empty" : "ready", rows: page.rows });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setAudit({ status: "error", rows: [], errorMessage: err instanceof Error ? err.message : "조회 실패" });
        });
    }
    return () => {
      cancelled = true;
      if (!requestStarted) return;
      if (activeTab === "journey") setJourney((state) => state.status === "loading" ? IDLE : state);
      if (activeTab === "outreach") setOutreach((state) => state.status === "loading" ? IDLE : state);
      if (activeTab === "applications") setApplications((state) => state.status === "loading" ? IDLE : state);
      if (activeTab === "onboarding") setOnboarding((state) => state.status === "loading" ? IDLE : state);
      if (activeTab === "content-review") setContentReview((state) => state.status === "loading" ? IDLE : state);
      if (activeTab === "channel-intelligence") setChannelIntelligence((state) => state.status === "loading" ? IDLE : state);
      if (activeTab === "audit") setAudit((state) => state.status === "loading" ? IDLE : state);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, retryToken, fluCreatorId, programId, campaignId, queryEnrollmentId]);

  if (!programId || !scope) {
    return (
      <div className="rounded-xl border border-line bg-paper px-5 py-8 text-center text-sm text-ink-4">
        프로그램을 선택하세요
      </div>
    );
  }

  function retry(tab: ManagementTabKey) {
    if (tab === "journey") setJourney(IDLE);
    if (tab === "outreach") setOutreach(IDLE);
    if (tab === "applications") setApplications(IDLE);
    if (tab === "onboarding") setOnboarding(IDLE);
    if (tab === "content-review") setContentReview(IDLE);
    if (tab === "channel-intelligence") setChannelIntelligence(IDLE);
    if (tab === "audit") setAudit(IDLE);
    setRetryToken((token) => token + 1);
  }

  function renderTabState<T>(state: TabLoadState<T>, tab: ManagementTabKey, renderReady: (rows: T[]) => React.ReactNode) {
    if (state.status === "idle" || state.status === "loading") {
      return (
        <div className="rounded-xl border border-line bg-paper px-5 py-8">
          <LoadingStatus>불러오는 중</LoadingStatus>
        </div>
      );
    }
    if (state.status === "error") {
      return (
        <div role="alert" className="flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger-soft px-5 py-5 text-sm text-danger">
          <div className="flex items-center gap-2 font-semibold">
            <Alert className="h-4 w-4" aria-hidden="true" />
            <span>{state.errorMessage ?? "이 영역을 불러오지 못했습니다"}</span>
          </div>
          <button
            type="button"
            onClick={() => retry(tab)}
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-danger/30 bg-paper px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger-soft"
          >
            <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
            재시도
          </button>
        </div>
      );
    }
    return renderReady(state.rows);
  }

  return (
    <div role="tabpanel" data-testid={`management-tabpanel-${activeTab}`}>
      {activeTab === "journey"
        ? renderTabState(journey, "journey", (rows) => (
            <ManagementJourneyTab events={rows} programLabel={programLabel} campaignLabel={campaignLabel} />
          ))
        : null}
      {activeTab === "outreach" ? renderTabState(outreach, "outreach", (rows) => <ManagementOutreachTab rows={rows} />) : null}
      {activeTab === "applications"
        ? renderTabState(applications, "applications", (rows) => (
            // W7-1e: Journey 탭에만 넘기던 스코프 라벨을 지원서 탭에도 넘긴다(한 줄 배선 갭).
            // 같은 스코프 안에서 program/campaign 은 동일하고(management-enrollment-scopes),
            // 라벨이 없으면 탭이 원래대로 raw id 를 보여준다.
            <ManagementApplicationsTab applications={rows} programLabel={programLabel} campaignLabel={campaignLabel} />
          ))
        : null}
      {activeTab === "onboarding" ? renderTabState(onboarding, "onboarding", (rows) => <ManagementOnboardingTab steps={rows} />) : null}
      {activeTab === "content-review"
        ? renderTabState(contentReview, "content-review", (rows) => (
            <ManagementContentReviewTab revisions={rows} enrollmentId={queryEnrollmentId ?? partnerLink?.enrollmentId} />
          ))
        : null}
      {activeTab === "channel-intelligence"
        ? renderTabState(channelIntelligence, "channel-intelligence", (rows) => <ManagementChannelIntelligenceTab rows={rows} />)
        : null}
      {activeTab === "audit" ? renderTabState(audit, "audit", (rows) => <ManagementAuditTab events={rows} />) : null}
    </div>
  );
}

export { DEFAULT_MANAGEMENT_TAB };
