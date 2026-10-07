import {
  isQualificationPendingStatus,
  qualificationStatusOf,
  type QualificationStatus,
} from "./qualification-status.ts";
import { isScpProgramId } from "./scp-program-alias.ts";

export type DashboardPipelineStage = "contact" | "negotiation" | "contract" | "review" | "live";

type UnknownRow = Record<string, unknown>;

export type DashboardProgramApplication = UnknownRow & {
  id?: string;
  programId?: string;
  canonicalProgramId?: string;
  programTitle?: string;
  status?: string;
  creatorId?: string;
  conversationId?: string;
  leadId?: string;
  leadRef?: string;
  name?: string;
  email?: string;
  handle?: string;
  youtubeUrl?: string;
  platform?: string;
  followers?: number;
  avatar?: string;
  participationActive?: boolean;
  participationStatus?: string;
  participationStage?: DashboardPipelineStage;
  participationUpdatedAtIso?: string;
};

export type DashboardProgramSheetLead = UnknownRow & {
  id?: string;
  programId?: string;
  canonicalProgramId?: string;
  bridgedProgramId?: string;
  program?: string;
  programSlug?: string;
  bridgedCreatorId?: string;
  bridgedApplicationRef?: string;
  applicationId?: string;
  creatorId?: string;
  qualificationStatus?: string;
  finalVerdict?: string;
  status?: string;
  name?: string;
  email?: string;
  handle?: string;
  youtubeUrl?: string;
  platform?: string;
  followers?: number;
  subscribers?: number;
  avatar?: string;
  applicant?: UnknownRow;
  metrics?: UnknownRow;
};

type MaterializedCreator = {
  id?: string;
  programId?: string;
  canonicalProgramId?: string;
  programIds?: string[];
  applicationId?: string;
  applicationRef?: string;
  leadId?: string;
  leadRef?: string;
  sourceRef?: string;
  email?: string;
  handle?: string;
  youtubeUrl?: string;
  channelId?: string;
};

type MaterializedConversation = {
  id?: string;
  programId?: string;
  canonicalProgramId?: string;
  programIds?: string[];
  applicationId?: string;
  applicationRef?: string;
  leadId?: string;
  leadRef?: string;
  sourceRef?: string;
  creatorId?: string;
  creatorEmail?: string;
  creatorHandle?: string;
  youtubeUrl?: string;
  channelId?: string;
  participationActive?: boolean;
  participationStatus?: string;
  participationStage?: DashboardPipelineStage;
};

export type DashboardProgramPipelineRecord = {
  source: "application" | "lead";
  id: string;
  applicationId?: string;
  leadId?: string;
  programId: string;
  programTitle: string;
  stage: DashboardPipelineStage;
  status: string;
  /** R15-3: 검수 화면과 공유하는 정본 판정 상태(10필드 + 한국어 정규화). `status` 는 원값 토큰이다. */
  qualificationStatus?: QualificationStatus;
  creatorId: string;
  name: string;
  email: string;
  handle: string;
  youtubeUrl: string;
  platform: string;
  followers: number;
  avatar: string;
};

export type DashboardQualificationRouteTarget = {
  leadId?: string;
  applicationId?: string;
  programId: string;
};

export type DashboardPipelineSurfaceState = {
  showBoard: boolean;
  showLoading: boolean;
  showEmpty: boolean;
  showPartialError: boolean;
};

export function dashboardPipelineSurfaceState(input: {
  hasVisibleData: boolean;
  hasMore: boolean;
  auxiliarySettled: boolean;
  auxiliaryFailed: boolean;
  projectionSettled: boolean;
  projectionFailed: boolean;
}): DashboardPipelineSurfaceState {
  const showBoard = input.hasVisibleData || input.hasMore;
  const showPartialError = input.auxiliaryFailed || input.projectionFailed;
  const allRequiredSourcesSucceeded = input.auxiliarySettled
    && input.projectionSettled
    && !showPartialError;
  return {
    showBoard,
    showLoading: !showBoard && !showPartialError && !allRequiredSourcesSucceeded,
    showEmpty: !showBoard && allRequiredSourcesSucceeded,
    showPartialError,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function nested(row: UnknownRow, field: string): UnknownRow {
  const value = row[field];
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRow : {};
}

function normalizeToken(value: unknown): string {
  return text(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/^https?:\/\/(?:www\.)?/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, " ");
}

function safeIdFromRef(value: unknown): string {
  return text(value).split("/").filter(Boolean).at(-1) ?? "";
}

export function applicationIdFromBridgedRef(value: unknown): string {
  const segments = text(value).split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "program_applications") return "";
  return text(segments[1]);
}

function youtubeHandle(value: unknown): string {
  const normalized = normalizeToken(value);
  if (!normalized) return "";
  const marker = normalized.includes("youtube.com/@")
    ? "youtube.com/@"
    : normalized.includes("/@")
      ? "/@"
      : "";
  if (!marker) return "";
  return normalizeToken(normalized.split(marker).at(-1)).replace(/^@/, "");
}

function addAlias(aliases: Set<string>, prefix: string, value: unknown) {
  const normalized = normalizeToken(value);
  if (normalized) aliases.add(`${prefix}:${normalized}`);
}

function addHandleAliases(aliases: Set<string>, handle: unknown, youtubeUrl?: unknown) {
  const normalizedHandle = normalizeToken(handle).replace(/^@/, "");
  const urlHandle = youtubeHandle(youtubeUrl);
  if (normalizedHandle) aliases.add(`handle:${normalizedHandle}`);
  if (urlHandle) aliases.add(`handle:${urlHandle}`);
}

function addSourceReferenceAlias(aliases: Set<string>, value: unknown) {
  const reference = text(value);
  const id = safeIdFromRef(reference);
  if (!id) return;
  if (reference.includes("program_applications/")) addAlias(aliases, "application", id);
  if (reference.includes("program_sheet_leads/")) addAlias(aliases, "lead", id);
  if (reference.includes("conversations/")) addAlias(aliases, "conversation", id);
}

function creatorAliases(row: MaterializedCreator): Set<string> {
  const aliases = new Set<string>();
  addAlias(aliases, "creator", row.id);
  addAlias(aliases, "email", row.email);
  addHandleAliases(aliases, row.handle, row.youtubeUrl);
  addAlias(aliases, "youtube", row.youtubeUrl);
  addAlias(aliases, "channel", row.channelId);
  addAlias(aliases, "application", row.applicationId);
  addAlias(aliases, "lead", row.leadId);
  addSourceReferenceAlias(aliases, row.applicationRef);
  addSourceReferenceAlias(aliases, row.leadRef);
  addSourceReferenceAlias(aliases, row.sourceRef);
  return aliases;
}

function conversationAliases(row: MaterializedConversation): Set<string> {
  const aliases = new Set<string>();
  addAlias(aliases, "conversation", row.id);
  addAlias(aliases, "creator", row.creatorId);
  addAlias(aliases, "email", row.creatorEmail);
  addHandleAliases(aliases, row.creatorHandle, row.youtubeUrl);
  addAlias(aliases, "youtube", row.youtubeUrl);
  addAlias(aliases, "channel", row.channelId);
  addAlias(aliases, "application", row.applicationId);
  addAlias(aliases, "lead", row.leadId);
  addSourceReferenceAlias(aliases, row.applicationRef);
  addSourceReferenceAlias(aliases, row.leadRef);
  addSourceReferenceAlias(aliases, row.sourceRef);
  return aliases;
}

function applicationAliases(row: DashboardProgramApplication): Set<string> {
  const aliases = new Set<string>();
  addAlias(aliases, "application", row.id);
  addAlias(aliases, "conversation", row.conversationId);
  addAlias(aliases, "creator", row.creatorId);
  addAlias(aliases, "lead", row.leadId || safeIdFromRef(row.leadRef));
  addAlias(aliases, "email", row.email);
  addHandleAliases(aliases, row.handle, row.youtubeUrl);
  addAlias(aliases, "youtube", row.youtubeUrl);
  return aliases;
}

function leadAliases(row: DashboardProgramSheetLead): Set<string> {
  const applicant = nested(row, "applicant");
  const aliases = new Set<string>();
  addAlias(aliases, "lead", row.id);
  addAlias(aliases, "application", text(row.applicationId) || applicationIdFromBridgedRef(row.bridgedApplicationRef));
  addAlias(aliases, "creator", row.bridgedCreatorId || row.creatorId);
  addAlias(aliases, "email", row.email || applicant.email);
  addHandleAliases(aliases, row.handle || applicant.handle, row.youtubeUrl || applicant.youtubeUrl);
  addAlias(aliases, "youtube", row.youtubeUrl || applicant.youtubeUrl);
  addAlias(aliases, "channel", row.channelId || applicant.channelId);
  return aliases;
}

function aliasesOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const alias of left) if (right.has(alias)) return true;
  return false;
}

function overlapsAny(aliases: ReadonlySet<string>, groups: readonly ReadonlySet<string>[]): boolean {
  return groups.some((group) => aliasesOverlap(aliases, group));
}

const EXACT_MATERIALIZED_ALIAS_PREFIXES = ["application:", "lead:", "conversation:"] as const;

function exactMaterializedAliases(aliases: ReadonlySet<string>): Set<string> {
  return new Set([...aliases].filter((alias) => EXACT_MATERIALIZED_ALIAS_PREFIXES.some((prefix) => alias.startsWith(prefix))));
}

function materializedProgramScopes(row: { canonicalProgramId?: string; programId?: string; programIds?: string[] }): Set<string> {
  const values = [row.canonicalProgramId, row.programId, ...(Array.isArray(row.programIds) ? row.programIds : [])];
  return new Set(values.map((value) => canonicalProgramScope(text(value))).filter(Boolean));
}

type MaterializedAliasGroup = {
  aliases: Set<string>;
  exactAliases: Set<string>;
  programScopes: Set<string>;
};

function materializedAliasGroup(
  row: MaterializedCreator | MaterializedConversation,
  aliases: Set<string>,
  kind: "creator" | "conversation",
): MaterializedAliasGroup {
  const programScopes = materializedProgramScopes(row);
  if (kind === "creator") {
    for (const scope of [...programScopes]) {
      if (!isScpProgramId(scope)) programScopes.delete(scope);
    }
  }
  return {
    aliases,
    exactAliases: exactMaterializedAliases(aliases),
    programScopes,
  };
}

function overlapsMaterialized(
  programId: string,
  aliases: ReadonlySet<string>,
  groups: readonly MaterializedAliasGroup[],
): boolean {
  const scope = canonicalProgramScope(programId);
  return groups.some((group) => {
    if (group.programScopes.size > 0) {
      return group.programScopes.has(scope) && aliasesOverlap(aliases, group.aliases);
    }
    return aliasesOverlap(aliases, group.exactAliases);
  });
}

function isVisible(row: UnknownRow): boolean {
  return !text(row.deletedAt) && !text(row.archivedAt) && !text(row.deletedAtIso) && !text(row.archivedAtIso);
}

const SERVER_PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/;

function canonicalProgramScope(programId: string): string {
  const normalized = normalizeToken(programId);
  return isScpProgramId(normalized) ? "scp" : normalized;
}

function declaredProgramId(row: { canonicalProgramId?: string; programId?: string }): string {
  const canonicalProgramId = text(row.canonicalProgramId);
  const programId = text(row.programId);
  if (
    canonicalProgramId
    && programId
    && canonicalProgramScope(canonicalProgramId) !== canonicalProgramScope(programId)
  ) return "";
  const resolved = canonicalProgramId || programId;
  return SERVER_PROGRAM_ID_PATTERN.test(resolved) ? resolved : "";
}

function applicationProgramId(row: DashboardProgramApplication): string {
  return declaredProgramId(row);
}

function leadProgramId(row: DashboardProgramSheetLead): string {
  // The scoped list/read engine authorizes only canonicalProgramId/programId.
  // Legacy hints and Sheet provenance cannot be turned into a clickable target
  // until a migration stamps one of those authoritative fields on the document.
  return declaredProgramId(row);
}

function applicationStatus(row: DashboardProgramApplication): string {
  return normalizeToken(row.status) || "pending";
}

function leadStatus(row: DashboardProgramSheetLead): string {
  // ⚠️ 이 값은 아래 `leadRecord` 의 **종료 상태 제외 필터** 입력이다(withdrawn/excluded 등 원값 토큰을
  // 그대로 본다). 정규화하면 그 토큰들이 `unreviewed` 로 접혀 종료된 리드가 파이프라인에 되살아난다 —
  // R15-3 1차 시도에서 실제로 그렇게 깨졌고 `dashboard-actual-pipeline` 가드가 잡았다.
  // 판정 해석은 정규화가 필요하므로 레코드에 `qualificationStatus` 로 **따로** 싣는다(아래).
  return normalizeToken(row.qualificationStatus) || normalizeToken(row.finalVerdict) || normalizeToken(row.status) || "unreviewed";
}

function applicationRecord(row: DashboardProgramApplication): DashboardProgramPipelineRecord | null {
  const id = text(row.id);
  const programId = applicationProgramId(row);
  const status = applicationStatus(row);
  const participationStatus = normalizeToken(row.participationStatus);
  if (!id || !programId || participationStatus === "retracted" || ["rejected", "failed", "withdrawn", "excluded"].includes(status) || !isVisible(row)) return null;
  const participationStage = row.participationStage && ["contact", "negotiation", "contract", "review", "live"].includes(row.participationStage)
    ? row.participationStage
    : status === "approved" ? "contract" : "contact";
  return {
    source: "application",
    id,
    applicationId: id,
    ...(text(row.leadId) || safeIdFromRef(row.leadRef) ? { leadId: text(row.leadId) || safeIdFromRef(row.leadRef) } : {}),
    programId,
    programTitle: text(row.programTitle),
    stage: participationStage,
    status,
    creatorId: text(row.creatorId),
    name: text(row.name) || text(row.handle) || text(row.email) || "프로그램 신청자",
    email: text(row.email),
    handle: text(row.handle),
    youtubeUrl: text(row.youtubeUrl),
    platform: text(row.platform) || "YouTube",
    followers: finiteNumber(row.followers),
    avatar: text(row.avatar),
  };
}

function leadRecord(row: DashboardProgramSheetLead): DashboardProgramPipelineRecord | null {
  const applicant = nested(row, "applicant");
  const metrics = nested(row, "metrics");
  const id = text(row.id);
  const programId = leadProgramId(row);
  const status = leadStatus(row);
  if (!id || !programId || ["fail", "failed", "rejected", "withdrawn", "excluded"].includes(status) || !isVisible(row)) return null;
  const name = text(row.name) || text(applicant.name);
  const email = text(row.email) || text(applicant.email);
  const handle = text(row.handle) || text(applicant.handle);
  const youtubeUrl = text(row.youtubeUrl) || text(applicant.youtubeUrl);
  const applicationId = text(row.applicationId) || applicationIdFromBridgedRef(row.bridgedApplicationRef);
  return {
    source: "lead",
    id,
    qualificationStatus: qualificationStatusOf(row as unknown as Record<string, unknown>),
    ...(applicationId ? { applicationId } : {}),
    leadId: id,
    programId,
    programTitle: text(row.programTitle) || text(row.programName),
    stage: "contact",
    status,
    creatorId: text(row.bridgedCreatorId) || text(row.creatorId),
    name: name || handle || email || "프로그램 지원자",
    email,
    handle,
    youtubeUrl,
    platform: text(row.platform) || text(applicant.platform) || "YouTube",
    followers: finiteNumber(row.followers) || finiteNumber(row.subscribers) || finiteNumber(metrics.subscribers),
    avatar: text(row.avatar) || text(applicant.avatar),
  };
}

function serverDocumentId(value: unknown): string {
  const id = text(value);
  return id && id.length <= 1_500 && !id.includes("/") ? id : "";
}

/**
 * Produces only a route target the server's exact scoped reads can resolve.
 * It deliberately never derives program scope from source/spreadsheet metadata.
 */
export function dashboardQualificationRouteTarget(
  record: DashboardProgramPipelineRecord,
): DashboardQualificationRouteTarget | null {
  const programId = text(record.programId);
  if (!SERVER_PROGRAM_ID_PATTERN.test(programId)) return null;
  if (record.source === "lead") {
    const leadId = serverDocumentId(record.leadId || record.id);
    const applicationId = serverDocumentId(record.applicationId);
    if (!leadId) return null;
    return {
      leadId,
      ...(applicationId ? { applicationId } : {}),
      programId,
    };
  }
  const applicationId = serverDocumentId(record.applicationId || record.id);
  const leadId = serverDocumentId(record.leadId);
  if (!applicationId) return null;
  return {
    ...(leadId ? { leadId } : {}),
    applicationId,
    programId,
  };
}

function scopedIdentityKey(programId: string, aliases: ReadonlySet<string>, fallbackId: string): string {
  const preferred = [...aliases].find((alias) => alias.startsWith("email:"))
    || [...aliases].find((alias) => alias.startsWith("handle:"))
    || [...aliases].find((alias) => alias.startsWith("youtube:"))
    || [...aliases].find((alias) => alias.startsWith("creator:"))
    || [...aliases].find((alias) => alias.startsWith("lead:"))
    || `record:${normalizeToken(fallbackId)}`;
  return `${canonicalProgramScope(programId)}::${preferred}`;
}

/**
 * Projects only records that have not yet materialized into the CRM/chat layers.
 * Authorization and fixture filtering remain server-owned by the dataset callable;
 * this client helper only performs identity/source deduplication.
 */
export function standaloneProgramPipelineRecords(input: {
  creators: readonly MaterializedCreator[];
  conversations: readonly MaterializedConversation[];
  applications: readonly DashboardProgramApplication[];
  leads: readonly DashboardProgramSheetLead[];
}): DashboardProgramPipelineRecord[] {
  const materializedAliases = [
    ...input.creators.map((row) => materializedAliasGroup(row, creatorAliases(row), "creator")),
    ...input.conversations
      .filter((row) => row.participationStatus !== "retracted" && row.participationActive !== false)
      .map((row) => materializedAliasGroup(row, conversationAliases(row), "conversation")),
  ];
  const acceptedAliasesByScope = new Map<string, Set<string>[]>();
  const acceptedKeys = new Set<string>();
  const records: DashboardProgramPipelineRecord[] = [];

  const accept = (
    record: DashboardProgramPipelineRecord | null,
    aliases: Set<string>,
  ) => {
    if (!record || aliases.size === 0 || overlapsMaterialized(record.programId, aliases, materializedAliases)) return;
    const scope = canonicalProgramScope(record.programId);
    const scopeAliases = acceptedAliasesByScope.get(scope) ?? [];
    const key = scopedIdentityKey(record.programId, aliases, record.id);
    if (acceptedKeys.has(key) || overlapsAny(aliases, scopeAliases)) return;
    acceptedKeys.add(key);
    scopeAliases.push(aliases);
    acceptedAliasesByScope.set(scope, scopeAliases);
    records.push(record);
  };

  for (const row of input.applications) accept(applicationRecord(row), applicationAliases(row));
  for (const row of input.leads) accept(leadRecord(row), leadAliases(row));
  return records;
}

/**
 * R14-1 [BLOCKER 수리]: 자격심사 판정이 아직 안 끝난(=사람 판단이 필요한) 리드 레코드.
 *
 * 파이프라인 보드를 지우면서 **자격심사 검수 큐로 가는 앱 내 진입점이 0**이 됐다 — 큐 탭 버튼은
 * `NEXT_PUBLIC_USE_EMULATOR` 게이트라 운영 번들에 없고, 호환 워크스페이스는 URL 에 레거시 파라미터가
 * 이미 있어야 렌더된다. 즉 운영에서는 URL 을 손으로 타이핑해야만 도달했다.
 * 판정 규칙을 화면 인라인이 아니라 여기 두는 이유: **값으로 단정할 수 있어야** 가드가 된다
 * (소스 문자열 검사만으로는 표면이 조용히 사라지는 것을 못 잡는다는 걸 이번 라운드에 두 번 확인했다).
 *
 * 판정 규칙은 `@/lib/qualification-status` 정본을 **실제로 공유**한다(검수 화면도 같은 모듈을 쓴다).
 * 예전 주석은 "화면과 같은 규칙"이라고 적어놓고 실제로는 필드 수·한국어 정규화가 달랐다.
 */
export function dashboardQualificationHoldRecords(
  records: readonly DashboardProgramPipelineRecord[],
): DashboardProgramPipelineRecord[] {
  return records.filter((record) => (
    // 레코드가 정본 판정 값을 싣고 있으면 그것을, 아니면 레코드 전체를 해석기에 태운다 —
    // 어느 경로로 만들어진 레코드든 같은 규칙 하나로 판정된다.
    record.source === "lead"
    && isQualificationPendingStatus(
      record.qualificationStatus ?? qualificationStatusOf(record as unknown as Record<string, unknown>),
    )
  ));
}
