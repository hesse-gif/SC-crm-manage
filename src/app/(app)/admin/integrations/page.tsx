"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  attestMailProviderSubject,
  beginMailOAuth,
  CANONICAL_OPERATIONAL_MAILBOX,
  diagnoseMailTransport,
  getCaptchaSolverIntegration,
  getIntegrations,
  getMailBackfillStatus,
  getMailOAuthStatus,
  getMailProviderAttestationStatus,
  getMyOrgContext,
  getOrgTabPresets,
  getPeoplyStatus,
  getYouTubeAuthorizationStatus,
  listMailAccounts,
  revokeMailOAuth,
  revokeMailProviderSubject,
  searchPeoplyDirectory,
  setCaptchaSolverIntegration,
  setMailRouting,
  setOrgTabPresets,
  startMailBackfill,
  updateIntegration,
  upsertMailAccount,
  type CaptchaSolverIntegration,
  type DiagnoseMailTransportEnvelope,
  type GetIntegrationsEnvelope,
  type GetMailOAuthStatusEnvelope,
  type GetPeoplyStatusEnvelope,
  type IntegrationPayload,
  type IntegrationSummary,
  type MailAccountKind,
  type MailAccountPublic,
  type MailAccountStatus,
  type MailBackfillJob,
  type MailBackfillJobStatus,
  type MailProviderAttestationProjection,
  type MailProviderAttestationStatus,
  type MailRouting,
  type MailTransportProbeLane,
  type MailTransportProbeStatus,
  type MyOrgContextEnvelope,
  type PeoplyDirectoryItem,
  type PeoplyErrorKind,
  type PeoplyOrganization,
  type PeoplyPerson,
  type PeoplySearchKind,
  type PeoplyWorkspaceGroup,
  type SearchPeoplyDirectoryEnvelope,
  type UpsertMailAccountPayload,
  type YouTubeAuthorizationConnection,
  type YouTubeAuthorizationStatus,
  type YouTubeAuthorizationStatusEnvelope,
} from "@/lib/data";
import { FLU_NAV } from "@/lib/nav";
import { filterOrgsByQuery, type OrgSearchMatch } from "@/lib/orgSearchFilter";
import { defaultMailSender, mailSenderDisplayName, mailSenderPolicyMessage, usableMailSenders } from "@/lib/mail-sender-policy";
import { invalidateOrgContextCache } from "@/lib/org-context-cache";
import { useAuthProfile, useRole } from "@/lib/role";

type IntegrationKey = IntegrationPayload["key"];

type FieldDef = { name: string; label: string; placeholder: string };
type Definition = {
  key: IntegrationKey;
  title: string;
  desc: string;
  fields: FieldDef[];
  secret: string;
  secretLabel: string;
  hint: string;
};

type Draft = {
  publicValues: Record<string, string>;
  secret: string;
};

type MailAction = "refresh" | "attest" | "revoke";
type Notice = { tone: "success" | "error"; message: string };
type MailOAuthCompanionFallback = { accountId: string; consentUrl: string };
type DiagnosticTokenEvidence = {
  checkedAtIso: string;
  expiresAtIso: string;
  fingerprintPrefix: string;
};

const CHALLENGE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const DEFINITIONS: Definition[] = [
  {
    key: "mailSmtp",
    title: "메일 SMTP",
    desc: "실발송 계정·보안·워밍업 상한",
    fields: [
      { name: "host", label: "Host", placeholder: "smtp.supercent.io" },
      { name: "port", label: "Port", placeholder: "587" },
      { name: "secure", label: "TLS", placeholder: "true / false" },
      { name: "username", label: "User", placeholder: "smtp-user" },
      { name: "fromAddress", label: "From", placeholder: "no-reply@supercent.io" },
      { name: "warmupDailyLimit", label: "Warmup", placeholder: "50" },
    ],
    secret: "password",
    secretLabel: "SMTP 비밀번호",
    hint: "저장된 SMTP 비밀번호 없음 — 아래에서 설정하세요",
  },
  {
    key: "mailImap",
    title: "메일 IMAP",
    desc: "회신·바운스 수신함 라우팅",
    fields: [
      { name: "host", label: "Host", placeholder: "imap.supercent.io" },
      { name: "port", label: "Port", placeholder: "993" },
      { name: "secure", label: "TLS", placeholder: "true / false" },
      { name: "username", label: "User", placeholder: "imap-user" },
      { name: "mailbox", label: "수신함", placeholder: "INBOX" },
      { name: "bounceMailbox", label: "Bounce", placeholder: "bounces@supercent.io" },
    ],
    secret: "password",
    secretLabel: "IMAP 비밀번호",
    hint: "저장된 IMAP 비밀번호 없음 — 아래에서 설정하세요",
  },
  {
    key: "gateway",
    title: "외부 AI Gateway",
    desc: "AI 처리는 Gateway 경유, 캐시 선행",
    fields: [
      { name: "endpoint", label: "Endpoint", placeholder: "https://gateway.example/v1/chat" },
      { name: "model", label: "Route", placeholder: "default-low-cost" },
      { name: "dailyBudgetKRW", label: "Budget", placeholder: "50000" },
      { name: "timeoutMs", label: "Timeout", placeholder: "20000" },
    ],
    secret: "apiKey",
    secretLabel: "Gateway API 키",
    hint: "저장된 Gateway API 키 없음 — 아래에서 설정하세요",
  },
  {
    key: "externalApi",
    title: "외부 API",
    desc: "YouTube·Revi·이메일 파인더와 외부 권한 콜백 추적",
    fields: [
      { name: "youtubeProject", label: "YT Project", placeholder: "flu-discovery" },
      { name: "quotaDaily", label: "Quota", placeholder: "10000" },
      { name: "youtubeAuthToolName", label: "Auth tool", placeholder: "external-youtube-auth" },
      { name: "youtubeAuthPolicyVersion", label: "Auth policy", placeholder: "youtube-external-auth-v1" },
      { name: "youtubeAuthMode", label: "Auth mode", placeholder: "external_api_login" },
      { name: "youtubeAuthCallbackEnabled", label: "Callback", placeholder: "true / false" },
      { name: "emailFinderEndpoint", label: "Email API", placeholder: "https://finder.example/search" },
      { name: "reviEndpoint", label: "Revi API", placeholder: "https://revi.example" },
    ],
    secret: "youtubeApiKey",
    secretLabel: "YouTube API 키",
    hint: "저장된 YouTube·이메일 파인더·Revi API 키 없음 — 아래에서 설정하세요",
  },
  {
    key: "aiHub",
    title: "AI Hub",
    desc: "프로젝트·지역·캐시 TTL·endpoint 런타임 설정",
    fields: [
      { name: "projectId", label: "Project", placeholder: "flu-aihub" },
      { name: "region", label: "Region", placeholder: "asia-northeast3" },
      { name: "cacheTtlMinutes", label: "Cache TTL", placeholder: "60" },
      { name: "endpoint", label: "Endpoint", placeholder: "https://aihub.example/fine-tune" },
    ],
    secret: "projectKey",
    secretLabel: "AI Hub 프로젝트 키",
    hint: "저장된 AI Hub 프로젝트 키 없음 — 아래에서 설정하세요",
  },
];

// 0.6.73 Aside 핫픽스 — 조직 허용목록류 카드(개인 메일 연결 허용·Chat 기본 보기·scp 배정 허용)
// 공용 "대기 목록" 스테이징. 검색 결과 클릭/제거 버튼은 더 이상 즉시 콜러블을 호출하지 않고 이
// pending 상태에만 쌓인다 — 실제 저장은 카드의 "저장" 버튼 → confirm() 이후에만 일어난다(기존
// applyXChange의 낙관적 업데이트·롤백 로직은 그대로 두고, 호출 시점만 저장 버튼으로 옮긴다).
type OrgAllowlistPending = { add: string[]; remove: string[] };
const EMPTY_ORG_ALLOWLIST_PENDING: OrgAllowlistPending = { add: [], remove: [] };

function orgAllowlistPendingCount(pending: OrgAllowlistPending): number {
  return pending.add.length + pending.remove.length;
}

// pendingRemove에 든 조직은 저장 전까지 목록에서 "삭제 예정"으로 계속 보여야(실행 취소 가능) 하므로
// committed에서 걸러내지 않는다 — 실제로 저장될 다음 값을 계산할 때만 걸러낸다(아래 참조).
function nextOrgIdsAfterAllowlistPending(committed: string[], pending: OrgAllowlistPending): string[] {
  const removeSet = new Set(pending.remove);
  const kept = committed.filter((id) => !removeSet.has(id));
  const added = pending.add.filter((id) => !kept.includes(id));
  return [...kept, ...added];
}

function orgAllowlistConfirmMessage(
  cardTitle: string,
  pending: OrgAllowlistPending,
  orgDirectory: Record<string, string>,
  impactNote?: string,
): string {
  const nameOf = (id: string) => orgDirectory[id] ?? id;
  const lines = [`${cardTitle} 변경 사항을 저장합니다.`];
  if (pending.add.length > 0) lines.push(`추가: ${pending.add.map(nameOf).join(", ")}`);
  if (pending.remove.length > 0) lines.push(`삭제: ${pending.remove.map(nameOf).join(", ")}`);
  if (impactNote) lines.push(impactNote);
  lines.push("계속할까요?");
  return lines.join("\n\n");
}

export default function IntegrationsPage() {
  const { role: currentRole } = useRole();
  const { email: currentEmail } = useAuthProfile();
  const isSuperAdmin = currentRole === "super_admin";
  const [items, setItems] = useState<IntegrationSummary[]>([]);
  const [mode, setMode] = useState<string>("확인 중");
  const [runtimeMode, setRuntimeMode] = useState<GetIntegrationsEnvelope["runtimeMode"]>();
  const [capabilities, setCapabilities] = useState<GetIntegrationsEnvelope["capabilities"]>();
  const [drafts, setDrafts] = useState<Record<IntegrationKey, Draft>>(() => Object.fromEntries(
    DEFINITIONS.map((item) => [item.key, { publicValues: {}, secret: "" }]),
  ) as Record<IntegrationKey, Draft>);
  const [pending, setPending] = useState<IntegrationKey | null>(null);
  const [editing, setEditing] = useState<IntegrationKey | null>(null);
  const [youtubeAuth, setYoutubeAuth] = useState<YouTubeAuthorizationStatusEnvelope | null>(null);
  const [youtubeAuthPending, setYoutubeAuthPending] = useState(true);
  const [mailTransportProbe, setMailTransportProbe] = useState<MailTransportProbeStatus | null>(null);
  const [mailProbePending, setMailProbePending] = useState(false);
  const [attestation, setAttestation] = useState<MailProviderAttestationProjection | null>(null);
  const [attestationLoading, setAttestationLoading] = useState(true);
  const [mailActionPending, setMailActionPending] = useState<MailAction | null>(null);
  const [canonicalConfirmation, setCanonicalConfirmation] = useState("");
  const [diagnosticTokenEvidence, setDiagnosticTokenEvidence] = useState<DiagnosticTokenEvidence | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const diagnosticChallengeTokenRef = useRef<string | null>(null);
  const [peoplyStatus, setPeoplyStatus] = useState<GetPeoplyStatusEnvelope | null>(null);
  const [peoplyStatusPending, setPeoplyStatusPending] = useState(true);
  const [peoplyKind, setPeoplyKind] = useState<PeoplySearchKind>("people");
  const [peoplyQuery, setPeoplyQuery] = useState("");
  const [peoplySearchPending, setPeoplySearchPending] = useState(false);
  const [peoplySearchResult, setPeoplySearchResult] = useState<SearchPeoplyDirectoryEnvelope | null>(null);
  const [mailAccounts, setMailAccounts] = useState<MailAccountPublic[]>([]);
  const [mailAccountsPending, setMailAccountsPending] = useState(true);
  const [mailOAuthActionAccountId, setMailOAuthActionAccountId] = useState<string | null>(null);
  const [mailOAuthCompanionFallback, setMailOAuthCompanionFallback] = useState<MailOAuthCompanionFallback | null>(null);
  const mailOAuthCompanionPopupRef = useRef<Window | null>(null);
  const mailOAuthCompanionTimerRef = useRef<number | null>(null);
  const mailOAuthCompanionPendingRef = useRef<{ accountId: string } | null>(null);
  const mailOAuthRefreshRef = useRef<() => void>(() => {});
  const [ownMailOAuthStatus, setOwnMailOAuthStatus] = useState<GetMailOAuthStatusEnvelope | null>(null);
  const [ownMailContext, setOwnMailContext] = useState<MyOrgContextEnvelope | null>(null);
  const [ownMailStatePending, setOwnMailStatePending] = useState(true);
  const [ownMailStateError, setOwnMailStateError] = useState<string | null>(null);
  const [ownMailNotice, setOwnMailNotice] = useState<Notice | null>(null);
  const searchParams = useSearchParams();

  // PLAN-ORG-MAIL-IDENTITY Slice 5 — account add/edit console + routing editor.
  const [mailRouting, setMailRoutingState] = useState<MailRouting | null>(null);
  const [orgDirectory, setOrgDirectory] = useState<Record<string, string>>({});
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [accountForm, setAccountForm] = useState<MailAccountFormState>(emptyMailAccountForm());
  const [accountFormPending, setAccountFormPending] = useState(false);
  const [accountFormError, setAccountFormError] = useState("");
  const [routingDraft, setRoutingDraft] = useState<Record<string, string>>({});
  const [routingDefaultDraft, setRoutingDefaultDraft] = useState("");
  const [routingPending, setRoutingPending] = useState(false);
  // 0.6.73 Aside 핫픽스 — orgId -> 다음 계정id(추가/변경) | null(삭제). 저장 버튼을 누르기 전까지는
  // 콜러블을 호출하지 않는다(아래 routingDisplayRows·saveRoutingChanges).
  const [routingPendingEdits, setRoutingPendingEdits] = useState<Record<string, string | null>>({});
  // Flu/Task-48 — 조직별 개인 메일 연결 허용 플래그, 같은 settings/mail_routing 문서 위 필드.
  const [personalMailAllowedPending, setPersonalMailAllowedPending] = useState(false);
  const [personalMailAllowedStaged, setPersonalMailAllowedStaged] = useState<OrgAllowlistPending>(EMPTY_ORG_ALLOWLIST_PENDING);
  // Flu/Task-48 적대 리뷰 P1-4 — 조직별 Chat 기본 보기(=내 메일함) 플래그, 같은 문서 위 필드.
  const [chatPersonalViewDefaultPending, setChatPersonalViewDefaultPending] = useState(false);
  const [chatPersonalViewDefaultStaged, setChatPersonalViewDefaultStaged] = useState<OrgAllowlistPending>(EMPTY_ORG_ALLOWLIST_PENDING);
  // (scp 계정 배정 허용) — 슈퍼관리자 전용 scp 배정 허용 목록, 같은 문서 위 필드.
  const [scpAllowedPending, setScpAllowedPending] = useState(false);
  const [scpAllowedStaged, setScpAllowedStaged] = useState<OrgAllowlistPending>(EMPTY_ORG_ALLOWLIST_PENDING);
  // 저장 전 "지금 로그인한 조직이 목록에서 빠지는가" 경고와 내 메일 연결 상태에 함께 쓰는
  // 서버 투영. 계정/자격증명 원문은 이 응답에 포함되지 않는다.
  const [myOrgId, setMyOrgId] = useState<string | null>(null);

  // Flu/Task-42 — org -> Flu tab preset editor (settings/org_tab_presets), same load/optimistic-
  // apply shape as the mail routing state just above.
  const [tabPresetsDraft, setTabPresetsDraft] = useState<Record<string, string[]>>({});
  const [tabPresetsRevision, setTabPresetsRevision] = useState<number | null>(null);
  const [tabPresetsLoading, setTabPresetsLoading] = useState(true);
  const [tabPresetsPending, setTabPresetsPending] = useState(false);
  // 0.6.73 Aside 핫픽스 — orgId -> 다음 navKeys(추가/토글) | null(프리셋 해제). 저장 버튼 전까지는
  // 로컬에만 쌓인다.
  const [tabPresetsPendingEdits, setTabPresetsPendingEdits] = useState<Record<string, string[] | null>>({});

  // AI-DRAMA-DISCOVERY-METAPROMPT W6 — Apify 캡챠 우회 연동 골격(integrations/captcha_solver).
  // 실제 actor 호출은 없다 — 이 카드는 config+게이트+캡만 편집한다. 폼 필드는 문자열로 두고
  // 저장 시점에만 파싱한다(다른 숫자 입력 필드들과 달리 이 페이지엔 이 값들을 위한 별도
  // NumberInput류 컴포넌트가 없어 가장 낮은 위험의 최소 구현을 택함).
  const [captchaSolverIntegration, setCaptchaSolverIntegrationState] = useState<CaptchaSolverIntegration | null>(null);
  const [captchaSolverLoading, setCaptchaSolverLoading] = useState(true);
  const [captchaSolverPending, setCaptchaSolverPending] = useState(false);
  const [captchaSolverForm, setCaptchaSolverForm] = useState({
    enabled: false,
    allowedOrgIds: "",
    actorId: "",
    dailyCallCap: "",
    dailyBudgetUsd: "",
    perJobCallCap: "",
  });

  function applyCaptchaSolverIntegrationToForm(integration: CaptchaSolverIntegration) {
    setCaptchaSolverIntegrationState(integration);
    setCaptchaSolverForm({
      enabled: integration.enabled,
      allowedOrgIds: integration.allowedOrgIds.join(", "),
      actorId: integration.actorId,
      dailyCallCap: String(integration.dailyCallCap),
      dailyBudgetUsd: String(integration.dailyBudgetUsd),
      perJobCallCap: String(integration.perJobCallCap),
    });
  }

  const loadCaptchaSolverIntegration = () => {
    setCaptchaSolverLoading(true);
    getCaptchaSolverIntegration({})
      .then((response) => applyCaptchaSolverIntegrationToForm(response.integration))
      .catch((error) => {
        setNotice({ tone: "error", message: error instanceof Error ? error.message : "Apify 연동 설정을 불러오지 못했습니다." });
      })
      .finally(() => setCaptchaSolverLoading(false));
  };

  useEffect(() => {
    loadCaptchaSolverIntegration();
  }, []);

  async function saveCaptchaSolverIntegration() {
    setCaptchaSolverPending(true);
    try {
      const response = await setCaptchaSolverIntegration({
        enabled: captchaSolverForm.enabled,
        allowedOrgIds: captchaSolverForm.allowedOrgIds.split(",").map((item) => item.trim()).filter(Boolean),
        actorId: captchaSolverForm.actorId.trim(),
        dailyCallCap: Number(captchaSolverForm.dailyCallCap),
        dailyBudgetUsd: Number(captchaSolverForm.dailyBudgetUsd),
        perJobCallCap: Number(captchaSolverForm.perJobCallCap),
      });
      applyCaptchaSolverIntegrationToForm(response.integration);
      setNotice({ tone: "success", message: "Apify 연동 설정을 저장했습니다." });
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Apify 연동 설정을 저장하지 못했습니다." });
    } finally {
      setCaptchaSolverPending(false);
    }
  }

  const loadOrgTabPresets = () => {
    setTabPresetsLoading(true);
    getOrgTabPresets({})
      .then((response) => {
        setTabPresetsDraft(response.presets.byOrgId);
        setTabPresetsRevision(response.presets.revision);
      })
      .catch((error) => {
        setTabPresetsDraft({});
        setTabPresetsRevision(null);
        setNotice({ tone: "error", message: error instanceof Error ? error.message : "탭 프리셋을 불러오지 못했습니다." });
      })
      .finally(() => setTabPresetsLoading(false));
  };

  useEffect(() => {
    loadOrgTabPresets();
  }, []);

  // 0.6.73 Aside 핫픽스 — 여러 조직을 한 번에 저장할 수 있도록 배치로 바꿨다(setOrgTabPresets의
  // byOrgId는 원래도 여러 orgId를 한 호출에 받는다 — 콜러블 계약은 그대로, 클라이언트가 한 org씩
  // 즉시 부르던 것만 저장 시점 배치 호출로 옮긴다).
  async function applyTabPresetChanges(changes: Record<string, string[] | null>): Promise<boolean> {
    if (tabPresetsRevision === null) {
      setNotice({ tone: "error", message: "탭 프리셋 최신 버전을 불러오는 중입니다. 잠시 후 다시 시도하세요." });
      return false;
    }
    const previousDraft = tabPresetsDraft;
    const optimisticDraft = { ...previousDraft };
    for (const [orgId, navKeys] of Object.entries(changes)) {
      if (navKeys === null) delete optimisticDraft[orgId];
      else optimisticDraft[orgId] = navKeys;
    }
    setTabPresetsDraft(optimisticDraft);
    setTabPresetsPending(true);
    try {
      const response = await setOrgTabPresets({ byOrgId: changes, expectedRevision: tabPresetsRevision });
      setTabPresetsDraft(response.presets.byOrgId);
      setTabPresetsRevision(response.presets.revision);
      return true;
    } catch (error) {
      setTabPresetsDraft(previousDraft);
      if (error && typeof error === "object" && (error as { code?: string }).code === "aborted") {
        loadOrgTabPresets();
        setNotice({ tone: "error", message: "다른 관리자가 탭 프리셋을 변경했습니다. 최신 상태를 불러왔습니다." });
        return false;
      }
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "탭 프리셋을 저장하지 못했습니다." });
      return false;
    } finally {
      setTabPresetsPending(false);
    }
  }

  // 검색 결과 클릭(새 org 추가)·체크박스 토글·"프리셋 해제" 버튼 전부 여기로 모인다 — 콜러블은
  // 안 부르고 tabPresetsPendingEdits(대기 목록)에만 쌓는다.
  function stageOrgTabPresetChange(orgId: string, navKeys: string[] | null) {
    setTabPresetsPendingEdits((prev) => ({ ...prev, [orgId]: navKeys }));
  }

  function toggleOrgTabPresetKey(orgId: string, key: string) {
    const current = tabPresetsPendingEdits[orgId] ?? tabPresetsDraft[orgId] ?? [];
    const next = current.includes(key) ? current.filter((existing) => existing !== key) : [...current, key];
    stageOrgTabPresetChange(orgId, next);
  }

  async function saveTabPresetChanges() {
    const entries = Object.entries(tabPresetsPendingEdits);
    if (entries.length === 0) return;
    const nameOf = (id: string) => orgDirectory[id] ?? id;
    const changedNames = entries.map(([orgId]) => nameOf(orgId)).join(", ");
    if (!window.confirm(`조직 → 탭 프리셋 변경 사항을 저장합니다.\n\n대상 조직: ${changedNames}\n\n계속할까요?`)) return;
    const ok = await applyTabPresetChanges(tabPresetsPendingEdits);
    if (ok) setTabPresetsPendingEdits({});
  }

  const loadMailAccounts = () => {
    setMailAccountsPending(true);
    listMailAccounts({})
      .then((response) => {
        setMailAccounts(response.accounts);
        setMailRoutingState(response.routing);
        setRoutingDraft(response.routing.byOrgId);
        setRoutingDefaultDraft(response.routing.defaultAccountId);
      })
      .catch(() => setMailAccounts([]))
      .finally(() => setMailAccountsPending(false));
  };

  useEffect(() => {
    loadMailAccounts();
  }, []);

  // Self-scoped status is intentionally loaded separately from the manager account list. The
  // list is an administrative projection, while this request is the only source of truth for the
  // signed-in person's own OAuth link. A linked record is displayed as a record until a provider
  // health check exists; `status: active` alone is not evidence that the mailbox is usable now.
  async function loadOwnMailState(options: { verifyConnection?: boolean } = {}) {
    const verifyConnection = options.verifyConnection === true;
    if (currentRole === "guest" || !currentEmail.trim()) {
      setOwnMailContext(null);
      setOwnMailOAuthStatus(null);
      setMyOrgId(null);
      setOwnMailStateError(null);
      setOwnMailStatePending(false);
      return;
    }

    setOwnMailStatePending(true);
    setOwnMailStateError(null);
    let contextResult: PromiseSettledResult<MyOrgContextEnvelope>;
    let oauthResult: PromiseSettledResult<GetMailOAuthStatusEnvelope>;
    if (verifyConnection) {
      // The explicit own-account check may turn invalid_grant into pending_auth. Read the
      // resulting org projection only after that check and evict the shared context cache so
      // usableSenders cannot briefly render the pre-probe account state.
      [oauthResult] = await Promise.allSettled([
        getMailOAuthStatus({ self: true, verifyConnection: true }),
      ]);
      invalidateOrgContextCache();
      [contextResult] = await Promise.allSettled([getMyOrgContext({})]);
    } else {
      // Initial loads stay passive: metadata only, with no provider refresh attempt.
      [contextResult, oauthResult] = await Promise.allSettled([
        getMyOrgContext({}),
        getMailOAuthStatus({ self: true }),
      ]);
    }
    const failures: string[] = [];
    if (contextResult.status === "fulfilled") {
      setOwnMailContext(contextResult.value);
      setMyOrgId(contextResult.value.orgId);
    } else {
      setOwnMailContext(null);
      setMyOrgId(null);
      failures.push("조직 매핑 상태를 확인하지 못했습니다.");
    }
    if (oauthResult.status === "fulfilled") {
      setOwnMailOAuthStatus(oauthResult.value);
    } else {
      setOwnMailOAuthStatus(null);
      failures.push("내 메일 연결 상태를 확인하지 못했습니다.");
    }
    setOwnMailStateError(failures.length > 0 ? failures.join(" ") : null);
    setOwnMailStatePending(false);
  }

  useEffect(() => {
    mailOAuthRefreshRef.current = () => {
      invalidateOrgContextCache();
      loadMailAccounts();
      void loadOwnMailState({ verifyConnection: true });
    };
  });

  useEffect(() => {
    void loadOwnMailState();
    // This effect follows the authenticated identity. The loader is intentionally local to this
    // page so a shadow/admin account cannot reuse a stale self status from another profile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRole, currentEmail]);

  const discoverOrgs = (orgs: PeoplyOrganization[]) => {
    if (orgs.length === 0) return;
    setOrgDirectory((prev) => {
      const next = { ...prev };
      for (const org of orgs) next[org.id] = org.name;
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    searchPeoplyDirectory({ kind: "orgs", q: "" })
      .then((response) => {
        if (cancelled || !response.ok || !response.snapshot) return;
        discoverOrgs(response.snapshot.items as PeoplyOrganization[]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeMailAccounts = useMemo(() => mailAccounts.filter((account) => account.status === "active"), [mailAccounts]);
  const ownUsableSenders = useMemo(() => usableMailSenders(ownMailContext), [ownMailContext]);
  const ownDefaultSender = useMemo(
    () => defaultMailSender(ownMailContext, ownUsableSenders),
    [ownMailContext, ownUsableSenders],
  );
  const ownMailAccount = useMemo(() => {
    // The admin inventory is deliberately excluded. `personalAccount` and `accessibleAccounts`
    // are the server's strict own-mail view projection; an active inventory row alone is not an
    // entitlement to view or send from that mailbox.
    if (ownMailContext?.personalAccount) return ownMailContext.personalAccount;
    const normalizedEmail = currentEmail.trim().toLowerCase();
    return (ownMailContext?.accessibleAccounts ?? []).find((account) =>
      account.kind === "workspace_oauth"
      && account.ownerEmail.trim().toLowerCase() === normalizedEmail,
    ) ?? null;
  }, [currentEmail, ownMailContext?.accessibleAccounts, ownMailContext?.personalAccount]);

  // 0.6.73 Aside 핫픽스 — 커밋된 routingDraft와 대기 목록(routingPendingEdits)을 합쳐 미리보기
  // 행을 만든다. 삭제 대기 행은 목록에서 지우지 않고 "삭제 예정" 표시로 계속 보여줘 저장 전까지
  // 실행 취소할 수 있게 한다.
  type RoutingRow = {
    orgId: string;
    displayedAccountId: string;
    isPendingRemove: boolean;
    isPendingAdd: boolean;
    isPendingChange: boolean;
  };
  const routingRows = useMemo<RoutingRow[]>(() => {
    const orgIds = new Set([...Object.keys(routingDraft), ...Object.keys(routingPendingEdits)]);
    const rows: RoutingRow[] = [];
    for (const orgId of orgIds) {
      const pendingEdit = routingPendingEdits[orgId];
      const committedAccountId = routingDraft[orgId];
      const isPendingRemove = pendingEdit === null;
      const isPendingAdd = pendingEdit !== undefined && pendingEdit !== null && committedAccountId === undefined;
      const isPendingChange = pendingEdit !== undefined && pendingEdit !== null && committedAccountId !== undefined && pendingEdit !== committedAccountId;
      const displayedAccountId = isPendingRemove ? committedAccountId : (pendingEdit ?? committedAccountId);
      if (displayedAccountId === undefined) continue;
      rows.push({ orgId, displayedAccountId, isPendingRemove, isPendingAdd, isPendingChange });
    }
    return rows;
  }, [routingDraft, routingPendingEdits]);

  const routedOrgIdsByAccountId = useMemo(() => {
    const byAccountId: Record<string, string[]> = {};
    for (const [orgId, accountId] of Object.entries(mailRouting?.byOrgId ?? {})) {
      (byAccountId[accountId] ??= []).push(orgId);
    }
    return byAccountId;
  }, [mailRouting?.byOrgId]);

  type TabPresetRow = {
    orgId: string;
    navKeys: string[];
    isPendingRemove: boolean;
    isPendingAdd: boolean;
    isPendingChange: boolean;
  };
  const tabPresetRows = useMemo<TabPresetRow[]>(() => {
    const orgIds = new Set([...Object.keys(tabPresetsDraft), ...Object.keys(tabPresetsPendingEdits)]);
    const rows: TabPresetRow[] = [];
    for (const orgId of orgIds) {
      const pendingEdit = tabPresetsPendingEdits[orgId];
      const committedKeys = tabPresetsDraft[orgId];
      const isPendingRemove = pendingEdit === null;
      const isPendingAdd = pendingEdit !== undefined && pendingEdit !== null && committedKeys === undefined;
      const isPendingChange = Boolean(
        pendingEdit && committedKeys && (pendingEdit.length !== committedKeys.length || pendingEdit.some((key) => !committedKeys.includes(key))),
      );
      const navKeys = isPendingRemove ? (committedKeys ?? []) : (pendingEdit ?? committedKeys ?? []);
      if (committedKeys === undefined && pendingEdit === undefined) continue;
      rows.push({ orgId, navKeys, isPendingRemove, isPendingAdd, isPendingChange });
    }
    return rows;
  }, [tabPresetsDraft, tabPresetsPendingEdits]);

  function openAddAccountForm() {
    setAccountForm(emptyMailAccountForm());
    setAccountFormError("");
    setEditingAccountId("__new__");
  }
  function openEditAccountForm(account: MailAccountPublic) {
    setEditingAccountId((current) => {
      if (current === account.accountId) return null;
      setAccountForm(mailAccountFormFromAccount(account));
      setAccountFormError("");
      return account.accountId;
    });
  }
  function closeAccountForm() {
    setEditingAccountId(null);
    setAccountFormError("");
  }

  async function submitMailAccountForm(isNew: boolean) {
    setAccountFormError("");
    if (isNew && !MAIL_ACCOUNT_ID_PATTERN.test(accountForm.accountId)) {
      setAccountFormError("계정 ID는 소문자/숫자/하이픈만 사용할 수 있습니다 (2~41자).");
      return;
    }
    if (!accountForm.label.trim()) {
      setAccountFormError("표시명을 입력해 주세요.");
      return;
    }
    if (accountForm.accountId !== "scp" && !MAILBOX_PATTERN.test(accountForm.mailbox.trim().toLowerCase())) {
      setAccountFormError("올바른 이메일 주소 형식이 아닙니다.");
      return;
    }
    if (
      accountForm.kind === "external_smtp_imap"
      && accountForm.secretRef.trim()
      && !MAIL_EXT_SECRET_REF_PATTERN.test(accountForm.secretRef.trim())
    ) {
      setAccountFormError("시크릿 참조는 env:MAIL_EXT_ 로 시작해야 합니다 (예: env:MAIL_EXT_ACME_SMTP_PASSWORD).");
      return;
    }
    setAccountFormPending(true);
    try {
      await upsertMailAccount(buildMailAccountPayload(accountForm));
      // Account inventory edits can change an entitled org mailbox view. Evict the shared policy
      // projection only after the server accepts the mutation so Chat/sidebar reload promptly.
      invalidateOrgContextCache();
      setNotice({ tone: "success", message: isNew ? "메일 계정을 추가했습니다." : "메일 계정을 저장했습니다." });
      setEditingAccountId(null);
      loadMailAccounts();
    } catch (error) {
      setAccountFormError(error instanceof Error ? error.message : "저장하지 못했습니다.");
    } finally {
      setAccountFormPending(false);
    }
  }

  async function applyRoutingChange(partial: Record<string, string | null>, nextDefaultAccountId?: string): Promise<boolean> {
    const previousDraft = routingDraft;
    const previousDefault = routingDefaultDraft;
    const optimisticDraft = { ...previousDraft };
    for (const [orgId, accountId] of Object.entries(partial)) {
      if (accountId === null) delete optimisticDraft[orgId];
      else optimisticDraft[orgId] = accountId;
    }
    setRoutingDraft(optimisticDraft);
    if (nextDefaultAccountId) setRoutingDefaultDraft(nextDefaultAccountId);
    setRoutingPending(true);
    try {
      const response = await setMailRouting({
        byOrgId: partial,
        ...(nextDefaultAccountId ? { defaultAccountId: nextDefaultAccountId } : {}),
      });
      setMailRoutingState(response.routing);
      setRoutingDraft(response.routing.byOrgId);
      setRoutingDefaultDraft(response.routing.defaultAccountId);
      invalidateOrgContextCache();
      return true;
    } catch (error) {
      setRoutingDraft(previousDraft);
      setRoutingDefaultDraft(previousDefault);
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "라우팅을 저장하지 못했습니다." });
      return false;
    } finally {
      setRoutingPending(false);
    }
  }

  // 0.6.73 Aside 핫픽스 — routingPendingEdits(대기 목록: orgId -> 다음 계정id | null=삭제)를
  // confirm 받은 뒤 한 번에 applyRoutingChange(기존 낙관적 업데이트·롤백 그대로)로 저장한다. 검색
  // 결과 클릭·계정 select 변경·제거 버튼은 이 함수 호출 전까지 어떤 콜러블도 부르지 않는다.
  async function saveRoutingChanges() {
    const entries = Object.entries(routingPendingEdits);
    if (entries.length === 0) return;
    const nameOf = (id: string) => orgDirectory[id] ?? id;
    const added = entries.filter(([orgId, accountId]) => accountId !== null && !(orgId in routingDraft)).map(([orgId]) => orgId);
    const changed = entries.filter(([orgId, accountId]) => accountId !== null && orgId in routingDraft).map(([orgId]) => orgId);
    const removed = entries.filter(([, accountId]) => accountId === null).map(([orgId]) => orgId);
    const lines = ["조직 → 계정 라우팅 변경 사항을 저장합니다."];
    if (added.length > 0) lines.push(`추가: ${added.map(nameOf).join(", ")}`);
    if (changed.length > 0) lines.push(`변경: ${changed.map(nameOf).join(", ")}`);
    if (removed.length > 0) lines.push(`삭제: ${removed.map(nameOf).join(", ")}`);
    lines.push("계속할까요?");
    if (!window.confirm(lines.join("\n\n"))) return;
    const ok = await applyRoutingChange(routingPendingEdits);
    if (ok) setRoutingPendingEdits({});
  }

  // Flu/Task-48 — 조직별 개인 메일 연결 허용. null(=미설정, 전 조직 허용)에서 시작해, 관리자가
  // 명시적으로 배열을 저장하면 그때부터 엄격한 허용 목록이 된다(functions/mailAccounts.ts
  // isPersonalMailConnectAllowedForOrg 문서 참고). 허용을 뺀 조직은 응답의 disabledAccountIds 로
  // 기존 연결 계정이 즉시 비활성화됐는지 알려준다.
  async function applyPersonalMailAllowedOrgsChange(next: string[] | null): Promise<boolean> {
    setPersonalMailAllowedPending(true);
    try {
      const response = await setMailRouting({ personalMailAllowedOrgIds: next });
      setMailRoutingState(response.routing);
      invalidateOrgContextCache();
      const disabledCount = response.disabledAccountIds?.length ?? 0;
      setNotice({
        tone: "success",
        message: disabledCount > 0
          ? `개인 메일 연결 허용을 저장했습니다. 기존 연결 계정 ${disabledCount}건이 비활성화되었습니다.`
          : "개인 메일 연결 허용을 저장했습니다.",
      });
      return true;
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "저장하지 못했습니다." });
      return false;
    } finally {
      setPersonalMailAllowedPending(false);
    }
  }

  // 0.6.73 Aside 핫픽스 — "대기 목록"(personalMailAllowedStaged)에 쌓인 추가/삭제를 요약해 confirm
  // 받은 뒤에만 위 applyPersonalMailAllowedOrgsChange(실제 콜러블 호출)를 한 번 실행한다. 검색 결과
  // 클릭·제거 버튼은 이 함수 호출 전까지 어떤 콜러블도 부르지 않는다. 저장이 실패하면 대기 목록을
  // 비우지 않는다 — 사용자가 큐에 쌓아 둔 변경을 잃지 않고 다시 저장을 시도할 수 있어야 한다.
  async function savePersonalMailAllowedChanges() {
    if (orgAllowlistPendingCount(personalMailAllowedStaged) === 0) return;
    const committed = mailRouting?.personalMailAllowedOrgIds ?? [];
    const next = nextOrgIdsAfterAllowlistPending(committed, personalMailAllowedStaged);
    const message = orgAllowlistConfirmMessage(
      "개인 메일 연결 허용",
      personalMailAllowedStaged,
      orgDirectory,
      "허용에서 빠진 조직은 개인 메일 연결·Chat 계정 보기 전환이 즉시 비활성화됩니다.",
    );
    if (!window.confirm(message)) return;
    const ok = await applyPersonalMailAllowedOrgsChange(next);
    if (ok) setPersonalMailAllowedStaged(EMPTY_ORG_ALLOWLIST_PENDING);
  }

  // Flu/Task-48 적대 리뷰 P1-4 — 조직별 Chat 기본 보기(=내 메일함). 빈 배열 = 모든 조직이 조직
  // 계정을 기본으로 봄(도입 전 동작 유지). 목록에 넣어도 personalMailAllowedOrgIds 가 허용하지
  // 않는 조직·연결 계정이 없는 caller 는 여전히 org 뷰로 남는다(functions/mailAccounts.ts
  // listAccessibleMailAccountsForEmail defaultView 문서 참고).
  async function applyChatPersonalViewDefaultOrgsChange(next: string[]): Promise<boolean> {
    setChatPersonalViewDefaultPending(true);
    try {
      const response = await setMailRouting({ chatPersonalViewDefaultOrgIds: next });
      setMailRoutingState(response.routing);
      invalidateOrgContextCache();
      setNotice({ tone: "success", message: "Chat 기본 보기 설정을 저장했습니다." });
      return true;
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "저장하지 못했습니다." });
      return false;
    } finally {
      setChatPersonalViewDefaultPending(false);
    }
  }

  // 0.6.73 Aside 핫픽스 — personalMail 카드와 동일 패턴(위 savePersonalMailAllowedChanges 참조).
  async function saveChatPersonalViewDefaultChanges() {
    if (orgAllowlistPendingCount(chatPersonalViewDefaultStaged) === 0) return;
    const committed = mailRouting?.chatPersonalViewDefaultOrgIds ?? [];
    const next = nextOrgIdsAfterAllowlistPending(committed, chatPersonalViewDefaultStaged);
    const message = orgAllowlistConfirmMessage("Chat 기본 보기", chatPersonalViewDefaultStaged, orgDirectory);
    if (!window.confirm(message)) return;
    const ok = await applyChatPersonalViewDefaultOrgsChange(next);
    if (ok) setChatPersonalViewDefaultStaged(EMPTY_ORG_ALLOWLIST_PENDING);
  }

  // (scp 계정 배정 허용) — scp@supercent.io를 슈퍼관리자가 지정한 조직에만 배정. null(=미설정,
  // 전 조직 허용, 도입 전 동작 유지)에서 시작해, 슈퍼관리자가 명시적으로 배열을 저장하면 그때부터
  // 엄격한 허용 목록이 된다(functions/mailAccounts.ts isScpAssignedToOrg 문서 참고). 서버가
  // super_admin만 허용하지만(setMailRouting), 실수로 현재 로그인한 조직이나 전체를 잠그는 사고를
  // 막기 위해 저장 전 confirm을 둔다 — 특히 "지금 이 조직이 목록에서 빠진다"는 별도 강한 경고.
  // next를 그대로 받아 적용한다 — 저장 확인(confirm)은 0.6.73부터 이 함수를 부르는 쪽
  // (saveScpAllowedChanges/설정 초기화 버튼)의 책임이다. 실패 시 false를 돌려줘 호출부가 대기
  // 목록을 비우지 않도록 한다.
  async function applyScpAllowedOrgsChange(next: string[] | null): Promise<boolean> {
    setScpAllowedPending(true);
    try {
      const response = await setMailRouting({ scpAllowedOrgIds: next });
      setMailRoutingState(response.routing);
      invalidateOrgContextCache();
      setNotice({ tone: "success", message: "scp 계정 배정 허용을 저장했습니다." });
      return true;
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "저장하지 못했습니다." });
      return false;
    } finally {
      setScpAllowedPending(false);
    }
  }

  // 0.6.73 Aside 핫픽스 — scpAllowedStaged(대기 목록)를 confirm 받은 뒤에만 저장한다. 기존에 이미
  // 있던 "지금 로그인한 조직이 빠지는가" 강한 경고는 그대로 유지하고, 여기에 추가/삭제 조직명
  // 요약(orgAllowlistConfirmMessage)을 더한다.
  async function saveScpAllowedChanges() {
    if (orgAllowlistPendingCount(scpAllowedStaged) === 0) return;
    const committed = mailRouting?.scpAllowedOrgIds ?? [];
    const next = nextOrgIdsAfterAllowlistPending(committed, scpAllowedStaged);
    const removingOwnOrg = Boolean(myOrgId) && committed.includes(myOrgId as string) && !next.includes(myOrgId as string);
    const impactNote = removingOwnOrg
      ? "지금 로그인한 조직이 scp 계정 배정 허용 목록에서 빠집니다. 저장하면 이 조직의 scp 대화/발신이 즉시 차단됩니다."
      : "목록 밖 조직은 scp 대화/발신이 즉시 차단됩니다.";
    const message = orgAllowlistConfirmMessage("scp 계정 배정 허용", scpAllowedStaged, orgDirectory, impactNote);
    if (!window.confirm(message)) return;
    const ok = await applyScpAllowedOrgsChange(next);
    if (ok) setScpAllowedStaged(EMPTY_ORG_ALLOWLIST_PENDING);
  }

  // PLAN-ORG-MAIL-IDENTITY Slice 2: mailOAuthCallback (functions/mailOAuth.ts) redirects the
  // browser back here with ?mailOAuth=ok|denied|mailbox_mismatch|error after Google consent.
  useEffect(() => {
    const result = searchParams.get("mailOAuth");
    if (!result) return;
    if (result === "ok") invalidateOrgContextCache();
    const callbackNotice = mailOAuthResultNotice(result);
    setNotice(callbackNotice);
    setOwnMailNotice(callbackNotice);
    setMailOAuthActionAccountId(null);
    setMailOAuthCompanionFallback(null);
    clearMailOAuthCompanionWatch();
    loadMailAccounts();
    void loadOwnMailState();
    const url = new URL(window.location.href);
    url.searchParams.delete("mailOAuth");
    url.searchParams.delete("accountId");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function clearMailOAuthCompanionWatch() {
    if (mailOAuthCompanionTimerRef.current !== null) {
      window.clearInterval(mailOAuthCompanionTimerRef.current);
      mailOAuthCompanionTimerRef.current = null;
    }
    mailOAuthCompanionPopupRef.current = null;
    mailOAuthCompanionPendingRef.current = null;
  }

  function refreshMailOAuthCompanionState() {
    mailOAuthRefreshRef.current();
  }

  function finishMailOAuthCompanion(accountId: string) {
    refreshMailOAuthCompanionState();
    setMailOAuthActionAccountId(null);
    setMailOAuthCompanionFallback(null);
    if (mailOAuthCompanionPendingRef.current?.accountId === accountId) clearMailOAuthCompanionWatch();
  }

  function watchMailOAuthCompanion(accountId: string, popup: Window) {
    clearMailOAuthCompanionWatch();
    mailOAuthCompanionPopupRef.current = popup;
    mailOAuthCompanionPendingRef.current = { accountId };
    mailOAuthCompanionTimerRef.current = window.setInterval(() => {
      if (!mailOAuthCompanionPopupRef.current?.closed) return;
      finishMailOAuthCompanion(accountId);
    }, 1_000);
  }

  useEffect(() => {
    const onFocus = () => {
      const pending = mailOAuthCompanionPendingRef.current;
      if (pending) refreshMailOAuthCompanionState();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearMailOAuthCompanionWatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runBeginMailOAuth(accountId?: string) {
    const actionAccountId = accountId ?? "self";
    setNotice(null);
    setOwnMailNotice(null);
    setMailOAuthCompanionFallback(null);
    setMailOAuthActionAccountId(actionAccountId);
    const popup = window.open("about:blank", "mixmaxclone-mail-oauth", "popup=yes,width=520,height=720");
    if (popup) {
      popup.opener = null;
      popup.document.title = "Google 연결 준비 중";
      popup.document.body.textContent = "Google 연결을 준비하는 중입니다. 잠시만 기다려 주세요.";
    }
    try {
      const response = await beginMailOAuth(accountId ? { accountId } : { self: true });
      if (response.ok && response.consentUrl) {
        if (!isSafeGoogleConsentUrl(response.consentUrl)) {
          popup?.close();
          const unsafeNotice = { tone: "error" as const, message: "Google 동의 URL이 예상한 accounts.google.com 주소가 아닙니다. 연결을 중단했습니다." };
          setNotice(unsafeNotice);
          if (!accountId || accountId === ownMailOAuthStatus?.accountId) setOwnMailNotice(unsafeNotice);
          setMailOAuthActionAccountId(null);
          return;
        }
        const pendingNotice = {
          tone: "success" as const,
          message: "Google 동의 화면을 별도 창으로 열었습니다. 연결 완료 후 이 창으로 돌아오세요. 현재는 supercent.io Google Workspace 메일 계정 연결만 지원합니다.",
        };
        if (!popup) {
          const blockedNotice = {
            tone: "error" as const,
            message: "팝업이 차단되었습니다. 아래 Google 동의 링크를 새 탭으로 열고, 연결 완료 후 이 창으로 돌아오세요. 현재는 supercent.io Google Workspace 메일 계정 연결만 지원합니다.",
          };
          setMailOAuthCompanionFallback({ accountId: actionAccountId, consentUrl: response.consentUrl });
          mailOAuthCompanionPendingRef.current = { accountId: actionAccountId };
          setNotice(blockedNotice);
          if (!accountId || accountId === ownMailOAuthStatus?.accountId) setOwnMailNotice(blockedNotice);
          return;
        }
        popup.location.href = response.consentUrl;
        popup.focus();
        watchMailOAuthCompanion(actionAccountId, popup);
        setNotice(pendingNotice);
        if (!accountId || accountId === ownMailOAuthStatus?.accountId) setOwnMailNotice(pendingNotice);
        return;
      }
      popup?.close();
      const beginNotice = mailOAuthBeginNotice(response);
      setNotice(beginNotice);
      if (!accountId || accountId === ownMailOAuthStatus?.accountId) setOwnMailNotice(beginNotice);
      setMailOAuthActionAccountId(null);
    } catch (error) {
      popup?.close();
      const actionNotice = { tone: "error" as const, message: safeIntegrationActionError(error, "mailOAuth") };
      setNotice(actionNotice);
      if (!accountId || accountId === ownMailOAuthStatus?.accountId) setOwnMailNotice(actionNotice);
      setMailOAuthActionAccountId(null);
    }
  }

  async function runRevokeMailOAuth(accountId: string) {
    setNotice(null);
    setOwnMailNotice(null);
    setMailOAuthActionAccountId(accountId);
    try {
      await revokeMailOAuth({ accountId });
      invalidateOrgContextCache();
      const revokeNotice = { tone: "success" as const, message: "메일 계정 연결을 해제했습니다." };
      setNotice(revokeNotice);
      if (accountId === ownMailOAuthStatus?.accountId) setOwnMailNotice(revokeNotice);
      loadMailAccounts();
      if (accountId === ownMailOAuthStatus?.accountId) void loadOwnMailState();
    } catch (error) {
      const actionNotice = { tone: "error" as const, message: safeIntegrationActionError(error, "mailOAuth") };
      setNotice(actionNotice);
      if (accountId === ownMailOAuthStatus?.accountId) setOwnMailNotice(actionNotice);
    } finally {
      setMailOAuthActionAccountId(null);
    }
  }

  // PLAN-ORG-MAIL-IDENTITY Slice 4: "기록 불러오기" for a linked workspace_oauth/external_smtp_imap
  // account — polls getMailBackfillStatus every 10s while a job is queued/running, stops once it
  // settles (done/failed).
  const backfillCapableAccountIds = useMemo(
    () => mailAccounts
      .filter((account) => account.status === "active" && (account.kind === "workspace_oauth" || account.kind === "external_smtp_imap"))
      .map((account) => account.accountId)
      .join(","),
    [mailAccounts],
  );
  const [mailBackfillActionAccountId, setMailBackfillActionAccountId] = useState<string | null>(null);
  const [mailBackfillJobs, setMailBackfillJobs] = useState<Record<string, MailBackfillJob | null>>({});

  const refreshMailBackfillStatuses = async (accountIds: string[]) => {
    if (accountIds.length === 0) return;
    const results = await Promise.all(accountIds.map(async (accountId) => {
      try {
        const response = await getMailBackfillStatus({ accountId });
        return [accountId, response.job] as const;
      } catch {
        return [accountId, null] as const;
      }
    }));
    setMailBackfillJobs((prev) => {
      const next = { ...prev };
      for (const [accountId, job] of results) next[accountId] = job;
      return next;
    });
  };

  useEffect(() => {
    const accountIds = backfillCapableAccountIds ? backfillCapableAccountIds.split(",") : [];
    refreshMailBackfillStatuses(accountIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backfillCapableAccountIds]);

  useEffect(() => {
    const activeAccountIds = Object.entries(mailBackfillJobs)
      .filter(([, job]) => job?.status === "queued" || job?.status === "running")
      .map(([accountId]) => accountId);
    if (activeAccountIds.length === 0) return;
    const timer = window.setInterval(() => {
      refreshMailBackfillStatuses(activeAccountIds);
    }, 10_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(mailBackfillJobs)]);

  async function runStartMailBackfill(accountId: string) {
    setNotice(null);
    setMailBackfillActionAccountId(accountId);
    try {
      const response = await startMailBackfill({ accountId, days: 30 });
      const nowIso = new Date().toISOString();
      setMailBackfillJobs((prev) => ({
        ...prev,
        [accountId]: {
          jobId: response.jobId, accountId, requestedBy: "", sinceIso: response.sinceIso,
          status: "queued", scannedUids: 0, ingested: 0, skippedDuplicates: 0, lastUid: 0,
          createdAt: nowIso, updatedAt: nowIso,
        },
      }));
      setNotice({ tone: "success", message: "최근 30일 메일 기록 불러오기를 시작했습니다." });
    } catch (error) {
      setNotice({ tone: "error", message: safeIntegrationActionError(error, "mailBackfill") });
    } finally {
      setMailBackfillActionAccountId(null);
    }
  }

  function mailBackfillStatusLabel(job: MailBackfillJob | null | undefined): string | null {
    if (!job) return null;
    const labels: Record<MailBackfillJobStatus, string> = {
      queued: "대기 중",
      running: "불러오는 중",
      done: `완료 · ${job.ingested}건`,
      failed: "실패",
    };
    return labels[job.status];
  }

  useEffect(() => {
    let cancelled = false;
    getPeoplyStatus({})
      .then((response) => { if (!cancelled) setPeoplyStatus(response); })
      .catch(() => { if (!cancelled) setPeoplyStatus(null); })
      .finally(() => { if (!cancelled) setPeoplyStatusPending(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      getIntegrations({}),
      getMailProviderAttestationStatus({}),
      getYouTubeAuthorizationStatus({}),
    ]).then(([integrationsResult, attestationResult, youtubeResult]) => {
      if (cancelled) return;
      const failures: string[] = [];
      if (integrationsResult.status === "fulfilled") {
        applyIntegrationState(integrationsResult.value);
      } else {
        failures.push("연동 설정을 불러오지 못했습니다.");
      }
      if (attestationResult.status === "fulfilled") {
        setAttestation(attestationResult.value.attestation);
      } else if (integrationsResult.status !== "fulfilled") {
        failures.push("메일 제공자 확인 상태를 불러오지 못했습니다.");
      }
      if (youtubeResult.status === "fulfilled") {
        setYoutubeAuth(youtubeResult.value);
      } else {
        failures.push("YouTube 권한 상태를 불러오지 못했습니다.");
      }
      setAttestationLoading(false);
      setYoutubeAuthPending(false);
      setNotice(failures.length > 0 ? { tone: "error", message: failures.join(" ") } : null);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!diagnosticTokenEvidence) return;
    const remainingMs = Date.parse(diagnosticTokenEvidence.expiresAtIso) - Date.now();
    if (remainingMs <= 0) {
      diagnosticChallengeTokenRef.current = null;
      setDiagnosticTokenEvidence(null);
      return;
    }
    const timer = window.setTimeout(() => {
      diagnosticChallengeTokenRef.current = null;
      setDiagnosticTokenEvidence(null);
    }, Math.min(remainingMs, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [diagnosticTokenEvidence]);

  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const confirmationMatches = canonicalConfirmation === CANONICAL_OPERATIONAL_MAILBOX;
  const mailProbePassed = isFreshSuccessfulMailProbe(mailTransportProbe);
  const ownMailConnection = currentRole === "guest" || !currentEmail.trim()
    ? {
      tone: "neutral" as const,
      label: "로그인 필요",
      detail: "개인 메일 연결 상태는 로그인한 계정에 대해서만 확인할 수 있습니다.",
    }
    : ownMailConnectionState(ownMailOAuthStatus, ownMailAccount);
  const ownMailOrgDisplay = mailOrgContextDisplay(ownMailContext, ownMailStatePending);
  const diagnosticReady = Boolean(
    diagnosticChallengeTokenRef.current
    && isDiagnosticTokenEvidenceFresh(diagnosticTokenEvidence)
    && mailProbePassed,
  );
  const canAttest = confirmationMatches
    && diagnosticReady
    && !attestationLoading
    && !mailProbePending
    && mailActionPending === null
    && attestation?.status !== "active";
  const canRevoke = confirmationMatches
    && mailActionPending === null
    && attestation !== null
    && attestation.status !== "missing"
    && attestation.status !== "revoked";

  function applyIntegrationState(response: GetIntegrationsEnvelope) {
    setItems(response.integrations);
    setMailTransportProbe(response.mailTransportProbe);
    setAttestation(response.mailProviderAttestation);
    setMode(response.mode || "unknown");
    setRuntimeMode(response.runtimeMode);
    setCapabilities(response.capabilities);
  }

  async function refreshMailState() {
    const [integrationsResponse, attestationResponse] = await Promise.all([
      getIntegrations({}),
      getMailProviderAttestationStatus({}),
    ]);
    applyIntegrationState(integrationsResponse);
    setAttestation(attestationResponse.attestation);
    if (
      diagnosticChallengeTokenRef.current
      && diagnosticTokenEvidence
      && (
        !isFreshSuccessfulMailProbe(integrationsResponse.mailTransportProbe)
        || fingerprintPrefix(integrationsResponse.mailTransportProbe?.configFingerprint)
          !== diagnosticTokenEvidence.fingerprintPrefix
      )
    ) {
      clearDiagnosticChallenge();
    }
  }

  function clearDiagnosticChallenge() {
    diagnosticChallengeTokenRef.current = null;
    setDiagnosticTokenEvidence(null);
  }

  async function save(definition: Definition) {
    const previous = items;
    const draft = drafts[definition.key];
    const cleanPublic = Object.fromEntries(
      Object.entries(draft.publicValues).filter(([, value]) => value.trim() !== "").map(([key, value]) => [key, coerceValue(value)]),
    );
    const current = byKey.get(definition.key);
    const optimistic: IntegrationSummary = {
      key: definition.key,
      label: definition.title,
      configured: true,
      liveReady: false,
      public: { ...(current?.public ?? {}), ...cleanPublic },
      secrets: { ...(current?.secrets ?? {}), [definition.secret]: draft.secret ? mask(draft.secret) : current?.secrets[definition.secret] ?? "미설정" },
      requiredEnv: current?.requiredEnv,
      updatedAt: new Date().toISOString(),
    };

    setNotice(null);
    setPending(definition.key);
    setItems((currentItems) => upsert(currentItems, optimistic));

    try {
      const response = await updateIntegration({
        key: definition.key,
        values: {
          ...cleanPublic,
          [definition.secret]: draft.secret,
        },
      });
      setItems((currentItems) => upsert(currentItems, response.integration));
      if (definition.key === "mailSmtp" || definition.key === "mailImap") {
        clearDiagnosticChallenge();
      }
      try {
        // updateIntegration never binds runtime secrets itself. Re-read both safe
        // projections so saved configuration, runtime binding, probe freshness,
        // and attestation cannot drift in the operator surface.
        await refreshMailState();
        setNotice({ tone: "success", message: `${definition.title} 설정을 저장하고 상태를 새로고침했습니다.` });
      } catch {
        setNotice({
          tone: "error",
          message: `${definition.title} 설정은 저장했지만 최신 연동·확인 상태를 불러오지 못했습니다. 상태 새로고침을 실행해 주세요.`,
        });
      }
      setDrafts((currentDrafts) => ({ ...currentDrafts, [definition.key]: { publicValues: {}, secret: "" } }));
      setEditing(null);
    } catch (error) {
      setItems(previous);
      setNotice({ tone: "error", message: safeIntegrationActionError(error, "save") });
    } finally {
      setPending(null);
    }
  }

  async function refreshYouTubeAuthorization() {
    setYoutubeAuthPending(true);
    setNotice(null);
    try {
      setYoutubeAuth(await getYouTubeAuthorizationStatus({}));
      setNotice({ tone: "success", message: "YouTube 권한 상태를 새로고침했습니다." });
    } catch (error) {
      setNotice({ tone: "error", message: safeIntegrationActionError(error, "youtube") });
    } finally {
      setYoutubeAuthPending(false);
    }
  }

  async function runPeoplySearch() {
    if (peoplyRequiresQuery(peoplyKind) && !peoplyQuery.trim()) return;
    setPeoplySearchPending(true);
    try {
      const response = await searchPeoplyDirectory({ kind: peoplyKind, q: peoplyQuery });
      setPeoplySearchResult(response);
    } catch {
      setPeoplySearchResult(null);
    } finally {
      setPeoplySearchPending(false);
    }
  }

  async function runMailTransportDiagnostic() {
    setMailProbePending(true);
    setNotice(null);
    clearDiagnosticChallenge();
    try {
      const result = await diagnoseMailTransport({});
      setMailTransportProbe(result.probe);
      const readyForAttestation = isAttestationReadyDiagnostic(result);
      if (readyForAttestation) {
        diagnosticChallengeTokenRef.current = result.attestationChallengeToken;
        setDiagnosticTokenEvidence({
          checkedAtIso: result.probe.checkedAtIso,
          expiresAtIso: result.probe.expiresAtIso,
          fingerprintPrefix: fingerprintPrefix(result.probe.configFingerprint),
        });
      }
      try {
        await refreshMailState();
      } catch {
        setNotice({
          tone: "error",
          message: readyForAttestation
            ? "무발송 진단은 통과했지만 최신 연동·확인 상태를 불러오지 못했습니다. 확인 토큰은 이 화면 메모리에만 유지됩니다."
            : "진단 결과를 확인했지만 최신 연동·확인 상태를 불러오지 못했습니다. 다시 진단해 주세요.",
        });
        return;
      }
      setNotice(readyForAttestation
        ? {
          tone: "success",
          message: "메일을 보내지 않는 SMTP·IMAP 진단이 통과했습니다. 이 화면이 열려 있는 동안 제공자 주체 확인을 진행할 수 있습니다.",
        }
        : {
          tone: "error",
          message: diagnosticFailureMessage(result),
        });
    } catch (error) {
      setNotice({ tone: "error", message: safeIntegrationActionError(error, "diagnose") });
    } finally {
      setMailProbePending(false);
    }
  }

  async function refreshAttestationState() {
    setMailActionPending("refresh");
    setNotice(null);
    try {
      await refreshMailState();
      setNotice({ tone: "success", message: "메일 연동과 제공자 확인 상태를 새로고침했습니다." });
    } catch (error) {
      setNotice({ tone: "error", message: safeIntegrationActionError(error, "refresh") });
    } finally {
      setAttestationLoading(false);
      setMailActionPending(null);
    }
  }

  async function attestProviderSubject() {
    const diagnosticChallengeToken = diagnosticChallengeTokenRef.current;
    if (!confirmationMatches) {
      setNotice({
        tone: "error",
        message: `${CANONICAL_OPERATIONAL_MAILBOX}를 공백과 대소문자 변경 없이 정확히 입력해 주세요.`,
      });
      return;
    }
    if (
      !diagnosticChallengeToken
      || !isDiagnosticTokenEvidenceFresh(diagnosticTokenEvidence)
      || !isFreshSuccessfulMailProbe(mailTransportProbe)
    ) {
      clearDiagnosticChallenge();
      setNotice({ tone: "error", message: "새로운 무발송 연결 진단을 통과한 뒤 제공자 주체 확인을 진행해 주세요." });
      return;
    }

    setMailActionPending("attest");
    setNotice(null);
    try {
      const result = await attestMailProviderSubject({
        canonicalMailboxConfirmation: CANONICAL_OPERATIONAL_MAILBOX,
        diagnosticChallengeToken,
      });
      setAttestation(result.attestation);
      clearDiagnosticChallenge();
      setCanonicalConfirmation("");
      try {
        await refreshMailState();
        setNotice({ tone: "success", message: "메일 제공자 주체 확인을 완료하고 최신 상태를 반영했습니다." });
      } catch {
        setNotice({
          tone: "error",
          message: "메일 제공자 주체 확인은 완료됐지만 최신 연동 상태를 불러오지 못했습니다. 상태 새로고침을 실행해 주세요.",
        });
      }
    } catch (error) {
      if (callableErrorCode(error) === "failed-precondition") clearDiagnosticChallenge();
      setNotice({ tone: "error", message: safeIntegrationActionError(error, "attest") });
    } finally {
      setMailActionPending(null);
    }
  }

  async function revokeProviderSubject() {
    if (!confirmationMatches) {
      setNotice({
        tone: "error",
        message: `${CANONICAL_OPERATIONAL_MAILBOX}를 공백과 대소문자 변경 없이 정확히 입력해 주세요.`,
      });
      return;
    }

    setMailActionPending("revoke");
    setNotice(null);
    try {
      const result = await revokeMailProviderSubject({
        canonicalMailboxConfirmation: CANONICAL_OPERATIONAL_MAILBOX,
      });
      setAttestation(result.attestation);
      clearDiagnosticChallenge();
      setCanonicalConfirmation("");
      try {
        await refreshMailState();
        setNotice({ tone: "success", message: "메일 제공자 주체 확인을 해제하고 최신 상태를 반영했습니다." });
      } catch {
        setNotice({
          tone: "error",
          message: "메일 제공자 주체 확인은 해제됐지만 최신 연동 상태를 불러오지 못했습니다. 상태 새로고침을 실행해 주세요.",
        });
      }
    } catch (error) {
      setNotice({ tone: "error", message: safeIntegrationActionError(error, "revoke") });
    } finally {
      setMailActionPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="연동 설정"
        desc="메일 계정 연결·조직 라우팅·진단 설정을 한곳에서 확인한다. 멤버별 추가 메일함 접근은 멤버·권한에서 관리한다."
      />

      <Card className="mt-4" data-testid="my-mail-connection">
        <CardHeader
          title="내 메일함"
          desc="현재 로그인한 계정의 개인 메일 연결과 Peoply 팀 매핑을 확인합니다. 계정 레코드와 팀 공유 발신 권한은 각각 서버 정책으로 판정합니다."
          action={<Badge tone={ownMailConnection.tone}>{ownMailStatePending ? "확인 중" : ownMailConnection.label}</Badge>}
        />
        <div className="flex flex-col gap-3 border-b border-line bg-fill px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink-3">현재 로그인 계정</p>
            <p className="mt-1 truncate text-sm font-semibold text-ink" title={currentEmail || "로그인 계정 확인 중"}>
              {currentEmail || "로그인 계정 확인 중"}
            </p>
            <p className="mt-1 text-xs leading-5 text-ink-3">
              Peoply 팀 · {ownMailOrgDisplay.value}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={currentRole === "guest" || !currentEmail.trim() || ownMailStatePending || (!ownMailContext && ownMailStateError !== null) || mailOAuthActionAccountId === "self" || ownMailContext?.personalMailConnectAllowed === false}
              onClick={() => void runBeginMailOAuth()}
            >
              {currentRole === "guest" || !currentEmail.trim()
                ? "로그인 필요"
                : mailOAuthActionAccountId === "self" ? "연결 중" : ownMailOAuthStatus?.linked ? "다시 연결" : "Google 연결"}
            </Button>
            <Button size="sm" variant="secondary" disabled={currentRole === "guest" || !currentEmail.trim() || ownMailStatePending} onClick={() => void loadOwnMailState({ verifyConnection: true })}>
              상태 새로고침
            </Button>
            {mailOAuthCompanionFallback?.accountId === "self" && (
              <a
                href={mailOAuthCompanionFallback.consentUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-h-8 items-center rounded-md border border-line bg-paper px-3 text-xs font-semibold text-accent hover:bg-fill"
                onClick={() => {
                  mailOAuthCompanionPendingRef.current = { accountId: "self" };
                }}
              >
                Google 동의 열기
              </a>
            )}
          </div>
        </div>
        {ownMailNotice && (
          <div
            className={`border-b px-5 py-3 text-xs leading-5 ${ownMailNotice.tone === "error" ? "border-danger/30 bg-danger-soft text-danger" : "border-ok/30 bg-ok-soft text-ok"}`}
            role={ownMailNotice.tone === "error" ? "alert" : "status"}
            aria-live="polite"
            data-testid="my-mail-connection-notice"
          >
            {ownMailNotice.message}
          </div>
        )}
        {ownMailStateError && (
          <div className="border-b border-danger/30 bg-danger-soft px-5 py-3 text-xs leading-5 text-danger" role="alert">
            {ownMailStateError}
          </div>
        )}
        <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">
          <MailConnectionMetric
            label="메일 계정 소유자"
            value={ownMailAccount?.ownerEmail || ownMailOAuthStatus?.subjectEmail || currentEmail || "확인 불가"}
            detail="현재 로그인한 계정의 소유자만 표시합니다."
          />
          <MailConnectionMetric
            label="메일함"
            value={ownMailAccount?.mailbox || ownMailOAuthStatus?.subjectEmail || "아직 연결되지 않음"}
            detail={ownMailAccount ? `계정 레코드 ${mailAccountStatusLabel(ownMailAccount.status, ownMailAccount.kind)}` : "내 계정 레코드 없음"}
          />
          <MailConnectionMetric
            label="연결 기록"
            value={ownMailOAuthStatus?.linked ? "기록 있음" : "기록 없음"}
            detail={ownMailOAuthStatus?.linkedAt ? `최근 연결 ${formatDateTime(ownMailOAuthStatus.linkedAt)}` : "연결 시각 기록 없음"}
          />
          <MailConnectionMetric
            label="현재 사용 가능 여부"
            value={ownMailConnection.label}
            detail={ownMailOAuthStatus ? mailOAuthConnectionDetail(ownMailOAuthStatus) : "현재 메일함 확인 결과 없음"}
          />
        </div>
        <div className="border-t border-line" data-testid="my-mail-sender-policy">
          <div className="flex flex-col gap-2 bg-fill px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold text-ink-3">현재 팀 발신 정책</p>
              <p className="mt-1 text-sm font-semibold text-ink">
                {ownMailOrgDisplay.value}
              </p>
              <p className="mt-1 text-xs leading-5 text-ink-3">
                {ownMailContext?.orgId
                  ? `Peoply 매핑 ${ownMailContext.orgId} 기준으로 서버가 발신 계정을 결정합니다.`
                  : "Peoply 팀 매핑이 확인되지 않으면 공유 계정을 자동으로 배정하지 않습니다."}
              </p>
            </div>
            <Badge tone={!ownMailContext ? "neutral" : ownMailContext.senderBlockedReason ? "warn" : ownUsableSenders.length > 0 ? "ok" : "warn"}>
              {!ownMailContext
                ? "확인 중"
                : ownMailContext.senderBlockedReason
                  ? "발송 차단"
                  : ownUsableSenders.length > 0
                    ? "허용된 발신 있음"
                    : "발신 계정 없음"}
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
            <MailConnectionMetric
              label="팀 매핑"
              value={ownMailOrgDisplay.value}
              detail={ownMailOrgDisplay.detail}
            />
            <MailConnectionMetric
              label="공유 발신 계정"
              value={ownMailContext?.orgAccount ? mailSenderDisplayName(ownMailContext.orgAccount) : "명시적 매핑 없음"}
              detail={ownMailContext?.orgAccount?.mailbox || "조직 매핑이 없으면 공유 계정을 사용할 수 없습니다."}
            />
            <MailConnectionMetric
              label="내 발신 권한"
              value={ownUsableSenders.length > 0 ? ownUsableSenders.map(mailSenderDisplayName).join(", ") : "사용 가능한 계정 없음"}
              detail={ownDefaultSender ? `기본 발신 ${mailSenderDisplayName(ownDefaultSender)}` : "서버가 허용한 계정만 Chat 발신 선택지로 표시됩니다."}
            />
          </div>
          <p className="border-t border-line px-5 py-3 text-xs leading-5 text-ink-3">
            아래 관리자 메일 계정 목록은 인벤토리입니다. 계정이 활성 상태여도 현재 사용자의 발신 권한이나 팀 공유 계정 매핑을 대신하지 않습니다.
          </p>
          {ownMailContext?.senderBlockedReason && (
            <p className="border-t border-warn/30 bg-warn-soft px-5 py-3 text-xs leading-5 text-warn" role="status">
              {mailSenderPolicyMessage(ownMailContext)}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-line px-5 py-3 text-xs leading-5 text-ink-3 sm:flex-row sm:items-center sm:justify-between">
          <span>{ownMailConnection.detail}</span>
          {ownMailOAuthStatus?.scopes && ownMailOAuthStatus.scopes.length > 0 && (
            <span className="text-right">확인된 권한 {formatMailOAuthScopes(ownMailOAuthStatus.scopes)}</span>
          )}
        </div>
        {ownMailContext?.personalMailConnectAllowed === false && (
          <div className="border-t border-warn/30 bg-warn-soft px-5 py-3 text-xs leading-5 text-warn" role="status">
            현재 조직은 개인 메일 연결을 허용하지 않습니다. 관리자에게 조직 허용 설정을 확인해 달라고 요청하세요.
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="연동 설정"
          desc="공용 메일 서버 설정과 개인 메일 연결은 별도 상태입니다. 이 화면은 공용 SMTP/IMAP·Gateway·외부 API 설정을 관리하고, 멤버 접근 권한은 멤버·권한 표에서 명시적으로 부여합니다."
          action={<Badge tone={integrationRuntimeTone(runtimeMode, mode)}>{integrationRuntimeLabel(runtimeMode, mode)}</Badge>}
        />
        <div className="grid grid-cols-1 gap-px border-b border-line bg-line sm:grid-cols-3" data-testid="integration-capabilities">
          <CapabilityReadiness label="사내 인명부 조회" capability={capabilities?.peoply} fallbackCode={peoplyStatus?.peoplyError?.kind} />
          <CapabilityReadiness label="개인 메일 OAuth" capability={capabilities?.mailOAuth} />
          <CapabilityReadiness label="조직 메일 라우팅" capability={capabilities?.mailRouting} />
        </div>
        <p className="border-b border-line bg-fill px-5 py-3 text-xs leading-5 text-ink-3">
          {integrationRuntimeDescription(runtimeMode, mode)} 서버 준비 표시는 설정 바인딩만 의미하며, 개인 메일 카드의 연결 기록이나 실제 메일함 사용 가능 여부를 대신하지 않습니다.
        </p>
        <div className="flex flex-col gap-3 border-b border-line bg-fill px-5 py-4 sm:flex-row sm:items-center sm:justify-between" data-testid="mail-transport-diagnostic">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={mailProbePassed ? "ok" : mailTransportProbe ? "warn" : "neutral"}>
                {mailProbePassed ? "SMTP·IMAP 진단 통과" : mailTransportProbe ? "연결 점검 필요" : "연결 미진단"}
              </Badge>
              <span className="text-xs text-ink-3">실제 메일은 보내지 않고 SMTP 인증과 IMAP 읽기 전용 수신함만 확인합니다.</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
              <ProbeSummary label="SMTP" lane={mailTransportProbe?.smtp} />
              <ProbeSummary label="IMAP" lane={mailTransportProbe?.imap} />
              {mailTransportProbe?.checkedAtIso && <span>최근 진단 {new Date(mailTransportProbe.checkedAtIso).toLocaleString("ko-KR")}</span>}
            </div>
          </div>
          <Button className="min-h-10 shrink-0" size="sm" variant="secondary" disabled={mailProbePending} onClick={runMailTransportDiagnostic}>
            {mailProbePending ? "진단 중" : "연결 진단"}
          </Button>
        </div>
        <div>
          {DEFINITIONS.map((definition) => {
            const item = byKey.get(definition.key);
            const draft = drafts[definition.key];
            const locked = item?.configured === true && editing !== definition.key;
            const liveReady = item?.operationalReady === true;
            const isMailTransport = definition.key === "mailSmtp" || definition.key === "mailImap";
            return (
              <ListRow
                key={definition.key}
                padding="xl"
                className="flex-col items-stretch xl:flex-row xl:items-center"
                title={
                  <>
                    {definition.title}
                    <Badge tone={item?.configured ? "ok" : "neutral"}>{item?.configured ? "저장됨" : "미설정"}</Badge>
                    {isMailTransport && (
                      <>
                        <Badge tone={item?.credentialConfigured ? "neutral" : "warn"}>{item?.credentialConfigured ? "자격정보 기록됨" : "저장 자격정보 없음"}</Badge>
                        <Badge tone={item?.runtimeSecretBound ? "ok" : "warn"}>{item?.runtimeSecretBound ? "런타임 Secret 바인딩" : "런타임 Secret 미바인딩"}</Badge>
                        <Badge tone={liveReady ? "ok" : "neutral"}>{liveReady ? "진단 통과" : "진단 필요"}</Badge>
                      </>
                    )}
                  </>
                }
                subtitle={definition.desc}
                meta={item?.updatedAt ? new Date(item.updatedAt).toLocaleString("ko-KR") : definition.hint}
                right={
                  <div className="w-full space-y-2 xl:w-[420px]">
                    {locked ? (
                      <>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {definition.fields.map((field) => (
                            <div
                              key={field.name}
                              className="flex h-10 min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-fill px-3 text-xs"
                            >
                              <span className="shrink-0 font-medium text-ink-3">{field.label}</span>
                              <span className="min-w-0 truncate text-right text-ink-2">{displayPublicValue(item, field)}</span>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <div className="flex h-10 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-line bg-fill px-3 text-xs">
                            <span className="shrink-0 font-medium text-ink-3">{definition.secretLabel}</span>
                            <span className="min-w-0 truncate text-right text-ink-2">{displaySecretValue(item, definition.secret)}</span>
                          </div>
                          <Button className="min-h-10" size="sm" variant="secondary" aria-label={`${definition.title} 편집`} onClick={() => setEditing(definition.key)}>
                            ...
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {definition.fields.map((field) => (
                            <input
                              key={field.name}
                              className="h-10 rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4"
                              placeholder={`${field.label}: ${displayPublicPlaceholder(item, field)}`}
                              value={draft.publicValues[field.name] ?? ""}
                              onChange={(event) => setDrafts((current) => ({
                                ...current,
                                [definition.key]: {
                                  ...draft,
                                  publicValues: { ...draft.publicValues, [field.name]: event.target.value },
                                },
                              }))}
                            />
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <input
                            className="h-10 min-w-0 flex-1 rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4"
                            placeholder={`${definition.secretLabel} (현재 ${displaySecretValue(item, definition.secret)})`}
                            type="password"
                            value={draft.secret}
                            onChange={(event) => setDrafts((current) => ({ ...current, [definition.key]: { ...draft, secret: event.target.value } }))}
                          />
                          <Button className="min-h-10" size="sm" disabled={pending === definition.key} onClick={() => save(definition)}>
                            {pending === definition.key ? "저장 중" : "저장"}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                }
              />
            );
          })}
        </div>
      </Card>

      {/* AI-DRAMA-DISCOVERY-METAPROMPT W6 — Apify 캡챠 우회 연동 골격. 실제 actor 호출은 없다
          (헤세 구매 후 추가) — 이 카드는 config+org 허용목록+일일 캡+잡당 캡만 편집한다.
          integrations/default 의 DEFINITIONS 배열과 별개 문서(integrations/captcha_solver)라
          그 반복문 밖에 독립 카드로 둔다(배열 필드가 있어 그 시스템의 단일 문자열 필드
          가정에 맞지 않는다). */}
      <Card className="mt-4" data-testid="captcha-solver-integration">
        <CardHeader
          title="Apify 캡챠 우회 (AI Drama 전용, 골격)"
          desc="유일한 캡챠 리스크 표면(YouTube /about 이메일 채굴)의 우회 연동 — actor 미구매 상태에선 항상 꺼져 있습니다."
          action={
            captchaSolverLoading
              ? <Badge tone="neutral">불러오는 중</Badge>
              : <Badge tone={captchaSolverIntegration?.enabled ? "ok" : "neutral"}>{captchaSolverIntegration?.enabled ? "켜짐" : "꺼짐"}</Badge>
          }
        />
        <div className="flex flex-col gap-3 px-5 pb-5">
          {!captchaSolverLoading && (
            <>
              <div className="flex flex-wrap items-center gap-4 text-xs text-ink-2">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={captchaSolverForm.enabled}
                    onChange={(event) => setCaptchaSolverForm((prev) => ({ ...prev, enabled: event.target.checked }))}
                    disabled={!isSuperAdmin}
                  />
                  사용
                </label>
                <Badge tone={captchaSolverIntegration?.runtimeSecretBound ? "ok" : "warn"}>
                  {captchaSolverIntegration?.runtimeSecretBound ? "APIFY_API_KEY 바인딩됨" : "APIFY_API_KEY 미바인딩"}
                </Badge>
                <span>
                  오늘 사용량: {captchaSolverIntegration?.usageToday.callCount ?? 0}건 · ${(captchaSolverIntegration?.usageToday.costUsd ?? 0).toFixed(2)}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs text-ink-2">
                  허용 조직 ID (쉼표로 구분, 예: T049)
                  <input
                    className="h-9 rounded-md border border-line bg-paper px-2 text-xs text-ink"
                    value={captchaSolverForm.allowedOrgIds}
                    onChange={(event) => setCaptchaSolverForm((prev) => ({ ...prev, allowedOrgIds: event.target.value }))}
                    placeholder="T049"
                    disabled={!isSuperAdmin}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-2">
                  Apify actor ID
                  <input
                    className="h-9 rounded-md border border-line bg-paper px-2 text-xs text-ink"
                    value={captchaSolverForm.actorId}
                    onChange={(event) => setCaptchaSolverForm((prev) => ({ ...prev, actorId: event.target.value }))}
                    placeholder="actor 구매 후 입력"
                    disabled={!isSuperAdmin}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-2">
                  일일 호출 상한
                  <input
                    className="h-9 rounded-md border border-line bg-paper px-2 text-xs text-ink"
                    value={captchaSolverForm.dailyCallCap}
                    onChange={(event) => setCaptchaSolverForm((prev) => ({ ...prev, dailyCallCap: event.target.value }))}
                    inputMode="numeric"
                    disabled={!isSuperAdmin}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-2">
                  일일 예산(USD)
                  <input
                    className="h-9 rounded-md border border-line bg-paper px-2 text-xs text-ink"
                    value={captchaSolverForm.dailyBudgetUsd}
                    onChange={(event) => setCaptchaSolverForm((prev) => ({ ...prev, dailyBudgetUsd: event.target.value }))}
                    inputMode="decimal"
                    disabled={!isSuperAdmin}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-2">
                  잡당 호출 상한
                  <input
                    className="h-9 rounded-md border border-line bg-paper px-2 text-xs text-ink"
                    value={captchaSolverForm.perJobCallCap}
                    onChange={(event) => setCaptchaSolverForm((prev) => ({ ...prev, perJobCallCap: event.target.value }))}
                    inputMode="numeric"
                    disabled={!isSuperAdmin}
                  />
                </label>
              </div>
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={captchaSolverPending || !isSuperAdmin}
                  title={isSuperAdmin ? undefined : "super_admin만 편집할 수 있습니다"}
                  onClick={saveCaptchaSolverIntegration}
                >
                  {captchaSolverPending ? "저장 중" : "저장"}
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>

      <Card className="mt-4" data-testid="mail-provider-attestation">
        <CardHeader
          title="메일 제공자 주체 확인"
          desc="무발송 연결 진단의 일회성 화면 메모리 증거와 canonical 메일함 확인을 결합한다. 최종 권한 판정은 서버의 super_admin 클레임이 수행한다."
          action={
            <Badge tone={attestationLoading ? "neutral" : attestationStatusTone(attestation?.status)}>
              {attestationLoading ? "확인 중" : attestationStatusLabel(attestation?.status)}
            </Badge>
          }
        />

        <div className="border-b border-line bg-fill px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">
                {attestationLoading ? "제공자 주체 확인 상태를 불러오는 중입니다." : attestation?.reasonKo ?? "확인 상태를 불러오지 못했습니다."}
              </p>
              <p className="mt-1 text-xs leading-5 text-ink-3">
                진단은 SMTP 인증과 IMAP 읽기 전용 수신함만 확인하며 실제 메일을 보내지 않습니다.
              </p>
            </div>
            <Badge tone={diagnosticReady ? "ok" : "neutral"}>
              {diagnosticReady ? "새 진단 증거 준비됨" : "새 진단 필요"}
            </Badge>
          </div>
          {diagnosticTokenEvidence && (
            <p className="mt-2 text-[11px] leading-5 text-ink-3" data-testid="mail-attestation-diagnostic-evidence">
              이번 화면 진단 {formatDateTime(diagnosticTokenEvidence.checkedAtIso)} · 만료 {formatDateTime(diagnosticTokenEvidence.expiresAtIso)}
              {diagnosticTokenEvidence.fingerprintPrefix ? ` · 설정 지문 ${diagnosticTokenEvidence.fingerprintPrefix}` : ""}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
          <AttestationMetric
            label="Canonical 메일함"
            value={attestation?.canonicalMailbox ?? CANONICAL_OPERATIONAL_MAILBOX}
            detail="확인·해제 입력과 서버 검증이 이 값에 정확히 일치해야 합니다."
          />
          <AttestationMetric
            label="확인 시각"
            value={formatDateTime(attestation?.attestedAt)}
            detail={`확인 만료 ${formatDateTime(attestation?.expiresAt)}`}
          />
          <AttestationMetric
            label="확인에 사용한 진단"
            value={formatDateTime(attestation?.diagnosticCheckedAt)}
            detail={`진단 만료 ${formatDateTime(attestation?.diagnosticExpiresAt)}`}
          />
          <AttestationMetric
            label="확인 지문 접두사"
            value={attestation?.fingerprintPrefix || "기록 없음"}
            detail="전체 설정 지문은 표시하지 않습니다."
            mono
          />
          <AttestationMetric
            label="현재 지문 접두사"
            value={attestation?.currentFingerprintPrefix || "기록 없음"}
            detail={attestation?.status === "config_changed" ? "확인 당시 설정과 현재 설정이 다릅니다." : "현재 메일 설정의 안전한 접두사입니다."}
            mono
          />
          <AttestationMetric
            label="상관 영수증"
            value={attestation?.correlationReceipt || "기록 없음"}
            detail="감사 추적용 안전한 영수증 식별자입니다."
            mono
          />
        </div>

        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="text-xs font-semibold text-ink" htmlFor="mail-provider-canonical-confirmation">
              확인 문구
            </label>
            <p id="mail-provider-canonical-confirmation-help" className="mt-1 text-xs leading-5 text-ink-3">
              확인 또는 해제 전에 <span className="font-semibold text-ink-2">{CANONICAL_OPERATIONAL_MAILBOX}</span>를 공백·대소문자 변경 없이 정확히 입력하세요. 입력값과 진단 증거는 저장하지 않습니다.
            </p>
            <input
              id="mail-provider-canonical-confirmation"
              data-testid="mail-provider-canonical-confirmation"
              aria-describedby="mail-provider-canonical-confirmation-help"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="mt-2 h-10 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink outline-none placeholder:text-ink-4 focus:border-accent"
              placeholder={CANONICAL_OPERATIONAL_MAILBOX}
              value={canonicalConfirmation}
              onChange={(event) => setCanonicalConfirmation(event.target.value)}
            />
            {canonicalConfirmation && !confirmationMatches && (
              <p className="mt-1 text-xs font-medium text-danger" role="alert">
                Canonical 메일함과 정확히 일치하지 않습니다.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-10"
              size="sm"
              variant="secondary"
              disabled={mailActionPending !== null || mailProbePending}
              onClick={refreshAttestationState}
            >
              {mailActionPending === "refresh" ? "새로고침 중" : "상태 새로고침"}
            </Button>
            <Button
              className="min-h-10"
              size="sm"
              variant="secondary"
              disabled={mailProbePending || mailActionPending !== null}
              onClick={runMailTransportDiagnostic}
            >
              {mailProbePending ? "진단 중" : "다시 진단"}
            </Button>
            <Button
              className="min-h-10"
              size="sm"
              disabled={!canAttest}
              onClick={attestProviderSubject}
            >
              {mailActionPending === "attest" ? "확인 중" : "제공자 주체 확인"}
            </Button>
            <Button
              className="min-h-10"
              size="sm"
              variant="danger"
              disabled={!canRevoke}
              onClick={revokeProviderSubject}
            >
              {mailActionPending === "revoke" ? "해제 중" : "확인 해제"}
            </Button>
          </div>
          {!diagnosticReady && attestation?.status !== "active" && (
            <p className="text-xs leading-5 text-ink-3">
              제공자 주체 확인 버튼은 새 무발송 진단이 SMTP·IMAP 모두 통과하고 결과가 서버에 저장된 뒤 활성화됩니다.
            </p>
          )}
        </div>
      </Card>

      <Card className="mt-4" data-testid="youtube-authorization-status">
        <CardHeader
          title="YouTube 채널 권한"
          desc="로그인은 외부 도구가 수행하고 FLU는 서명된 콜백으로 채널·범위·만료·취소 상태만 추적한다. OAuth 자격 증명은 저장하지 않는다."
          action={
            <Badge tone={youtubeStatusTone(youtubeAuth?.summaryStatus)}>
              {youtubeAuthPending ? "확인 중" : youtubeStatusLabel(youtubeAuth?.summaryStatus)}
            </Badge>
          }
        />

        <div className="flex justify-end border-b border-line px-5 py-2.5">
          <Button
            className="min-h-10"
            size="sm"
            variant="secondary"
            disabled={youtubeAuthPending}
            onClick={refreshYouTubeAuthorization}
          >
            {youtubeAuthPending ? "확인 중" : "상태 새로고침"}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">
          <AuthorizationMetric
            label="추적 모드"
            value={youtubeAuthModeLabel(youtubeAuth?.configuration?.mode)}
            detail={youtubeAuth?.configuration?.externalToolName || "등록된 외부 도구 없음"}
          />
          <AuthorizationMetric
            label="콜백 검증"
            value={youtubeAuth?.configuration?.callbackEnabled ? "수신 활성" : "수신 비활성"}
            detail={youtubeAuth?.configuration?.callbackSecretReady ? "서명 키 준비됨" : "서명 키 미설정"}
          />
          <AuthorizationMetric
            label="정책 버전"
            value={youtubeAuth?.configuration?.policyVersion || "미설정"}
            detail={`${youtubeAuth?.configuration?.allowedScopes?.length ?? 0}개 허용 범위`}
          />
          <AuthorizationMetric
            label="Viewer 대체 경로"
            value={youtubeAuth?.configuration?.fallbackViewer || "scp@supercent.io"}
            detail="외부 API 전환 전 읽기 전용 경로"
          />
        </div>

        <div className="divide-y divide-line">
          {(youtubeAuth?.connections ?? []).length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-balance text-sm font-semibold text-ink">추적 중인 YouTube 권한이 없습니다</p>
              <p className="mx-auto mt-1 max-w-xl text-pretty text-xs leading-5 text-ink-3">
                외부 로그인 도구의 서명된 상태 이벤트가 도착하면 프로그램·채널·scope·만료 상태가 여기에 표시됩니다.
              </p>
            </div>
          ) : (
            (youtubeAuth?.connections ?? []).map((connection) => (
              <YouTubeAuthorizationRow key={connection.id} connection={connection} />
            ))
          )}
        </div>
      </Card>

      <Card className="mt-4" data-testid="peoply-directory">
        <CardHeader
          title="사내 인명부"
          desc="Supercent HR 인명부 조회 전용 연동. 키는 서버에만 있으며 원문 응답은 저장·노출하지 않는다."
          action={
            peoplyStatusPending
              ? <Badge tone="neutral">확인 중</Badge>
              : peoplyStatus?.ok
                ? <Badge tone="ok">연동됨</Badge>
                : <Badge tone={peoplyStatus?.configured ? "danger" : "neutral"}>{peoplyErrorLabel(peoplyStatus?.peoplyError?.kind)}</Badge>
          }
        />
        <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          <PeoplyMetric label="설정 여부" value={peoplyStatus?.configured ? "설정됨" : "미설정"} />
          <PeoplyMetric label="키 상태" value={peoplyStatus?.status?.status || "확인 불가"} />
          <PeoplyMetric label="남은 기간" value={peoplyStatus?.status?.daysRemaining != null ? `${peoplyStatus.status.daysRemaining}일` : "확인 불가"} />
          <PeoplyMetric label="허용 scope" value={peoplyStatus?.status ? `${peoplyStatus.status.scopes.length}개` : "확인 불가"} detail={peoplyStatus?.status?.expiresAt ? `만료 ${formatDateTime(peoplyStatus.status.expiresAt)}` : undefined} />
        </div>
        <div className="grid grid-cols-1 gap-px border-t border-line bg-line sm:grid-cols-3" data-testid="peoply-my-context">
          <PeoplyMetric label="현재 사람" value={currentEmail || "확인 불가"} detail="로그인 계정 기준으로만 확인합니다." />
          <PeoplyMetric label="현재 조직" value={ownMailOrgDisplay.value} detail={ownMailOrgDisplay.detail} />
          <PeoplyMetric label="개인 메일 연결" value={ownMailContext ? (ownMailContext.personalMailConnectAllowed ? "허용됨" : "허용되지 않음") : "확인 불가"} detail="조직 정책과 개인 연결 상태를 별도로 판정합니다." />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-fill px-5 py-3">
          <select
            className="h-9 rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none"
            value={peoplyKind}
            onChange={(event) => setPeoplyKind(event.target.value as PeoplySearchKind)}
          >
            <option value="people">사람</option>
            <option value="orgs">조직</option>
            <option value="tfs">TF</option>
            <option value="workspace-groups">그룹</option>
          </select>
          <input
            className="h-9 min-w-0 flex-1 rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4"
            placeholder={peoplyRequiresQuery(peoplyKind) ? "검색어 (필수)" : "검색어 (비우면 전체)"}
            value={peoplyQuery}
            onChange={(event) => setPeoplyQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void runPeoplySearch(); }}
          />
          <Button size="sm" disabled={peoplySearchPending || (peoplyRequiresQuery(peoplyKind) && !peoplyQuery.trim())} onClick={runPeoplySearch}>
            {peoplySearchPending ? "검색 중" : "검색"}
          </Button>
        </div>
        {peoplySearchResult && !peoplySearchResult.ok && (
          <p className="px-5 py-2 text-xs text-danger">{peoplyErrorLabel(peoplySearchResult.peoplyError?.kind)}</p>
        )}
        <div className="divide-y divide-line">
          {(peoplySearchResult?.snapshot?.items ?? []).slice(0, 20).map((item, index) => (
            <PeoplyResultRow key={index} kind={peoplySearchResult!.kind} item={item} />
          ))}
          {peoplySearchResult?.ok && (peoplySearchResult.snapshot?.items.length ?? 0) === 0 && (
            <p className="px-5 py-4 text-center text-xs text-ink-3">검색 결과가 없습니다.</p>
          )}
        </div>
      </Card>

      <Card className="mt-4" data-testid="mail-accounts">
        <CardHeader
          title="메일 제공자·계정 설정"
          desc="SMTP/IMAP/OAuth 제공자와 계정 레코드, 조직 라우팅을 관리합니다. 멤버별 추가 메일함 접근은 멤버·권한 표에서 명시적으로 부여합니다."
          action={(
            <div className="flex items-center gap-2">
              {mailAccountsPending ? <Badge tone="neutral">불러오는 중</Badge> : <Badge tone="neutral">{mailAccounts.length}개</Badge>}
              <Button size="sm" variant="secondary" onClick={editingAccountId === "__new__" ? closeAccountForm : openAddAccountForm}>
                {editingAccountId === "__new__" ? "닫기" : "계정 추가"}
              </Button>
            </div>
          )}
        />
        {editingAccountId === "__new__" && (
          <MailAccountFormPanel
            form={accountForm}
            onChange={setAccountForm}
            onSubmit={() => void submitMailAccountForm(true)}
            onCancel={closeAccountForm}
            pending={accountFormPending}
            error={accountFormError}
            isNew
            orgDirectory={orgDirectory}
            onDiscoverOrgs={discoverOrgs}
          />
        )}
        <div className="divide-y divide-line">
          {!mailAccountsPending && mailAccounts.length === 0 && (
            <p className="px-5 py-8 text-center text-xs text-ink-3">등록된 메일 계정이 없습니다.</p>
          )}
          {mailAccounts.map((account) => (
            <div key={account.accountId}>
              <ListRow
                padding="l"
                className="flex-col items-stretch sm:flex-row sm:items-center"
                onClick={() => openEditAccountForm(account)}
                title={
                  <>
                    {account.label}
                    <Badge tone={mailAccountStatusTone(account.status, account.kind)}>{mailAccountStatusLabel(account.status, account.kind)}</Badge>
                  </>
                }
                subtitle={`${account.mailbox} · ${mailAccountKindLabel(account.kind)} · 소유자 ${account.ownerEmail}`}
                meta={(() => {
                  const routedOrgIds = routedOrgIdsByAccountId[account.accountId] ?? [];
                  const routedOrgNames = routedOrgIds.map((orgId) => orgDirectory[orgId] ?? orgId);
                  return (
                    <span title={routedOrgNames.length > 0 ? routedOrgNames.join(", ") : "명시된 라우팅 조직 없음"}>
                      명시 라우팅 조직 {routedOrgIds.length}개
                      {routedOrgNames.length > 0 ? ` · ${routedOrgNames.join(", ")}` : ""}
                    </span>
                  );
                })()}
                right={(() => {
                  const isOAuthKind = account.kind === "workspace_oauth";
                  const isBackfillCapable = account.status === "active"
                    && (account.kind === "workspace_oauth" || account.kind === "external_smtp_imap");
                  if (!isOAuthKind && !isBackfillCapable) return undefined;
                  const job = mailBackfillJobs[account.accountId];
                  const jobLabel = mailBackfillStatusLabel(job);
                  const backfillBusy = job?.status === "queued" || job?.status === "running";
                  return (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {isOAuthKind && (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={mailOAuthActionAccountId === account.accountId}
                            onClick={(event) => { event.stopPropagation(); runBeginMailOAuth(account.accountId); }}
                          >
                            {mailOAuthActionAccountId === account.accountId ? "연결 대기" : "Google 연결"}
                          </Button>
                          {mailOAuthCompanionFallback?.accountId === account.accountId && (
                            <a
                              href={mailOAuthCompanionFallback.consentUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex min-h-8 items-center rounded-md border border-line bg-paper px-3 text-xs font-semibold text-accent hover:bg-fill"
                              onClick={(event) => {
                                event.stopPropagation();
                                mailOAuthCompanionPendingRef.current = { accountId: account.accountId };
                              }}
                            >
                              Google 동의 열기
                            </a>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={mailOAuthActionAccountId === account.accountId || account.status !== "active"}
                            onClick={(event) => { event.stopPropagation(); runRevokeMailOAuth(account.accountId); }}
                          >
                            연결 해제
                          </Button>
                        </>
                      )}
                      {isBackfillCapable && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={mailBackfillActionAccountId === account.accountId || backfillBusy}
                            onClick={(event) => { event.stopPropagation(); runStartMailBackfill(account.accountId); }}
                          >
                            기록 불러오기 (30일)
                          </Button>
                          {jobLabel && (
                            <Badge tone={job?.status === "failed" ? "danger" : job?.status === "done" ? "ok" : "neutral"}>
                              {jobLabel}
                            </Badge>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}
              />
              {editingAccountId === account.accountId && (
                <MailAccountFormPanel
                  form={accountForm}
                  onChange={setAccountForm}
                  onSubmit={() => void submitMailAccountForm(false)}
                  onCancel={closeAccountForm}
                  pending={accountFormPending}
                  error={accountFormError}
                  isNew={false}
                  orgDirectory={orgDirectory}
                  onDiscoverOrgs={discoverOrgs}
                />
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-4" data-testid="mail-routing">
        <CardHeader
          title="조직 → 계정 라우팅"
          desc="조직별로 사용할 공유 메일 계정을 명시적으로 매핑합니다. 매핑이 없는 팀에는 공유 발신 계정을 자동 배정하지 않습니다."
          action={
            routingPending
              ? <Badge tone="neutral">저장 중</Badge>
              : Object.keys(routingPendingEdits).length > 0
                ? <Badge tone="warn">저장되지 않은 변경</Badge>
                : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <span className="text-xs font-semibold text-ink-3">신규 조직 매핑용 계정</span>
          <select
            value={routingDefaultDraft}
            disabled={routingPending}
            onChange={(event) => void applyRoutingChange({}, event.target.value)}
            className="h-9 rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none"
          >
            {activeMailAccounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>{account.label}</option>
            ))}
          </select>
          <span className="text-[11px] leading-5 text-ink-3">
            이 값은 새 조직 매핑 폼의 보조 선택값입니다. 매핑이 없는 사용자의 발신 계정이나 기본 SCP 권한을 결정하지 않습니다.
          </span>
        </div>
        <div className="divide-y divide-line">
          {routingRows.length === 0 && (
            <p className="px-5 py-6 text-center text-xs text-ink-3">명시적 조직 매핑이 없습니다. 팀 공유 발신 계정은 자동으로 배정되지 않습니다.</p>
          )}
          {routingRows.map(({ orgId, displayedAccountId, isPendingRemove, isPendingAdd, isPendingChange }) => (
            <div key={orgId} data-testid="mail-routing-row" data-org-id={orgId} data-pending-remove={isPendingRemove || undefined}>
              <ListRow
                padding="m"
                title={orgDirectory[orgId] ?? orgId}
                subtitle={
                  isPendingRemove
                    ? "삭제 예정 — 저장 전까지는 유지됩니다"
                    : isPendingAdd
                      ? "추가 예정 — 저장 전까지는 반영되지 않습니다"
                      : isPendingChange
                        ? "변경 예정 — 저장 전까지는 반영되지 않습니다"
                        : (orgDirectory[orgId] ? orgId : undefined)
                }
                right={
                  isPendingRemove ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={routingPending}
                      onClick={() => setRoutingPendingEdits((prev) => { const next = { ...prev }; delete next[orgId]; return next; })}
                    >
                      삭제 취소
                    </Button>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <select
                        value={displayedAccountId}
                        disabled={routingPending}
                        onChange={(event) => setRoutingPendingEdits((prev) => ({ ...prev, [orgId]: event.target.value }))}
                        className="h-8 rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none"
                      >
                        {activeMailAccounts.map((account) => (
                          <option key={account.accountId} value={account.accountId}>{account.label}</option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={routingPending}
                        onClick={() => {
                          if (isPendingAdd) {
                            // 저장 전 순수 로컬 추가였다 — 삭제 대기로 보낼 필요 없이 그냥 취소한다.
                            setRoutingPendingEdits((prev) => { const next = { ...prev }; delete next[orgId]; return next; });
                          } else {
                            setRoutingPendingEdits((prev) => ({ ...prev, [orgId]: null }));
                          }
                        }}
                      >
                        제거
                      </Button>
                    </div>
                  )
                }
              />
            </div>
          ))}
        </div>
        <div className="border-t border-line bg-fill px-5 py-3">
          <p className="mb-1.5 text-xs font-semibold text-ink-3">조직 매핑 추가 (대기 목록에 담김 — 저장을 눌러야 반영됩니다)</p>
          <RoutingOrgAdder
            existingOrgIds={routingRows.filter((row) => !row.isPendingRemove).map((row) => row.orgId)}
            disabled={routingPending || !routingDefaultDraft}
            orgDirectory={orgDirectory}
            onDiscoverOrgs={discoverOrgs}
            onAdd={(orgId) => setRoutingPendingEdits((prev) => ({ ...prev, [orgId]: routingDefaultDraft }))}
          />
          {!routingDefaultDraft && (
            <p className="mt-1 text-[11px] text-warn">먼저 신규 매핑에 사용할 활성 공유 계정을 선택하세요.</p>
          )}
          <Button
            className="mt-2"
            size="sm"
            disabled={routingPending || Object.keys(routingPendingEdits).length === 0}
            onClick={() => void saveRoutingChanges()}
            data-testid="mail-routing-save"
          >
            저장
          </Button>
        </div>
      </Card>

      <Card className="mt-4" data-testid="personal-mail-allowed-orgs">
        <CardHeader
          title="조직 → 개인 메일 연결 허용"
          desc="허용된 조직만 개인 메일함을 연결하고 Chat에서 계정 보기를 전환할 수 있습니다. 미설정 시 전 조직 허용(도입 전 동작 유지)."
          action={
            personalMailAllowedPending
              ? <Badge tone="neutral">저장 중</Badge>
              : orgAllowlistPendingCount(personalMailAllowedStaged) > 0
                ? <Badge tone="warn">저장되지 않은 변경</Badge>
                : undefined
          }
        />
        <div className="divide-y divide-line">
          {mailRouting?.personalMailAllowedOrgIds === null && (
            <p className="px-5 py-6 text-center text-xs text-ink-3">설정 안 됨 — 모든 조직이 개인 메일 연결을 허용받습니다.</p>
          )}
          {mailRouting?.personalMailAllowedOrgIds !== null && (mailRouting?.personalMailAllowedOrgIds.length ?? 0) === 0 && (
            <p className="px-5 py-6 text-center text-xs text-ink-3">허용된 조직이 없습니다. 모든 조직이 조직 계정만 봅니다.</p>
          )}
          {(mailRouting?.personalMailAllowedOrgIds ?? []).map((orgId) => {
            const pendingRemove = personalMailAllowedStaged.remove.includes(orgId);
            return (
              <div key={orgId} data-testid="personal-mail-allowed-org-row" data-org-id={orgId} data-pending-remove={pendingRemove || undefined}>
                <ListRow
                  padding="m"
                  title={orgDirectory[orgId] ?? orgId}
                  subtitle={pendingRemove ? "삭제 예정 — 저장 전까지는 유지됩니다" : (orgDirectory[orgId] ? orgId : undefined)}
                  right={
                    pendingRemove ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={personalMailAllowedPending}
                        onClick={() => setPersonalMailAllowedStaged((prev) => ({ ...prev, remove: prev.remove.filter((id) => id !== orgId) }))}
                      >
                        삭제 취소
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={personalMailAllowedPending}
                        onClick={() => setPersonalMailAllowedStaged((prev) => ({ ...prev, remove: [...prev.remove, orgId] }))}
                      >
                        제거
                      </Button>
                    )
                  }
                />
              </div>
            );
          })}
        </div>
        {personalMailAllowedStaged.add.length > 0 && (
          <div className="divide-y divide-line border-t border-line bg-warn-soft/40" data-testid="personal-mail-allowed-pending-adds">
            {personalMailAllowedStaged.add.map((orgId) => (
              <div key={orgId} data-testid="personal-mail-allowed-pending-add-row" data-org-id={orgId}>
                <ListRow
                  padding="m"
                  title={orgDirectory[orgId] ?? orgId}
                  subtitle="추가 예정 — 저장 전까지는 반영되지 않습니다"
                  right={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPersonalMailAllowedStaged((prev) => ({ ...prev, add: prev.add.filter((id) => id !== orgId) }))}
                    >
                      취소
                    </Button>
                  }
                />
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-line bg-fill px-5 py-3">
          <p className="mb-1.5 text-xs font-semibold text-ink-3">허용 조직 추가 (대기 목록에 담김 — 저장을 눌러야 반영됩니다)</p>
          <RoutingOrgAdder
            existingOrgIds={nextOrgIdsAfterAllowlistPending(mailRouting?.personalMailAllowedOrgIds ?? [], personalMailAllowedStaged)}
            disabled={personalMailAllowedPending}
            orgDirectory={orgDirectory}
            onDiscoverOrgs={discoverOrgs}
            onAdd={(orgId) => setPersonalMailAllowedStaged((prev) => ({ ...prev, add: [...prev.add, orgId], remove: prev.remove.filter((id) => id !== orgId) }))}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={personalMailAllowedPending || orgAllowlistPendingCount(personalMailAllowedStaged) === 0}
              onClick={() => void savePersonalMailAllowedChanges()}
              data-testid="personal-mail-allowed-save"
            >
              저장
            </Button>
            {mailRouting?.personalMailAllowedOrgIds !== null && (
              <Button
                size="sm"
                variant="ghost"
                disabled={personalMailAllowedPending}
                onClick={() => void applyPersonalMailAllowedOrgsChange(null)}
              >
                설정 초기화 (전 조직 허용으로 되돌리기)
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="mt-4" data-testid="chat-personal-view-default-orgs">
        <CardHeader
          title="조직 → Chat 기본 보기 = 내 메일함"
          desc="처음 Chat을 여는 순간 조직 계정 대신 본인이 연결한 메일함을 기본으로 봅니다(예: AI Drama). 미설정 시 모든 조직이 조직 계정을 기본으로 봅니다."
          action={
            chatPersonalViewDefaultPending
              ? <Badge tone="neutral">저장 중</Badge>
              : orgAllowlistPendingCount(chatPersonalViewDefaultStaged) > 0
                ? <Badge tone="warn">저장되지 않은 변경</Badge>
                : undefined
          }
        />
        <div className="divide-y divide-line">
          {(mailRouting?.chatPersonalViewDefaultOrgIds.length ?? 0) === 0 && (
            <p className="px-5 py-6 text-center text-xs text-ink-3">설정된 조직이 없습니다. 모든 조직이 조직 계정을 기본으로 봅니다.</p>
          )}
          {(mailRouting?.chatPersonalViewDefaultOrgIds ?? []).map((orgId) => {
            const pendingRemove = chatPersonalViewDefaultStaged.remove.includes(orgId);
            return (
              <div key={orgId} data-testid="chat-personal-view-default-org-row" data-org-id={orgId} data-pending-remove={pendingRemove || undefined}>
                <ListRow
                  padding="m"
                  title={orgDirectory[orgId] ?? orgId}
                  subtitle={pendingRemove ? "삭제 예정 — 저장 전까지는 유지됩니다" : (orgDirectory[orgId] ? orgId : undefined)}
                  right={
                    pendingRemove ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={chatPersonalViewDefaultPending}
                        onClick={() => setChatPersonalViewDefaultStaged((prev) => ({ ...prev, remove: prev.remove.filter((id) => id !== orgId) }))}
                      >
                        삭제 취소
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={chatPersonalViewDefaultPending}
                        onClick={() => setChatPersonalViewDefaultStaged((prev) => ({ ...prev, remove: [...prev.remove, orgId] }))}
                      >
                        제거
                      </Button>
                    )
                  }
                />
              </div>
            );
          })}
        </div>
        {chatPersonalViewDefaultStaged.add.length > 0 && (
          <div className="divide-y divide-line border-t border-line bg-warn-soft/40" data-testid="chat-personal-view-default-pending-adds">
            {chatPersonalViewDefaultStaged.add.map((orgId) => (
              <div key={orgId} data-testid="chat-personal-view-default-pending-add-row" data-org-id={orgId}>
                <ListRow
                  padding="m"
                  title={orgDirectory[orgId] ?? orgId}
                  subtitle="추가 예정 — 저장 전까지는 반영되지 않습니다"
                  right={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setChatPersonalViewDefaultStaged((prev) => ({ ...prev, add: prev.add.filter((id) => id !== orgId) }))}
                    >
                      취소
                    </Button>
                  }
                />
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-line bg-fill px-5 py-3">
          <p className="mb-1.5 text-xs font-semibold text-ink-3">기본 보기 조직 추가 (대기 목록에 담김 — 저장을 눌러야 반영됩니다)</p>
          <RoutingOrgAdder
            existingOrgIds={nextOrgIdsAfterAllowlistPending(mailRouting?.chatPersonalViewDefaultOrgIds ?? [], chatPersonalViewDefaultStaged)}
            disabled={chatPersonalViewDefaultPending}
            orgDirectory={orgDirectory}
            onDiscoverOrgs={discoverOrgs}
            onAdd={(orgId) => setChatPersonalViewDefaultStaged((prev) => ({ ...prev, add: [...prev.add, orgId], remove: prev.remove.filter((id) => id !== orgId) }))}
          />
          <Button
            className="mt-2"
            size="sm"
            disabled={chatPersonalViewDefaultPending || orgAllowlistPendingCount(chatPersonalViewDefaultStaged) === 0}
            onClick={() => void saveChatPersonalViewDefaultChanges()}
            data-testid="chat-personal-view-default-save"
          >
            저장
          </Button>
        </div>
      </Card>

      <Card className="mt-4" data-testid="scp-allowed-orgs">
        <CardHeader
          title="SCP 히스토리 조직 목록"
          desc="2026-09-27 정책 변경: 이 목록이 scp 접근을 직접 결정합니다 — 여기 없는 조직은 team 라우팅(byOrgId)에 scp가 매핑되어 있어도 Chat 보기·발신 권한이 없습니다(슈퍼관리자 자신의 세션은 예외). 미설정(null)이면 team 라우팅으로 scp에 매핑된 모든 비-슈퍼관리자 조직이 접근을 잃습니다."
          action={
            scpAllowedPending
              ? <Badge tone="neutral">저장 중</Badge>
              : orgAllowlistPendingCount(scpAllowedStaged) > 0
                ? <Badge tone="warn">저장되지 않은 변경</Badge>
                : undefined
          }
        />
        {!isSuperAdmin && (
          <p className="border-b border-line bg-fill px-5 py-2 text-xs text-ink-3">
            읽기 전용 — 슈퍼관리자만 편집할 수 있습니다.
          </p>
        )}
        <div className="divide-y divide-line">
          {mailRouting?.scpAllowedOrgIds === null && (
            <p className="px-5 py-6 text-center text-xs text-ink-3">이전 SCP 목록이 설정되지 않았습니다. 팀 공유 발신 권한은 명시적 계정 매핑이 있어야 합니다.</p>
          )}
          {mailRouting?.scpAllowedOrgIds !== null && (mailRouting?.scpAllowedOrgIds.length ?? 0) === 0 && (
            <p className="px-5 py-6 text-center text-xs text-ink-3">이전 SCP 허용 조직이 없습니다. 팀 공유 발신 권한은 명시적 계정 매핑이 있어야 합니다.</p>
          )}
          {(mailRouting?.scpAllowedOrgIds ?? []).map((orgId) => {
            const pendingRemove = scpAllowedStaged.remove.includes(orgId);
            return (
              <div key={orgId} data-testid="scp-allowed-org-row" data-org-id={orgId} data-pending-remove={pendingRemove || undefined}>
                <ListRow
                  padding="m"
                  title={orgDirectory[orgId] ?? orgId}
                  subtitle={pendingRemove ? "삭제 예정 — 저장 전까지는 유지됩니다" : (orgDirectory[orgId] ? orgId : undefined)}
                  right={
                    pendingRemove ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!isSuperAdmin || scpAllowedPending}
                        onClick={() => setScpAllowedStaged((prev) => ({ ...prev, remove: prev.remove.filter((id) => id !== orgId) }))}
                      >
                        삭제 취소
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!isSuperAdmin || scpAllowedPending}
                        onClick={() => setScpAllowedStaged((prev) => ({ ...prev, remove: [...prev.remove, orgId] }))}
                      >
                        제거
                      </Button>
                    )
                  }
                />
              </div>
            );
          })}
        </div>
        {scpAllowedStaged.add.length > 0 && (
          <div className="divide-y divide-line border-t border-line bg-warn-soft/40" data-testid="scp-allowed-pending-adds">
            {scpAllowedStaged.add.map((orgId) => (
              <div key={orgId} data-testid="scp-allowed-pending-add-row" data-org-id={orgId}>
                <ListRow
                  padding="m"
                  title={orgDirectory[orgId] ?? orgId}
                  subtitle="추가 예정 — 저장 전까지는 반영되지 않습니다"
                  right={
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!isSuperAdmin}
                      onClick={() => setScpAllowedStaged((prev) => ({ ...prev, add: prev.add.filter((id) => id !== orgId) }))}
                    >
                      취소
                    </Button>
                  }
                />
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-line bg-fill px-5 py-3">
          <p className="mb-1.5 text-xs font-semibold text-ink-3">이전 SCP 목록 확인 (저장해도 팀 계정 명시 매핑을 대신하지 않습니다)</p>
          <RoutingOrgAdder
            existingOrgIds={nextOrgIdsAfterAllowlistPending(mailRouting?.scpAllowedOrgIds ?? [], scpAllowedStaged)}
            disabled={!isSuperAdmin || scpAllowedPending}
            orgDirectory={orgDirectory}
            onDiscoverOrgs={discoverOrgs}
            onAdd={(orgId) => setScpAllowedStaged((prev) => ({ ...prev, add: [...prev.add, orgId], remove: prev.remove.filter((id) => id !== orgId) }))}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!isSuperAdmin || scpAllowedPending || orgAllowlistPendingCount(scpAllowedStaged) === 0}
              onClick={() => void saveScpAllowedChanges()}
              data-testid="scp-allowed-save"
            >
              저장
            </Button>
            {mailRouting?.scpAllowedOrgIds !== null && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!isSuperAdmin || scpAllowedPending}
                onClick={() => {
                  if (!window.confirm("이 목록을 초기화(미설정)하면, team 라우팅(byOrgId)으로 scp에 매핑된 모든 비-슈퍼관리자 조직이 scp Chat 보기·발신 권한을 즉시 잃습니다(슈퍼관리자 자신의 세션은 예외). 계속할까요?")) return;
                  void applyScpAllowedOrgsChange(null).then((ok) => { if (ok) setScpAllowedStaged(EMPTY_ORG_ALLOWLIST_PENDING); });
                }}
              >
                이전 목록 초기화
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="mt-4" data-testid="org-tab-presets">
        <CardHeader
          title="조직 → 탭 프리셋"
          desc="조직별로 Flu 사이드바에 보일 탭을 지정합니다. 프리셋이 없는 조직은 현재 탭을 전부 봅니다."
          action={
            tabPresetsLoading
              ? <Badge tone="neutral">불러오는 중</Badge>
              : tabPresetsPending
                ? <Badge tone="neutral">저장 중</Badge>
                : Object.keys(tabPresetsPendingEdits).length > 0
                  ? <Badge tone="warn">저장되지 않은 변경</Badge>
                  : undefined
          }
        />
        <div className="divide-y divide-line">
          {!tabPresetsLoading && tabPresetRows.length === 0 && (
            <p className="px-5 py-6 text-center text-xs text-ink-3">조직 프리셋이 없습니다. 모든 조직이 현재 탭을 전부 봅니다.</p>
          )}
          {tabPresetRows.map(({ orgId, navKeys, isPendingRemove, isPendingAdd, isPendingChange }) => (
            <div key={orgId} data-testid="org-tab-preset-row" data-org-id={orgId} data-pending-remove={isPendingRemove || undefined} className="px-5 py-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{orgDirectory[orgId] ?? orgId}</p>
                  {orgDirectory[orgId] && <p className="truncate text-[11px] text-ink-3">{orgId}</p>}
                  {isPendingRemove && <p className="text-[11px] font-semibold text-warn">해제 예정 — 저장 전까지는 유지됩니다</p>}
                  {isPendingAdd && <p className="text-[11px] font-semibold text-warn">추가 예정 — 저장 전까지는 반영되지 않습니다</p>}
                  {isPendingChange && <p className="text-[11px] font-semibold text-warn">변경 예정 — 저장 전까지는 반영되지 않습니다</p>}
                </div>
                {isPendingRemove ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={tabPresetsPending}
                    onClick={() => setTabPresetsPendingEdits((prev) => { const next = { ...prev }; delete next[orgId]; return next; })}
                  >
                    해제 취소
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={tabPresetsPending} onClick={() => stageOrgTabPresetChange(orgId, null)}>
                    프리셋 해제
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {FLU_NAV.map((item) => {
                  const checked = navKeys.includes(item.key);
                  return (
                    <label
                      key={item.key}
                      className={`flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                        checked ? "bg-accent-soft text-accent" : "bg-fill text-ink-3 hover:text-ink"
                      } ${tabPresetsPending || isPendingRemove ? "pointer-events-none opacity-60" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        disabled={tabPresetsPending || isPendingRemove}
                        onChange={() => toggleOrgTabPresetKey(orgId, item.key)}
                      />
                      {item.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-line bg-fill px-5 py-3">
          <p className="mb-1.5 text-xs font-semibold text-ink-3">조직 프리셋 추가 (대기 목록에 담김 — 저장을 눌러야 반영됩니다)</p>
          <RoutingOrgAdder
            existingOrgIds={tabPresetRows.filter((row) => !row.isPendingRemove).map((row) => row.orgId)}
            disabled={tabPresetsPending}
            orgDirectory={orgDirectory}
            onDiscoverOrgs={discoverOrgs}
            onAdd={(orgId) => stageOrgTabPresetChange(orgId, FLU_NAV.map((item) => item.key))}
          />
          <Button
            className="mt-2"
            size="sm"
            disabled={tabPresetsPending || Object.keys(tabPresetsPendingEdits).length === 0}
            onClick={() => void saveTabPresetChanges()}
            data-testid="org-tab-presets-save"
          >
            저장
          </Button>
        </div>
      </Card>

      {notice && (
        <div
          className={`mt-3 rounded-md border px-4 py-3 text-sm ${
            notice.tone === "success"
              ? "border-ok/30 bg-ok-soft text-ok"
              : "border-danger/30 bg-danger-soft text-danger"
          }`}
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          data-testid="integration-operation-notice"
        >
          {notice.message}
        </div>
      )}
    </div>
  );
}

function mailAccountKindLabel(kind: MailAccountPublic["kind"]) {
  const labels: Record<MailAccountPublic["kind"], string> = {
    canonical_scp: "SCP 정본",
    workspace_oauth: "Workspace 개인 계정",
    external_smtp_imap: "외부 SMTP/IMAP",
  };
  return labels[kind];
}

function mailAccountStatusTone(
  status: MailAccountPublic["status"],
  kind?: MailAccountPublic["kind"],
): "neutral" | "info" | "warn" | "ok" {
  // An OAuth account's `active` flag means the mail_accounts record is enabled. It does not
  // prove that its provider credential still works, so keep it informational in the inventory.
  if (status === "active" && kind === "workspace_oauth") return "info";
  if (status === "active") return "ok";
  if (status === "pending_auth") return "warn";
  return "neutral";
}

function mailAccountStatusLabel(status: MailAccountPublic["status"], kind?: MailAccountPublic["kind"]) {
  if (status === "active" && kind === "workspace_oauth") return "연결 기록 있음";
  const labels: Record<MailAccountPublic["status"], string> = {
    active: "활성",
    disabled: "비활성",
    pending_auth: "인증 대기",
  };
  return labels[status];
}

// ---------- PLAN-ORG-MAIL-IDENTITY Slice 5: account add/edit form + routing org picker ----------

const MAIL_ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const MAILBOX_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Mirrors functions/mailTransport.ts's exported MAIL_EXT_SECRET_NAME_PATTERN (2026-09-10
// adversarial review CRITICAL-1) — client-side check only, the server re-validates.
const MAIL_EXT_SECRET_REF_PATTERN = /^env:MAIL_EXT_[A-Z0-9_]{3,50}$/;

type MailAccountFormState = {
  accountId: string;
  label: string;
  mailbox: string;
  kind: MailAccountKind;
  status: MailAccountStatus;
  ownerEmail: string;
  orgIds: string[];
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpAuthUser: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapAuthUser: string;
  imapMailbox: string;
  secretRef: string;
};

function emptyMailAccountForm(): MailAccountFormState {
  return {
    accountId: "",
    label: "",
    mailbox: "",
    kind: "external_smtp_imap",
    status: "pending_auth",
    ownerEmail: "",
    orgIds: [],
    smtpHost: "",
    smtpPort: "",
    smtpSecure: true,
    smtpAuthUser: "",
    imapHost: "",
    imapPort: "",
    imapSecure: true,
    imapAuthUser: "",
    imapMailbox: "INBOX",
    secretRef: "",
  };
}

function mailAccountFormFromAccount(account: MailAccountPublic): MailAccountFormState {
  const smtp = account.smtp;
  const imap = account.imap;
  return {
    accountId: account.accountId,
    label: account.label,
    mailbox: account.mailbox,
    kind: account.kind,
    status: account.status,
    ownerEmail: account.ownerEmail,
    orgIds: account.orgIds,
    smtpHost: typeof smtp.host === "string" ? smtp.host : "",
    smtpPort: typeof smtp.port === "number" ? String(smtp.port) : "",
    smtpSecure: smtp.secure !== false,
    smtpAuthUser: typeof smtp.authUser === "string" ? smtp.authUser : "",
    imapHost: typeof imap.host === "string" ? imap.host : "",
    imapPort: typeof imap.port === "number" ? String(imap.port) : "",
    imapSecure: imap.secure !== false,
    imapAuthUser: typeof imap.authUser === "string" ? imap.authUser : "",
    imapMailbox: typeof imap.mailbox === "string" ? imap.mailbox : "",
    // secretRef itself is never returned by the server (SEC-P0-009) — blank means "keep as-is"
    // (buildMailAccountPayload omits the field entirely unless the admin types a new value).
    secretRef: "",
  };
}

function buildMailAccountPayload(form: MailAccountFormState): UpsertMailAccountPayload {
  const payload: UpsertMailAccountPayload = {
    accountId: form.accountId,
    label: form.label.trim(),
    mailbox: form.mailbox.trim().toLowerCase(),
    kind: form.kind,
    status: form.status,
    ownerEmail: form.ownerEmail.trim().toLowerCase(),
    orgIds: form.orgIds,
  };
  if (form.kind === "external_smtp_imap") {
    const smtpPort = Number(form.smtpPort);
    const imapPort = Number(form.imapPort);
    payload.smtp = {
      host: form.smtpHost.trim(),
      ...(Number.isFinite(smtpPort) && smtpPort > 0 ? { port: smtpPort } : {}),
      secure: form.smtpSecure,
      authUser: form.smtpAuthUser.trim(),
    };
    payload.imap = {
      host: form.imapHost.trim(),
      ...(Number.isFinite(imapPort) && imapPort > 0 ? { port: imapPort } : {}),
      secure: form.imapSecure,
      authUser: form.imapAuthUser.trim(),
      mailbox: form.imapMailbox.trim(),
    };
  }
  if (form.secretRef.trim()) payload.secretRef = form.secretRef.trim();
  return payload;
}

function MailAccountFormPanel({
  form,
  onChange,
  onSubmit,
  onCancel,
  pending,
  error,
  isNew,
  orgDirectory,
  onDiscoverOrgs,
}: {
  form: MailAccountFormState;
  onChange: (next: MailAccountFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  pending: boolean;
  error: string;
  isNew: boolean;
  orgDirectory: Record<string, string>;
  onDiscoverOrgs: (orgs: PeoplyOrganization[]) => void;
}) {
  const scpLocked = !isNew && form.accountId === "scp";
  function set<K extends keyof MailAccountFormState>(key: K, value: MailAccountFormState[K]) {
    onChange({ ...form, [key]: value });
  }

  return (
    <div className="space-y-3 border-b border-line bg-fill/60 px-5 py-4" data-testid="mail-account-form" onClick={(event) => event.stopPropagation()}>
      <div className="grid gap-3 sm:grid-cols-2">
        {isNew && (
          <label className="block text-xs font-semibold text-ink-3">
            계정 ID
            <input
              value={form.accountId}
              onChange={(event) => set("accountId", event.target.value.trim().toLowerCase())}
              placeholder="acme-corp"
              className="mt-1.5 h-9 w-full rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4"
            />
          </label>
        )}
        <label className="block text-xs font-semibold text-ink-3">
          표시명
          <input
            value={form.label}
            onChange={(event) => set("label", event.target.value)}
            className="mt-1.5 h-9 w-full rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4"
          />
        </label>
        <label className="block text-xs font-semibold text-ink-3">
          사서함 주소
          <input
            value={form.mailbox}
            disabled={scpLocked}
            onChange={(event) => set("mailbox", event.target.value)}
            placeholder="ops@example.com"
            className="mt-1.5 h-9 w-full rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
          />
        </label>
        <label className="block text-xs font-semibold text-ink-3">
          종류
          <select
            value={form.kind}
            disabled={scpLocked}
            onChange={(event) => set("kind", event.target.value as MailAccountKind)}
            className="mt-1.5 h-9 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none disabled:opacity-50"
          >
            <option value="external_smtp_imap">외부 SMTP/IMAP</option>
            <option value="workspace_oauth">Workspace 개인 계정</option>
            <option value="canonical_scp">SCP 정본</option>
          </select>
        </label>
        <label className="block text-xs font-semibold text-ink-3">
          상태
          <select
            value={form.status}
            disabled={scpLocked}
            onChange={(event) => set("status", event.target.value as MailAccountStatus)}
            className="mt-1.5 h-9 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none disabled:opacity-50"
          >
            <option value="active">활성</option>
            <option value="disabled">비활성</option>
            <option value="pending_auth">연결 대기</option>
          </select>
        </label>
      </div>

      <div>
        <p className="text-xs font-semibold text-ink-3">소유자 (사내 인명부)</p>
        <div className="mt-1.5">
          <PeoplyPersonPicker value={form.ownerEmail} onChange={(email) => set("ownerEmail", email)} disabled={scpLocked} />
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-ink-3">매핑 조직 (사내 조직)</p>
        <div className="mt-1.5">
          <OrgMultiPicker value={form.orgIds} onChange={(orgIds) => set("orgIds", orgIds)} orgDirectory={orgDirectory} onDiscoverOrgs={onDiscoverOrgs} />
        </div>
      </div>

      {form.kind === "external_smtp_imap" && !scpLocked && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-line p-3">
            <p className="text-xs font-semibold text-ink-3">SMTP</p>
            <div className="mt-2 space-y-2">
              <input value={form.smtpHost} onChange={(event) => set("smtpHost", event.target.value)} placeholder="Host" className="h-8 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none placeholder:text-ink-4" />
              <div className="flex gap-2">
                <input value={form.smtpPort} onChange={(event) => set("smtpPort", event.target.value)} placeholder="Port" className="h-8 w-20 rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none placeholder:text-ink-4" />
                <label className="flex h-8 items-center gap-1.5 text-xs text-ink-3">
                  <input type="checkbox" checked={form.smtpSecure} onChange={(event) => set("smtpSecure", event.target.checked)} />
                  TLS
                </label>
              </div>
              <input value={form.smtpAuthUser} onChange={(event) => set("smtpAuthUser", event.target.value)} placeholder="Auth user" className="h-8 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none placeholder:text-ink-4" />
            </div>
          </div>
          <div className="rounded-md border border-line p-3">
            <p className="text-xs font-semibold text-ink-3">IMAP</p>
            <div className="mt-2 space-y-2">
              <input value={form.imapHost} onChange={(event) => set("imapHost", event.target.value)} placeholder="Host" className="h-8 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none placeholder:text-ink-4" />
              <div className="flex gap-2">
                <input value={form.imapPort} onChange={(event) => set("imapPort", event.target.value)} placeholder="Port" className="h-8 w-20 rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none placeholder:text-ink-4" />
                <label className="flex h-8 items-center gap-1.5 text-xs text-ink-3">
                  <input type="checkbox" checked={form.imapSecure} onChange={(event) => set("imapSecure", event.target.checked)} />
                  TLS
                </label>
              </div>
              <input value={form.imapAuthUser} onChange={(event) => set("imapAuthUser", event.target.value)} placeholder="Auth user" className="h-8 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none placeholder:text-ink-4" />
              <input value={form.imapMailbox} onChange={(event) => set("imapMailbox", event.target.value)} placeholder="수신함 (INBOX)" className="h-8 w-full rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none placeholder:text-ink-4" />
            </div>
          </div>
          <label className="block text-xs font-semibold text-ink-3 sm:col-span-2">
            시크릿 참조 (env:NAME)
            <input
              value={form.secretRef}
              onChange={(event) => set("secretRef", event.target.value)}
              placeholder="env:MAIL_EXT_ACME_IMAP_PASSWORD"
              className="mt-1.5 h-9 w-full rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4"
            />
            <span className="mt-1 block text-[11px] font-normal text-ink-4">
              Secret Manager 이름은 MAIL_EXT_ 로 시작해야 합니다. 비밀번호 값 자체는 여기 저장되지 않습니다 — Secret Manager에 같은 이름의 시크릿을 먼저 등록해 주세요.
            </span>
          </label>
        </div>
      )}

      {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">{error}</div>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>취소</Button>
        <Button type="button" size="sm" disabled={pending} onClick={onSubmit}>
          {pending ? "저장 중" : isNew ? "추가" : "저장"}
        </Button>
      </div>
    </div>
  );
}

function PeoplyPersonPicker({ value, onChange, disabled }: { value: string; onChange: (email: string) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PeoplyPerson[]>([]);
  // 2026-09-10 adversarial review LOW-9: out-of-order responses (a slower earlier search
  // resolving after a faster later one) must never overwrite the latest search's results.
  const latestRequestSeq = useRef(0);

  async function search() {
    if (!query.trim()) return;
    const seq = ++latestRequestSeq.current;
    setPending(true);
    try {
      const response = await searchPeoplyDirectory({ kind: "people", q: query.trim() });
      if (seq !== latestRequestSeq.current) return;
      setResults(response.ok && response.snapshot ? (response.snapshot.items as PeoplyPerson[]) : []);
    } catch {
      if (seq !== latestRequestSeq.current) return;
      setResults([]);
    } finally {
      if (seq === latestRequestSeq.current) {
        setOpen(true);
        setPending(false);
      }
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <input
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="name@supercent.io"
          className="h-9 min-w-0 flex-1 rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
        />
        <input
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !pending) { event.preventDefault(); void search(); } }}
          placeholder="이름/이메일 검색"
          className="h-9 w-36 rounded-md border border-line bg-paper px-2 text-xs text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
        />
        <Button type="button" size="sm" variant="secondary" disabled={disabled || pending || !query.trim()} onClick={search}>
          검색
        </Button>
      </div>
      {open && !disabled && (
        <div className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-line bg-paper">
          {results.length === 0 && <p className="px-3 py-2 text-xs text-ink-3">검색 결과가 없습니다.</p>}
          {results.map((person) => (
            <button
              type="button"
              key={person.id || person.email}
              onClick={() => { onChange(person.email); setOpen(false); }}
              className="block w-full px-3 py-2 text-left text-xs hover:bg-fill"
            >
              <span className="font-semibold text-ink">{person.displayName || person.email}</span>
              <span className="ml-2 text-ink-3">{person.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OrgMultiPicker({
  value,
  onChange,
  orgDirectory,
  onDiscoverOrgs,
}: {
  value: string[];
  onChange: (orgIds: string[]) => void;
  orgDirectory: Record<string, string>;
  onDiscoverOrgs: (orgs: PeoplyOrganization[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<OrgSearchMatch<PeoplyOrganization>[]>([]);
  // 2026-09-10 adversarial review LOW-9: out-of-order responses (a slower earlier search
  // resolving after a faster later one) must never overwrite the latest search's results.
  const latestRequestSeq = useRef(0);

  async function search() {
    const seq = ++latestRequestSeq.current;
    setPending(true);
    try {
      const response = await searchPeoplyDirectory({ kind: "orgs", q: query.trim() });
      if (seq !== latestRequestSeq.current) return;
      const orgs = response.ok && response.snapshot ? (response.snapshot.items as PeoplyOrganization[]) : [];
      setResults(filterOrgsByQuery(orgs, query, orgDirectory));
      onDiscoverOrgs(orgs);
    } catch {
      if (seq !== latestRequestSeq.current) return;
      setResults([]);
    } finally {
      if (seq === latestRequestSeq.current) {
        setOpen(true);
        setPending(false);
      }
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {value.map((orgId) => (
          <Badge key={orgId} tone="accent">
            {orgDirectory[orgId] ?? orgId}
            <button
              type="button"
              onClick={() => onChange(value.filter((id) => id !== orgId))}
              aria-label={`${orgDirectory[orgId] ?? orgId} 제거`}
              className="ml-1 text-accent/70 hover:text-accent"
            >
              ×
            </button>
          </Badge>
        ))}
        {value.length === 0 && <span className="text-xs text-ink-4">매핑된 조직 없음</span>}
      </div>
      <div className="mt-1.5 flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !pending) { event.preventDefault(); void search(); } }}
          placeholder="조직명 검색 (비우면 전체)"
          className="h-9 min-w-0 flex-1 rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4"
        />
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={search}>
          검색
        </Button>
      </div>
      {open && (
        <div className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-line bg-paper">
          {results.length === 0 && <p className="px-3 py-2 text-xs text-ink-3">검색 결과가 없습니다.</p>}
          {results.map(({ org, matchedVia, parentName }) => (
            <button
              type="button"
              key={org.id}
              disabled={value.includes(org.id)}
              onClick={() => { onChange([...value, org.id]); setOpen(false); }}
              className="block w-full px-3 py-2 text-left text-xs hover:bg-fill disabled:opacity-40"
            >
              <span className="font-semibold text-ink">{org.name}</span>
              <span className="ml-2 text-ink-3">{org.id}</span>
              {matchedVia === "parent" && parentName && <span className="ml-2 text-ink-4">(상위: {parentName})</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RoutingOrgAdder({
  existingOrgIds,
  disabled,
  orgDirectory,
  onDiscoverOrgs,
  onAdd,
}: {
  existingOrgIds: string[];
  disabled?: boolean;
  orgDirectory: Record<string, string>;
  onDiscoverOrgs: (orgs: PeoplyOrganization[]) => void;
  onAdd: (orgId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<OrgSearchMatch<PeoplyOrganization>[]>([]);

  async function search() {
    setPending(true);
    try {
      const response = await searchPeoplyDirectory({ kind: "orgs", q: query.trim() });
      const orgs = response.ok && response.snapshot ? (response.snapshot.items as PeoplyOrganization[]) : [];
      setResults(filterOrgsByQuery(orgs, query, orgDirectory));
      onDiscoverOrgs(orgs);
    } catch {
      setResults([]);
    } finally {
      setOpen(true);
      setPending(false);
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(); } }}
          placeholder="조직명 검색 (비우면 전체)"
          data-testid="routing-org-search-input"
          className="h-9 min-w-0 flex-1 rounded-md border border-line bg-paper px-3 text-xs text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
        />
        <Button type="button" size="sm" variant="secondary" disabled={disabled || pending} onClick={search} data-testid="routing-org-search-button">
          검색
        </Button>
      </div>
      {open && (
        <div className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-line bg-paper" data-testid="routing-org-search-results">
          {results.length === 0 && <p className="px-3 py-2 text-xs text-ink-3">검색 결과가 없습니다.</p>}
          {results.map(({ org, matchedVia, parentName }) => (
            <button
              type="button"
              key={org.id}
              disabled={disabled || existingOrgIds.includes(org.id)}
              onClick={() => { onAdd(org.id); setOpen(false); }}
              data-testid="routing-org-result"
              data-org-id={org.id}
              className="block w-full px-3 py-2 text-left text-xs hover:bg-fill disabled:opacity-40"
            >
              <span className="font-semibold text-ink">{org.name}</span>
              <span className="ml-2 text-ink-3">{org.id}</span>
              {matchedVia === "parent" && parentName && <span className="ml-2 text-ink-4">(상위: {parentName})</span>}
              {existingOrgIds.includes(org.id) && <span className="ml-2 text-ink-4">(이미 매핑됨)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function isSafeGoogleConsentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

function mailOAuthResultNotice(result: string): Notice {
  if (result === "ok") return { tone: "success", message: "메일 계정을 연결했습니다." };
  if (result === "denied") return { tone: "error", message: "Google 동의가 취소되었거나 요청이 만료되었습니다. 다시 시도해 주세요." };
  if (result === "mailbox_mismatch") {
    return { tone: "error", message: "선택한 Google 계정이 연결하려는 메일 주소와 일치하지 않습니다." };
  }
  if (result === "state_reused") {
    return { tone: "error", message: "메일 연결 요청이 이미 사용되었거나 만료되었습니다. 다시 연결해 주세요." };
  }
  return { tone: "error", message: "메일 계정 연결 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." };
}

function mailOAuthBeginNotice(response: { ok: boolean; error?: { kind?: string; code?: string } }): Notice {
  const code = response.error?.code ?? response.error?.kind;
  return { tone: "error", message: mailOAuthErrorLabel(code) };
}

function mailOAuthErrorLabel(code: string | undefined) {
  const labels: Record<string, string> = {
    not_configured: "개인 메일 연결 서버 설정이 아직 준비되지 않았습니다. 관리자에게 OAuth 설정과 콜백 주소를 확인해 달라고 요청하세요.",
    missing_client_id: "개인 메일 연결 서버에 Google OAuth 클라이언트가 설정되지 않았습니다. 관리자에게 설정 확인을 요청하세요.",
    missing_client_secret: "개인 메일 연결 서버의 Google OAuth 보안 설정이 준비되지 않았습니다. 관리자에게 Secret 바인딩 확인을 요청하세요.",
    missing_encryption_key: "개인 메일 연결 서버의 자격증명 보호 설정이 준비되지 않았습니다. 관리자에게 Secret 바인딩 확인을 요청하세요.",
    missing_redirect_uri: "개인 메일 연결 서버의 OAuth 콜백 주소가 설정되지 않았습니다. 관리자에게 콜백 설정 확인을 요청하세요.",
    callback_mismatch: "Google OAuth 콜백 주소가 현재 스테이징 주소와 일치하지 않습니다. 관리자에게 승인된 콜백 주소를 확인해 달라고 요청하세요.",
    disabled_in_staging: "스테이징에서는 개인 메일 연결이 비활성화되어 있습니다. 관리자에게 스테이징 연결 게이트를 확인해 달라고 요청하세요.",
    tenant_mismatch: "현재 로그인 계정의 조직과 메일 연결 대상이 일치하지 않습니다. 본인 계정으로 다시 시도해 주세요.",
    account_not_found: "현재 로그인 계정에 연결할 메일 계정 레코드가 없습니다. 관리자에게 계정 매핑을 요청하세요.",
  };
  return labels[code ?? ""] ?? "메일 계정 연결을 시작하지 못했습니다. 서버 설정과 계정 매핑을 확인한 뒤 다시 시도해 주세요.";
}

type MailOrgContextDisplay = { value: string; detail: string };

function mailOrgContextDisplay(
  context: MyOrgContextEnvelope | null,
  pending: boolean,
): MailOrgContextDisplay {
  if (pending) {
    return {
      value: "확인 중",
      detail: "현재 계정의 공식 조직 소속을 확인하는 중입니다.",
    };
  }
  if (!context) {
    return {
      value: "조직 상태 확인 불가",
      detail: "현재 계정의 조직 소속 상태를 불러오지 못했습니다.",
    };
  }

  const orgId = context.orgId?.trim() || "";
  const orgName = context.orgName?.trim() || "";
  switch (context.orgResolutionStatus) {
    case "resolved":
      if (orgId && orgName) {
        return {
          value: `${orgName} (${orgId})`,
          detail: `공식 조직 소속 확인됨 · 조직 ID ${orgId}`,
        };
      }
      if (orgId) {
        return {
          value: `${orgId} · 이름 확인 불가`,
          detail: `공식 조직 소속은 확인됐지만 조직 이름을 확인하지 못했습니다. 조직 ID ${orgId}`,
        };
      }
      return {
        value: "조직 ID 확인 불가",
        detail: "공식 조직 소속은 확인됐지만 조직 ID를 확인하지 못했습니다.",
      };
    case "directory_unavailable":
      return {
        value: orgId ? `${orgId} · 조직 디렉터리 확인 불가` : "조직 디렉터리 확인 불가",
        detail: "조직 디렉터리에 연결하지 못해 공식 소속 상태를 확인할 수 없습니다.",
      };
    case "unresolved":
      return {
        value: orgId ? `${orgId} · 공식 소속 미확인` : "공식 소속 미확인",
        detail: "현재 계정의 공식 조직 소속을 확인하지 못했습니다.",
      };
    default:
      return {
        value: orgId ? `${orgId} · 조직 상태 확인 불가` : "조직 상태 확인 불가",
        detail: "현재 계정의 공식 조직 소속 상태를 확인하지 못했습니다.",
      };
  }
}

function ownMailConnectionState(
  status: GetMailOAuthStatusEnvelope | null,
  account: MailAccountPublic | null,
): { tone: "neutral" | "info" | "warn" | "danger"; label: string; detail: string } {
  if (account?.status === "disabled") {
    return {
      tone: "danger",
      label: "계정 비활성화됨",
      detail: "메일 계정 레코드가 비활성화되어 있습니다. 관리자에게 계정 상태를 확인해 달라고 요청하세요.",
    };
  }
  if (account?.status === "pending_auth") {
    return {
      tone: "warn",
      label: "연결 대기 중",
      detail: "메일 계정 레코드는 있지만 Google 인증이 아직 완료되지 않았습니다. 다시 연결해 주세요.",
    };
  }
  if (!status) {
    return {
      tone: "neutral",
      label: "확인 불가",
      detail: "내 메일 연결 상태를 불러오지 못했습니다. 상태 새로고침을 실행해 주세요.",
    };
  }
  if (status.status === "revoked") {
    return {
      tone: "danger",
      label: "연결 해제됨",
      detail: "연결 기록은 있으나 Google 자격증명이 해제되었습니다. 다시 연결해 주세요.",
    };
  }
  if (status.linked && status.connectionCheck?.status === "reauth_required") {
    return {
      tone: "danger",
      label: "재연결 필요",
      detail: mailOAuthConnectionDetail(status),
    };
  }
  if (!status.linked) {
    return {
      tone: "neutral",
      label: "미연결",
      detail: "이 계정에는 확인된 개인 메일 연결 기록이 없습니다.",
    };
  }
  if (status.status === "active") {
    return {
      tone: status.connectionCheck?.status === "unavailable" ? "warn" : "info",
      label: "연결됨",
      detail: mailOAuthConnectionDetail(status),
    };
  }
  return {
    tone: "warn",
    label: "확인 필요",
    detail: "연결 기록의 현재 상태를 확인할 수 없습니다. 다시 연결해 주세요.",
  };
}

function mailOAuthConnectionDetail(status: GetMailOAuthStatusEnvelope): string {
  const check = status.connectionCheck;
  const reason = check?.reason?.trim();
  if (status.status === "revoked") {
    return "Google OAuth 연결이 해제되어 다시 연결해 주세요.";
  }
  if (!status.linked) {
    return "Google OAuth 연결 기록이 없습니다.";
  }
  if (check?.status === "reauth_required") {
    return reason
      ? `Google OAuth 인증을 다시 연결해 주세요. 확인 결과: ${reason}`
      : "Google OAuth 인증이 해제되었거나 유효하지 않습니다. 다시 연결해 주세요.";
  }

  const base = check?.status === "verified"
    ? "Google OAuth 인증이 확인되었습니다. 실제 메일 전달 성공 여부는 별도 확인이 필요합니다."
    : check?.status === "unavailable"
      ? `Google OAuth 인증 확인을 완료하지 못했습니다. 저장된 연결 기록은 유지됩니다.${reason ? ` 사유: ${reason}` : ""}`
      : "Google OAuth 연결 기록이 있습니다. 상태 새로고침에서 인증을 확인할 수 있습니다.";
  const expiry = status.expiresAt ? mailOAuthExpiryLabel(status.expiresAt) : null;
  return [base, expiry].filter(Boolean).join(" ");
}

function mailOAuthExpiryLabel(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "액세스 토큰 만료 시각 기록 있음";
  return timestamp <= Date.now()
    ? "액세스 토큰은 다음 메일 사용 시 갱신합니다."
    : `액세스 토큰 만료 예정 ${formatDateTime(value)}`;
}

function formatMailOAuthScopes(scopes: string[]) {
  const labels = new Map<string, string>([
    ["openid", "로그인 확인"],
    ["email", "계정 이메일 확인"],
    ["https://mail.google.com/", "메일 읽기·보내기"],
    ["https://www.googleapis.com/auth/gmail.modify", "메일 읽기·보내기"],
    ["https://www.googleapis.com/auth/youtube.readonly", "YouTube 읽기"],
  ]);
  const known = new Set<string>();
  let additional = 0;
  for (const scope of scopes) {
    const label = labels.get(scope.trim().toLowerCase());
    if (label) known.add(label);
    else additional += 1;
  }
  const parts = [...known];
  if (additional > 0) parts.push(`추가 권한 ${additional}개`);
  return parts.join(" · ") || `${scopes.length}개`;
}

function MailConnectionMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-paper px-5 py-4">
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-ink" title={value}>{value}</p>
      <p className="mt-0.5 text-pretty text-xs leading-5 text-ink-3">{detail}</p>
    </div>
  );
}

function integrationRuntimeTone(runtimeMode: GetIntegrationsEnvelope["runtimeMode"], legacyMode: string): "neutral" | "info" | "ok" {
  if (runtimeMode === "production" || legacyMode === "blaze_live") return "ok";
  if (runtimeMode === "hosted_staging" || legacyMode === "emulator_mock") return "info";
  return "neutral";
}

function integrationRuntimeLabel(runtimeMode: GetIntegrationsEnvelope["runtimeMode"], legacyMode: string) {
  if (runtimeMode === "hosted_staging") return "스테이징";
  if (runtimeMode === "production") return "프로덕션";
  if (runtimeMode === "emulator") return "에뮬레이터";
  if (legacyMode === "emulator_mock") return "스테이징 · 라이브 게이트 꺼짐";
  if (legacyMode === "blaze_live") return "라이브 게이트 켜짐";
  return legacyMode || "환경 확인 중";
}

function integrationRuntimeDescription(runtimeMode: GetIntegrationsEnvelope["runtimeMode"], legacyMode: string) {
  if (runtimeMode === "hosted_staging" || legacyMode === "emulator_mock") {
    return "현재 스테이징 런타임에서는 실발송 라이브 게이트가 꺼져 있습니다.";
  }
  if (runtimeMode === "production" || legacyMode === "blaze_live") {
    return "현재 프로덕션 런타임의 공용 메일 설정 준비 상태를 표시합니다.";
  }
  if (runtimeMode === "emulator") return "현재 에뮬레이터 런타임의 설정 상태를 표시합니다.";
  return "런타임 환경을 확인하는 중입니다.";
}

function capabilityCodeLabel(code: string | undefined) {
  const labels: Record<string, string> = {
    missing_key: "서버 키 미설정",
    invalid_base_url: "서버 주소 확인 필요",
    missing_client_id: "OAuth 클라이언트 미설정",
    missing_client_secret: "OAuth 보안 설정 미설정",
    missing_encryption_key: "자격증명 보호 설정 미설정",
    missing_redirect_uri: "OAuth 콜백 주소 미설정",
    callback_mismatch: "OAuth 콜백 주소 불일치",
    disabled_in_staging: "스테이징 연결 비활성화",
    unavailable: "라우팅 설정 확인 필요",
  };
  return labels[code ?? ""] ?? "설정 상태 확인 필요";
}

function CapabilityReadiness({
  label,
  capability,
  fallbackCode,
}: {
  label: string;
  capability?: { configured: boolean; ready: boolean; code: string | null; callbackUrl?: string | null };
  fallbackCode?: string;
}) {
  const stateLabel = capability
    ? capability.ready
      ? "서버 설정 준비됨"
      : capabilityCodeLabel(capability.code ?? undefined)
    : fallbackCode
      ? capabilityCodeLabel(fallbackCode)
      : "확인 중";
  const tone = capability?.ready ? "ok" : capability?.code || fallbackCode ? "warn" : "neutral";
  const detail = capability?.callbackUrl
    ? `콜백 주소 ${capability.callbackUrl}`
    : capability?.configured
      ? "설정 바인딩은 확인됐습니다."
      : "개인 연결·발송 상태와 별도로 서버 설정만 표시합니다.";
  return (
    <div className="min-w-0 bg-paper px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-ink-3">{label}</p>
        <Badge tone={tone}>{stateLabel}</Badge>
      </div>
      <p className="mt-1 break-all text-[11px] leading-5 text-ink-3">{detail}</p>
    </div>
  );
}

function upsert(items: IntegrationSummary[], next: IntegrationSummary) {
  const rest = items.filter((item) => item.key !== next.key);
  return [...rest, next].sort((left, right) => DEFINITIONS.findIndex((item) => item.key === left.key) - DEFINITIONS.findIndex((item) => item.key === right.key));
}

function peoplyRequiresQuery(kind: PeoplySearchKind) {
  return kind === "people" || kind === "workspace-groups";
}

function peoplyErrorLabel(kind: PeoplyErrorKind | undefined) {
  if (!kind) return "미설정";
  const labels: Record<PeoplyErrorKind, string> = {
    missing_key: "미설정",
    invalid_base_url: "설정 오류",
    forbidden: "키 거부(403)",
    rate_limited: "속도제한",
    not_found: "결과 없음",
    invalid_request: "요청 오류",
    upstream: "업스트림 오류",
    network: "업스트림 오류",
  };
  return labels[kind];
}

function PeoplyMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 bg-paper px-5 py-3">
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-ink" title={value}>{value}</p>
      {detail && <p className="mt-0.5 truncate text-xs text-ink-3">{detail}</p>}
    </div>
  );
}

function PeoplyResultRow({ kind, item }: { kind: PeoplySearchKind; item: PeoplyDirectoryItem }) {
  if (kind === "people") {
    const person = item as PeoplyPerson;
    return (
      <div className="px-5 py-2.5 text-xs">
        <span className="font-semibold text-ink">{person.displayName || person.email}</span>
        <span className="ml-2 text-ink-3">{person.email}</span>
        <span className="ml-2 text-ink-3">{person.department}</span>
        <span className="ml-2 text-ink-3">{person.title}</span>
      </div>
    );
  }
  if (kind === "workspace-groups") {
    const group = item as PeoplyWorkspaceGroup;
    return (
      <div className="px-5 py-2.5 text-xs">
        <span className="font-semibold text-ink">{group.name}</span>
        <span className="ml-2 text-ink-3">{group.email}</span>
        <span className="ml-2 text-ink-3">멤버 {group.directMemberCount}명</span>
      </div>
    );
  }
  const org = item as PeoplyOrganization;
  return (
    <div className="px-5 py-2.5 text-xs">
      <span className="font-semibold text-ink">{org.name}</span>
      <span className="ml-2 text-ink-3">{org.organizationLevelLabel}</span>
      <span className="ml-2 text-ink-3">{org.leaders.map((leader) => leader.displayName).join(", ") || "리더 미등록"}</span>
    </div>
  );
}

function ProbeSummary({ label, lane }: { label: string; lane?: MailTransportProbeLane }) {
  const state = lane?.status === "ok"
    ? "정상"
    : lane?.status === "failed"
      ? "실패"
      : lane?.status === "skipped"
        ? "건너뜀"
        : "미진단";
  return <span>{label} {state}{lane ? ` · ${lane.code} · ${lane.latencyMs}ms` : ""}</span>;
}

function mask(value: string) {
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function displayPublicValue(item: IntegrationSummary | undefined, field: FieldDef) {
  const raw = item?.public[field.name];
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string" && raw.trim()) return raw;
  return "미설정";
}

function displayPublicPlaceholder(item: IntegrationSummary | undefined, field: FieldDef) {
  const raw = item?.public[field.name];
  if (typeof raw === "boolean" || typeof raw === "number") return String(raw);
  if (typeof raw === "string" && raw.trim()) return raw;
  return field.placeholder;
}

function displaySecretValue(item: IntegrationSummary | undefined, field: string) {
  const raw = item?.secrets[field];
  return typeof raw === "string" && raw.trim() ? raw : "미설정";
}

function coerceValue(value: string) {
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  const numeric = Number(value);
  return value.trim() !== "" && Number.isFinite(numeric) ? numeric : value;
}

function fingerprintPrefix(value: string | undefined) {
  return value && CHALLENGE_TOKEN_PATTERN.test(value) ? value.slice(0, 12) : "";
}

function isFreshSuccessfulMailProbe(probe: MailTransportProbeStatus | null) {
  return Boolean(
    probe?.valid
    && probe.receiptIntegrityValid === true
    && probe.probeState === "fresh"
    && probe.smtp.status === "ok"
    && probe.imap.status === "ok"
    && Number.isFinite(Date.parse(probe.expiresAtIso))
    && Date.parse(probe.expiresAtIso) > Date.now(),
  );
}

function isAttestationReadyDiagnostic(result: DiagnoseMailTransportEnvelope) {
  return result.statusPersisted === true
    && result.noMailSent === true
    && CHALLENGE_TOKEN_PATTERN.test(result.attestationChallengeToken)
    && CHALLENGE_TOKEN_PATTERN.test(result.probe.configFingerprint ?? "")
    && isFreshSuccessfulMailProbe(result.probe);
}

function isDiagnosticTokenEvidenceFresh(evidence: DiagnosticTokenEvidence | null) {
  return Boolean(
    evidence
    && Number.isFinite(Date.parse(evidence.checkedAtIso))
    && Number.isFinite(Date.parse(evidence.expiresAtIso))
    && Date.parse(evidence.checkedAtIso) <= Date.now()
    && Date.parse(evidence.expiresAtIso) > Date.now(),
  );
}

function diagnosticFailureMessage(result: DiagnoseMailTransportEnvelope) {
  if (!result.statusPersisted) {
    return "진단 결과를 서버에 안전하게 저장하지 못해 제공자 주체 확인에 사용할 수 없습니다. 다시 진단해 주세요.";
  }
  if (result.probe.smtp.status !== "ok" || result.probe.imap.status !== "ok") {
    return "SMTP 또는 IMAP 무발송 진단이 통과하지 못했습니다. 저장 설정과 런타임 Secret 바인딩을 확인한 뒤 다시 진단해 주세요.";
  }
  if (result.probe.probeState !== "fresh") {
    return "진단 이후 메일 설정이 변경되었습니다. 현재 설정으로 다시 진단해 주세요.";
  }
  return "진단 영수증의 무결성 또는 유효기간을 확인할 수 없습니다. 다시 진단해 주세요.";
}

function callableErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const raw = "code" in error && typeof error.code === "string" ? error.code : "";
  return raw.startsWith("functions/") ? raw.slice("functions/".length) : raw;
}

function safeIntegrationActionError(
  error: unknown,
  action: "save" | "youtube" | "diagnose" | "refresh" | "attest" | "revoke" | "mailOAuth" | "mailBackfill",
) {
  const code = callableErrorCode(error);
  if (action === "mailOAuth") {
    const safeCode = mailOAuthSafeErrorCode(error);
    if (safeCode) return mailOAuthErrorLabel(safeCode);
  }
  if (code === "permission-denied" || code === "unauthenticated") {
    if (action === "attest" || action === "revoke") {
      return "이 작업은 서버에서 확인한 super_admin 계정만 실행할 수 있습니다.";
    }
    return "이 작업을 실행할 관리자 권한을 서버에서 확인하지 못했습니다.";
  }
  if (code === "invalid-argument") {
    return action === "attest" || action === "revoke"
      ? `${CANONICAL_OPERATIONAL_MAILBOX}를 정확히 입력한 뒤 다시 시도해 주세요.`
      : "입력값을 확인한 뒤 다시 시도해 주세요.";
  }
  if (code === "failed-precondition") {
    return action === "attest"
      ? "진단 결과가 만료되었거나 메일 설정이 변경되었습니다. 다시 진단한 뒤 제공자 주체 확인을 진행해 주세요."
      : "현재 연동 상태에서는 작업을 완료할 수 없습니다. 설정과 상태를 새로고침한 뒤 다시 시도해 주세요.";
  }
  if (code === "deadline-exceeded" || code === "unavailable") {
    return "연동 서비스 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.";
  }
  const fallback: Record<typeof action, string> = {
    save: "연동 설정을 저장하지 못했습니다. 권한과 입력값을 확인한 뒤 다시 시도해 주세요.",
    youtube: "YouTube 권한 상태를 새로고침하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    diagnose: "메일을 보내지 않는 연결 진단을 완료하지 못했습니다. 설정과 런타임 상태를 확인한 뒤 다시 시도해 주세요.",
    refresh: "메일 연동과 제공자 확인 상태를 새로고침하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    attest: "메일 제공자 주체 확인을 완료하지 못했습니다. 다시 진단한 뒤 재시도해 주세요.",
    revoke: "메일 제공자 주체 확인을 해제하지 못했습니다. 상태를 새로고침한 뒤 재시도해 주세요.",
    mailOAuth: "메일 계정 연결 작업을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    mailBackfill: "메일 기록 불러오기를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  };
  return fallback[action];
}

function mailOAuthSafeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidateValues: unknown[] = [
    "code" in error ? error.code : undefined,
    "kind" in error ? error.kind : undefined,
    "details" in error && error.details && typeof error.details === "object" && "code" in error.details ? error.details.code : undefined,
    "details" in error && error.details && typeof error.details === "object" && "kind" in error.details ? error.details.kind : undefined,
  ];
  const allowed = new Set([
    "not_configured",
    "missing_client_id",
    "missing_client_secret",
    "missing_encryption_key",
    "missing_redirect_uri",
    "callback_mismatch",
    "disabled_in_staging",
    "tenant_mismatch",
    "account_not_found",
  ]);
  return candidateValues.find((value): value is string => typeof value === "string" && allowed.has(value));
}

function attestationStatusTone(status: MailProviderAttestationStatus | undefined): "neutral" | "warn" | "ok" | "danger" {
  if (status === "active") return "ok";
  if (status === "config_changed") return "danger";
  if (status === "expired" || status === "revoked") return "warn";
  return "neutral";
}

function attestationStatusLabel(status: MailProviderAttestationStatus | undefined) {
  const labels: Record<MailProviderAttestationStatus, string> = {
    active: "확인 유효",
    expired: "확인 만료",
    revoked: "확인 해제",
    missing: "확인 없음",
    config_changed: "설정 변경됨",
  };
  return status ? labels[status] : "상태 확인 실패";
}

function AttestationMetric({
  label,
  value,
  detail,
  mono = false,
}: {
  label: string;
  value: string;
  detail: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 bg-paper px-5 py-4">
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p
        className={`mt-1 truncate text-sm font-semibold text-ink ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </p>
      <p className="mt-0.5 text-pretty text-xs leading-5 text-ink-3">{detail}</p>
    </div>
  );
}

function AuthorizationMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-paper px-5 py-4">
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-ink" title={value}>{value}</p>
      <p className="mt-0.5 text-pretty text-xs leading-5 text-ink-3">{detail}</p>
    </div>
  );
}

function YouTubeAuthorizationRow({ connection }: { connection: YouTubeAuthorizationConnection }) {
  const stateTime = connection.revokedAt || connection.expiresAt || connection.lastCheckedAt || connection.updatedAtIso;
  return (
    <div className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(180px,0.8fr)] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold text-ink" title={connection.channelId || "채널 미확인"}>
            {connection.channelId || "채널 미확인"}
          </p>
          <Badge tone={youtubeStatusTone(connection.status)}>{youtubeStatusLabel(connection.status)}</Badge>
          {connection.needsReconnect && <Badge tone="warn">재인증 필요</Badge>}
        </div>
        <p className="mt-1 truncate text-xs text-ink-3">
          프로그램 {connection.programId || "scp"} · {youtubeAuthModeLabel(connection.authMode)}
        </p>
      </div>

      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-3">허용 scope</p>
        <p className="mt-1 text-pretty break-all text-xs leading-5 text-ink-2">
          {connection.scopes.length > 0 ? connection.scopes.join(" · ") : "확인된 scope 없음"}
        </p>
      </div>

      <div className="min-w-0 text-left lg:text-right">
        <p className="text-xs font-medium text-ink-3">
          {connection.revokedAt ? "취소 시각" : connection.expiresAt ? "만료 시각" : "최근 확인"}
        </p>
        <p className="mt-1 truncate text-xs tabular-nums text-ink-2" title={stateTime || "기록 없음"}>
          {formatDateTime(stateTime)}
        </p>
        {connection.errorCode && <p className="mt-1 truncate text-xs text-danger">{connection.errorCode}</p>}
      </div>
    </div>
  );
}

function youtubeStatusTone(status: YouTubeAuthorizationStatus | undefined): "neutral" | "info" | "warn" | "ok" | "danger" {
  if (status === "AUTHORIZED") return "ok";
  if (status === "AUTH_PENDING") return "info";
  if (status === "EXPIRED" || status === "REVOKED") return "warn";
  if (status === "ERROR") return "danger";
  return "neutral";
}

function youtubeStatusLabel(status: YouTubeAuthorizationStatus | undefined) {
  const labels: Record<YouTubeAuthorizationStatus, string> = {
    NOT_CONFIGURED: "미설정",
    AUTH_PENDING: "인증 대기",
    AUTHORIZED: "승인됨",
    EXPIRED: "만료됨",
    REVOKED: "취소됨",
    ERROR: "오류",
  };
  return status ? labels[status] : labels.NOT_CONFIGURED;
}

function youtubeAuthModeLabel(mode: "external_api_login" | "viewer_fallback" | undefined) {
  return mode === "external_api_login" ? "외부 API 로그인" : "viewer_fallback";
}

function formatDateTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "기록 없음";
  return new Date(value).toLocaleString("ko-KR");
}
