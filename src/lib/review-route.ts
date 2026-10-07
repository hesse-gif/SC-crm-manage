export type ReviewQueueTab = "legacy" | "qualification" | "mail" | "encouragement" | "video" | "coldmail";

export type ReviewRouteState = {
  queue: ReviewQueueTab;
  reviewId: string;
  leadId: string;
  applicationId: string;
  submissionId: string;
  programId: string;
  campaignId: string;
  targetId: string;
};

export type ReviewRouteTarget =
  | { kind: "legacy"; reviewId: string; programId?: string; campaignId?: string; basePath?: string }
  | { kind: "qualification" | "mail"; leadId?: string; applicationId?: string; programId?: string; campaignId?: string; basePath?: string }
  | { kind: "video"; submissionId: string; applicationId?: string; programId?: string; campaignId?: string; basePath?: string }
  | { kind: "encouragement"; targetId?: string; programId?: string; campaignId?: string; basePath?: string };

export type ReviewItemRouteInput = {
  id?: unknown;
  reviewId?: unknown;
  submissionId?: unknown;
  applicationId?: unknown;
  canonicalProgramId?: unknown;
  programId?: unknown;
  basePath?: unknown;
};

export type EscalationRouteState = {
  escalationId: string;
  creatorId: string;
  programId: string;
};

export type EscalationRouteTarget = {
  escalationId: string;
  creatorId?: string;
  programId?: string;
};

type SearchParamsReader = Pick<URLSearchParams, "get">;
type SearchParamsRecord = Record<string, string | string[] | undefined>;
type SearchParamsInput = URLSearchParams | SearchParamsRecord | null | undefined;

const REVIEW_QUEUES = new Set<ReviewQueueTab>(["legacy", "qualification", "mail", "encouragement", "video", "coldmail"]);
const SCP_REVIEW_COMPATIBILITY_PARAMS = [
  "queue",
  "programId",
  "campaignId",
  "filter",
  "reviewId",
  "leadId",
  "applicationId",
  "submissionId",
  "videoSubmissionId",
  "revisionId",
  "videoRevisionId",
  "targetId",
] as const;
const REVIEW_COMPATIBILITY_ROUTE_KEYS = new Set<string>([
  "queue",
  "reviewId",
  "leadId",
  "applicationId",
  "submissionId",
  "targetId",
]);
const VIDEO_REVIEW_COMPATIBILITY_ROUTE_KEYS = new Set<string>([
  "submissionId",
  "videoSubmissionId",
  "revisionId",
  "videoRevisionId",
]);

function cleanRouteValue(value: unknown, maxLength = 300): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validQueue(value: unknown): ReviewQueueTab | "" {
  const queue = cleanRouteValue(value, 40) as ReviewQueueTab;
  return REVIEW_QUEUES.has(queue) ? queue : "";
}

export function parseReviewRouteState(
  params: SearchParamsReader,
  defaultQueue: ReviewQueueTab = "legacy",
): ReviewRouteState {
  const reviewId = cleanRouteValue(params.get("reviewId"));
  const leadId = cleanRouteValue(params.get("leadId"));
  const applicationId = cleanRouteValue(params.get("applicationId"));
  const submissionId = cleanRouteValue(params.get("submissionId"));
  const programId = cleanRouteValue(params.get("programId"), 180);
  const campaignId = cleanRouteValue(params.get("campaignId"), 180);
  const targetId = cleanRouteValue(params.get("targetId"), 300);
  const requestedQueue = validQueue(params.get("queue")) || defaultQueue;

  // An entity ID is authoritative over a stale or contradictory queue query.
  // This makes copied links and browser back/forward deterministic.
  if (reviewId) return { queue: "legacy", reviewId, leadId: "", applicationId: "", submissionId: "", programId, campaignId, targetId: "" };
  if (submissionId) return { queue: "video", reviewId: "", leadId: "", applicationId, submissionId, programId, campaignId, targetId: "" };
  if (leadId || applicationId) {
    const queue = requestedQueue === "mail" ? "mail" : "qualification";
    return { queue, reviewId: "", leadId, applicationId, submissionId: "", programId, campaignId, targetId: "" };
  }
  return { queue: targetId ? "encouragement" : requestedQueue, reviewId: "", leadId: "", applicationId, submissionId: "", programId, campaignId, targetId };
}

function reviewPath(basePath: unknown): string {
  const path = cleanRouteValue(basePath, 80);
  return path === "/flu/scp" ? path : "/flu/review";
}

function withProgramId(params: URLSearchParams, programId: unknown) {
  const value = cleanRouteValue(programId, 180);
  if (value) params.set("programId", value);
}

function withCampaignId(params: URLSearchParams, campaignId: unknown) {
  const value = cleanRouteValue(campaignId, 180);
  if (value) params.set("campaignId", value);
}

function appendCleanParam(params: URLSearchParams, key: string, value: unknown) {
  const cleaned = cleanRouteValue(value, key === "programId" || key === "campaignId" ? 180 : 300);
  if (cleaned) params.append(key, cleaned);
}

function readCompatibilityValues(input: SearchParamsInput, key: string): unknown[] {
  if (!input) return [];
  if (input instanceof URLSearchParams) return input.getAll(key);
  const value = input[key];
  return Array.isArray(value) ? value : [value];
}

function hasReviewCompatibilityRouteState(input: SearchParamsInput): boolean {
  return SCP_REVIEW_COMPATIBILITY_PARAMS.some((key) => (
    REVIEW_COMPATIBILITY_ROUTE_KEYS.has(key)
      && readCompatibilityValues(input, key).some((value) => cleanRouteValue(value))
  ));
}

function hasVideoReviewCompatibilityRouteState(input: SearchParamsInput): boolean {
  const requestedQueueIsVideo = readCompatibilityValues(input, "queue")
    .some((value) => cleanRouteValue(value, 40) === "video");
  return requestedQueueIsVideo || SCP_REVIEW_COMPATIBILITY_PARAMS.some((key) => (
    VIDEO_REVIEW_COMPATIBILITY_ROUTE_KEYS.has(key)
      && readCompatibilityValues(input, key).some((value) => cleanRouteValue(value))
  ));
}

// W62-2: 지원 관리 탭 추가. 탭 판정의 정본은 여기 하나뿐이다(페이지가 자체 판정하지 않는다).
// W91 [헤세 · 크리에이터 탭]: 다섯 번째 탭. Flu 가 이미 가진 데이터로만 크리에이터 매핑 상태를
// 보여주는 읽기 전용 뷰 — 실행 액션은 Portal 딥링크로만 나간다.
// 2026-09-17 [헤세]: 여섯 번째 탭 `인박스` 추가 — 영상/문의/신청자 중 사람 판단이 필요한 건을
// 한 화면에 모은다(콘텐츠 검수 아래, 딥링크 가능). W91 크리에이터 탭과 같은 관례로 union 끝에 더한다.
export type ScpOperationsTab = "review" | "ops" | "mail-templates" | "applications" | "creators" | "inbox";

export type ScpOperationsTabState = {
  /** `tab` 쿼리로 사용자가 요청한 탭. */
  readonly selectedTab: ScpOperationsTab;
  /** 레거시 딥링크 강제까지 반영한 실제 렌더 탭. */
  readonly effectiveTab: ScpOperationsTab;
  /** 운영 모니터링 탭 하단의 제한 호환 영역(ReviewWorkspace)을 여는지. */
  readonly showLegacyCompatibilityWorkspace: boolean;
};

const SCP_NON_VIDEO_LEGACY_QUEUES = new Set<string>([
  "legacy",
  "qualification",
  "mail",
  "encouragement",
  "coldmail",
]);
const SCP_NON_VIDEO_LEGACY_ROUTE_KEYS = new Set<string>([
  "reviewId",
  "leadId",
  "applicationId",
  "targetId",
]);

function hasNonVideoLegacyCompatibilityRouteState(input: SearchParamsInput): boolean {
  if (hasVideoReviewCompatibilityRouteState(input)) return false;
  if (readCompatibilityValues(input, "queue").some((value) => SCP_NON_VIDEO_LEGACY_QUEUES.has(cleanRouteValue(value, 40)))) {
    return true;
  }
  return SCP_REVIEW_COMPATIBILITY_PARAMS.some((key) => (
    SCP_NON_VIDEO_LEGACY_ROUTE_KEYS.has(key)
      && readCompatibilityValues(input, key).some((value) => cleanRouteValue(value))
  ));
}

function requestedScpTab(input: SearchParamsInput): ScpOperationsTab {
  // analysis 탭(중복 클러스터 조회 폼)은 제거됐다 — 옛 딥링크는 영상 검수로 떨어진다.
  const requested = readCompatibilityValues(input, "tab").map((value) => cleanRouteValue(value, 40)).find(Boolean) ?? "";
  return requested === "ops" || requested === "mail-templates" || requested === "applications" || requested === "creators" || requested === "inbox"
    ? requested
    : "review";
}

/**
 * `/flu/scp` 내부 탭 판정의 정본. 예전에는 이 규칙이 페이지 컴포넌트 안에만 있어서 라우팅
 * 트랩(아래 buildScpTabHref)을 행위로 검증할 수 없었다 — 판정과 링크 생성이 같은 어휘를 쓰게 모았다.
 */
export function resolveScpOperationsTabState(input: SearchParamsInput): ScpOperationsTabState {
  const selectedTab = requestedScpTab(input);
  const showLegacyCompatibilityWorkspace = hasNonVideoLegacyCompatibilityRouteState(input);
  const effectiveTab: ScpOperationsTab = hasVideoReviewCompatibilityRouteState(input)
    ? "review"
    : selectedTab === "review"
      && hasReviewCompatibilityRouteState(input)
      && showLegacyCompatibilityWorkspace
      ? "ops"
      : selectedTab;
  return { selectedTab, effectiveTab, showLegacyCompatibilityWorkspace };
}

/**
 * W8-6: 탭 전환 href. **명시적 탭 클릭은 호환 모드 이탈이다.**
 *
 * 예전에는 현재 쿼리를 그대로 복사하고 `tab` 만 바꿨다. 그래서 `?queue=mail` 로 들어온 화면에서
 * 「영상 검수」를 누르면 URL 은 `?queue=mail&tab=review` 가 되고, resolveScpOperationsTabState 가
 * 다시 `ops`(호환 뷰)로 강제해 **화면이 그대로였다** — 클릭이 죽은 것처럼 보인 실제 라이브 버그
 * (브라우저 재현 + DOM 근거). 순수 `/flu/scp` 는 정상이었던 이유도 같다.
 *
 * 그래서 클릭한 탭을 가로챌 수 있는 파라미터만 지운다:
 *   - 비영상 레거시 키(queue·reviewId·leadId·applicationId·targetId)는 항상 제거.
 *   - 영상 딥링크 키(submissionId 계열)는 **영상 검수 이외의 탭을 눌렀을 때만** 제거 —
 *     영상 검수를 누른 경우엔 그 딥링크가 가리키는 대상 선택을 잃지 않는다.
 * 딥링크 **최초 진입**의 호환 표시는 그대로다(buildScpReviewCompatibilityHref 무변경).
 */
export function buildScpTabHref(input: SearchParamsInput, tab: ScpOperationsTab): string {
  const params = new URLSearchParams();
  params.set("tab", tab);
  const entries: Array<[string, unknown]> = input instanceof URLSearchParams
    ? [...input.entries()]
    : Object.entries(input ?? {}).flatMap(([key, value]) => (
      Array.isArray(value)
        ? value.map((item): [string, unknown] => [key, item])
        : [[key, value] as [string, unknown]]
    ));
  for (const [key, value] of entries) {
    if (key === "tab") continue;
    if (key === "queue" || SCP_NON_VIDEO_LEGACY_ROUTE_KEYS.has(key)) continue;
    if (tab !== "review" && VIDEO_REVIEW_COMPATIBILITY_ROUTE_KEYS.has(key)) continue;
    appendCleanParam(params, key, value);
  }
  return `/flu/scp?${params.toString()}`;
}

export function buildScpReviewCompatibilityHref(input: SearchParamsInput): string {
  // 2026-09-17 [헤세 · 인박스]: /flu/review?queue=inbox 는 "이전 검수 링크 호환"(레거시 큐용 제한
  // 영역, showLegacyCompatibilityWorkspace)이 아니라 정식 6번째 탭이다 — 그 문구 아래로 보내면
  // 새 기능이 "이전 링크"로 오독된다. queue=inbox 는 다른 호환 파라미터를 섞지 않고 바로 그 탭으로.
  if (readCompatibilityValues(input, "queue").some((value) => cleanRouteValue(value, 40) === "inbox")) {
    return "/flu/scp?tab=inbox";
  }
  const params = new URLSearchParams();
  params.set("tab", hasVideoReviewCompatibilityRouteState(input) || !hasReviewCompatibilityRouteState(input) ? "review" : "ops");
  for (const key of SCP_REVIEW_COMPATIBILITY_PARAMS) {
    for (const value of readCompatibilityValues(input, key)) appendCleanParam(params, key, value);
  }
  return `/flu/scp?${params.toString()}`;
}

export function buildReviewHref(target: ReviewRouteTarget): string {
  const params = new URLSearchParams();
  params.set("queue", target.kind);
  if (target.kind === "legacy") params.set("reviewId", cleanRouteValue(target.reviewId));
  if (target.kind === "qualification" || target.kind === "mail") {
    const leadId = cleanRouteValue(target.leadId);
    const applicationId = cleanRouteValue(target.applicationId);
    if (leadId) params.set("leadId", leadId);
    if (applicationId) params.set("applicationId", applicationId);
  }
  if (target.kind === "video") {
    params.set("submissionId", cleanRouteValue(target.submissionId));
    const applicationId = cleanRouteValue(target.applicationId);
    if (applicationId) params.set("applicationId", applicationId);
  }
  if (target.kind === "encouragement") {
    const targetId = cleanRouteValue(target.targetId);
    if (targetId) params.set("targetId", targetId);
  }
  withProgramId(params, target.programId);
  withCampaignId(params, "campaignId" in target ? target.campaignId : undefined);
  return `${reviewPath(target.basePath)}?${params.toString()}`;
}

export function buildReviewQueueHref(
  queue: ReviewQueueTab,
  options: { programId?: string; campaignId?: string; basePath?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set("queue", queue);
  withProgramId(params, options.programId);
  withCampaignId(params, options.campaignId);
  return `${reviewPath(options.basePath)}?${params.toString()}`;
}

export function buildReviewItemHref(item: ReviewItemRouteInput): string {
  const programId = cleanRouteValue(item.canonicalProgramId, 180)
    || cleanRouteValue(item.programId, 180);
  const basePath = cleanRouteValue(item.basePath, 80);
  const submissionId = cleanRouteValue(item.submissionId);
  if (submissionId && programId) {
    return buildReviewHref({
      kind: "video",
      submissionId,
      applicationId: cleanRouteValue(item.applicationId) || undefined,
      programId: programId || undefined,
      basePath: basePath || undefined,
    });
  }

  const reviewId = cleanRouteValue(item.reviewId) || cleanRouteValue(item.id);
  if (reviewId) {
    return buildReviewHref({
      kind: "legacy",
      reviewId,
      programId: programId || undefined,
      basePath: basePath || undefined,
    });
  }

  return buildReviewQueueHref("legacy", {
    programId: programId || undefined,
    basePath: basePath || undefined,
  });
}

export function parseEscalationRouteState(params: SearchParamsReader): EscalationRouteState {
  return {
    escalationId: cleanRouteValue(params.get("escalationId")),
    creatorId: cleanRouteValue(params.get("creatorId")),
    programId: cleanRouteValue(params.get("programId"), 180),
  };
}

export function buildEscalationHref(target: EscalationRouteTarget): string | null {
  const params = new URLSearchParams();
  const escalationId = cleanRouteValue(target.escalationId);
  const creatorId = cleanRouteValue(target.creatorId);
  const programId = cleanRouteValue(target.programId, 180);
  if (!escalationId || !creatorId || !programId) return null;
  params.set("escalationId", escalationId);
  params.set("creatorId", creatorId);
  params.set("programId", programId);
  return `/flu/cost-guide?${params.toString()}`;
}
