/**
 * Flu/Task-42 — org -> Flu tab preset mapping.
 * See docs/PLAN-ORG-MAIL-IDENTITY.md (getMyOrgContext / settings/mail_routing this builds on)
 * and the ticket for the data model. Mirrors functions/mailAccounts.ts's settings/mail_routing
 * shape exactly: a single settings/org_tab_presets doc holding byOrgId (partial-merge writes,
 * a `null` value removes a mapping). No mapping for an org = the current default (the full
 * FLU_NAV tab set) — this gives the Growth-org "zero behavior change" requirement for free,
 * since Growth simply never gets a byOrgId entry.
 *
 * Tab hiding driven by this module is a UI convenience only — it does not gate any server data
 * path. Each tab's own callables keep validating access the way they already do (see
 * functions/read.ts canReadConversationForAuth / resolveViewerOrgIdForConversationRead for the
 * Chat example); this module never opens a new one.
 *
 * 2026-09-11 헤세 결정: "candidates"는 opt-in 탭이다(src/lib/nav.ts FLU_NAV item.optIn) — 매핑이
 * 없는 조직(Growth)은 이 서버 목록에 "candidates"가 있어도 클라이언트가 자동으로 숨긴다; 어드민이
 * 프리셋에 "candidates"를 명시한 조직만 노출된다.
 */
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { resolveMailAccountsDb, type MailAccountsFirestoreDb } from "./mailAccounts";

export const ORG_TAB_PRESETS_DOC_PATH = "settings/org_tab_presets";
export const DEFAULT_ORG_TAB_PRESET_POLICY_VERSION = "org-tab-presets-v1" as const;
// Reads are always fresh from Firestore (this doc changes rarely — admin-only writes), but we
// still cache the read for a short window: getMyOrgContext now calls resolveNavPresetForOrg on
// every app-shell mount, so an uncached read would add a Firestore get to a per-navigation call
// that previously had none. Mirrors functions/mailAccounts.ts's
// MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS (5 min) — same "5분 캐시 내 반영" propagation window the
// ticket's completion criteria call for.
export const ORG_TAB_PRESETS_CACHE_TTL_MS = 5 * 60 * 1000;

// Mirrors src/lib/nav.ts FLU_NAV's `key` values — duplicated as a literal because functions/
// never imports from src/ (functions/tsconfig.json rootDir "." + include ["*.ts"] only covers
// this package). Keep both lists in sync by hand when FLU_NAV changes; an admin can never write
// a key this list doesn't know about (setOrgTabPresets below rejects it), so a stale/behind copy
// here just makes a brand-new nav item unavailable for presets until this list catches up —
// never unsafe. Flu/Task-43 (2026-09-10): "candidates" (후보) shipped — src/lib/nav.ts FLU_NAV
// now has the route (/flu/candidates), so it's listed here too.
export const FLU_NAV_KEYS = [
  "dashboard",
  "programs",
  "candidates",
  "scp",
  "manage",
  "partners",
  "feed",
  "report",
  "settings",
] as const;
export type FluNavKey = typeof FLU_NAV_KEYS[number];

export function isFluNavKey(value: unknown): value is FluNavKey {
  return typeof value === "string" && (FLU_NAV_KEYS as readonly string[]).includes(value);
}

export type OrgTabPresets = {
  readonly byOrgId: Readonly<Record<string, readonly string[]>>;
  readonly policyVersion: string;
  /** Monotonic optimistic-concurrency version. Legacy documents without it start at 0. */
  readonly revision: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
};

/** Permissive read-side parse: unknown/invalid keys are dropped, never thrown (defensive read —
 * mirrors functions/mailAccounts.ts readMailRouting's byOrgId parsing). */
function parseStoredNavKeyArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (isFluNavKey(item)) seen.add(item);
  }
  return [...seen];
}

function storedRevision(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function requiredExpectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidArgument("expectedRevision must be a non-negative integer");
  }
  return value;
}

let cachedPresets: { expiresAt: number; value: OrgTabPresets } | null = null;

type OrgTabPresetOwnershipScope = { orgId: string | null };
let ownershipResolverOverrideForTests: ((request: CallableRequestShape, action: string, roles: readonly ("admin" | "manager" | "viewer")[]) => Promise<OrgTabPresetOwnershipScope>) | null = null;

/** Narrow test seam: production always uses accountOwnership's verified auth + Peoply resolver. */
export function setOrgTabPresetOwnershipResolverForTests(
  resolver: typeof ownershipResolverOverrideForTests,
): void {
  ownershipResolverOverrideForTests = resolver;
}

async function resolveVerifiedPresetOwnership(
  request: CallableRequestShape,
  action: string,
  roles: readonly ("admin" | "manager" | "viewer")[],
): Promise<OrgTabPresetOwnershipScope> {
  if (ownershipResolverOverrideForTests) return ownershipResolverOverrideForTests(request, action, roles);
  // Avoid a top-level accountOwnership import: accountOwnership already depends on the org
  // context callable, which imports this module. The dynamic import preserves the canonical
  // verified-email/Peoply ownership resolver without introducing an initialization cycle.
  const { resolveAccountOwnershipScopeForRequest, assertResolvedAccountOwnershipScope } = await import("./accountOwnership");
  const scope = await resolveAccountOwnershipScopeForRequest(request, action, roles);
  assertResolvedAccountOwnershipScope(scope, "org tab preset");
  return { orgId: scope.orgId };
}

async function readOrgTabPresetsUncached(db: MailAccountsFirestoreDb): Promise<OrgTabPresets> {
  const snapshot = await db.doc(ORG_TAB_PRESETS_DOC_PATH).get();
  const data = snapshot.exists ? asRecord(snapshot.data()) : {};
  const byOrgIdRaw = asRecord(data.byOrgId);
  const byOrgId: Record<string, string[]> = {};
  for (const [orgId, navKeysValue] of Object.entries(byOrgIdRaw)) {
    const navKeys = parseStoredNavKeyArray(navKeysValue);
    if (navKeys.length > 0) byOrgId[orgId] = navKeys;
  }
  return {
    byOrgId,
    policyVersion: asString(data.policyVersion, DEFAULT_ORG_TAB_PRESET_POLICY_VERSION),
    revision: storedRevision(data.revision),
    updatedBy: asString(data.updatedBy, ""),
    updatedAt: asString(data.updatedAt, ""),
  };
}

export async function readOrgTabPresets(
  deps: { db?: MailAccountsFirestoreDb; now?: () => number } = {},
): Promise<OrgTabPresets> {
  const now = deps.now ?? (() => Date.now());
  if (!deps.db && cachedPresets && cachedPresets.expiresAt > now()) return cachedPresets.value;
  const db = resolveMailAccountsDb(deps.db);
  const value = await readOrgTabPresetsUncached(db);
  // Only cache the default (non-overridden) db lookup — a test-injected db must never be cached
  // process-wide, or one test's fake db would leak its result into the next.
  if (!deps.db) cachedPresets = { expiresAt: now() + ORG_TAB_PRESETS_CACHE_TTL_MS, value };
  return value;
}

/** Clears the process-local cache. Call after a settings/org_tab_presets write so this instance
 * sees the change immediately; other instances converge within ORG_TAB_PRESETS_CACHE_TTL_MS. */
export function clearOrgTabPresetsCache(): void {
  cachedPresets = null;
}

/** Resolves the FLU_NAV key allowlist for an org: null = no restriction (the full tab set) —
 * either the org has no mapping, or the caller has no resolved org at all. */
export async function resolveNavPresetForOrg(
  orgId: string | null,
  deps: { db?: MailAccountsFirestoreDb } = {},
): Promise<readonly string[] | null> {
  if (!orgId) return null;
  const presets = await readOrgTabPresets(deps);
  return presets.byOrgId[orgId] ?? null;
}

/** The candidates tab is opt-in for every organization. This is the server counterpart of
 * src/lib/nav.ts's optIn handling: an absent preset never accidentally grants candidate data. */
export async function orgTabAllows(
  orgId: string | null,
  tab: FluNavKey,
  deps: { db?: MailAccountsFirestoreDb } = {},
): Promise<boolean> {
  const preset = await resolveNavPresetForOrg(orgId, deps);
  return Boolean(preset?.includes(tab));
}

export type PartnerDataSource = "scp" | "candidate_reply";

/**
 * Flu/Task-46 적대 리뷰 MEDIUM-1 (2026-09-11), 3회차 P2 수리: 파트너 탭 데이터 소스는 서버가
 * 판정한다 — 클라이언트의 `navPreset.includes("scp")` 문자열 검사(위조/변조 가능)를 신뢰하지
 * 않는다. 정의: navPreset이 있고(=이 org에 admin이 설정한 프리셋이 있고) "candidates" 탭을
 * 포함하며 "scp"는 포함하지 않을 때만 candidate_reply(AI Drama) — "candidates" 탭이 아예
 * 없는 프리셋(파트너 탭과 무관한 다른 조합)까지 candidate_reply로 새는 것을 막는다. 그 외
 * (프리셋 없음 = Growth 기본, "candidates" 미포함, 또는 프리셋이 "scp"를 포함)는 전부 scp —
 * fail-open Growth(navPreset 조회 실패는 resolveNavPresetForOrg 자신이 이미 null로 감싸지
 * 않으므로 이 함수가 캐치한다: 실패해도 scp로 안전하게 떨어진다).
 */
export function partnerDataSourceFromNavPreset(navPreset: readonly string[] | null): PartnerDataSource {
  return navPreset !== null && navPreset.includes("candidates") && !navPreset.includes("scp")
    ? "candidate_reply"
    : "scp";
}

/** resolveNavPresetForOrg + partnerDataSourceFromNavPreset을 한 번에 — 프리셋 조회 실패도
 * scp(안전한 기본값)로 감싼다. 별도 캐시 호출 없이(readOrgTabPresets의 기존 TTL 캐시를 그대로
 * 탄다) 여러 호출부(getMyOrgContext, listCandidateReplyPartners)가 같은 정의를 재사용한다. */
export async function resolvePartnerDataSourceForOrg(
  orgId: string | null,
  deps: { db?: MailAccountsFirestoreDb } = {},
): Promise<PartnerDataSource> {
  let navPreset: readonly string[] | null = null;
  try {
    navPreset = await resolveNavPresetForOrg(orgId, deps);
  } catch {
    navPreset = null;
  }
  return partnerDataSourceFromNavPreset(navPreset);
}

// ---------- admin callables ----------

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "org_tab_presets_invalid_argument",
  });
}

/** Strict write-side parse: throws on an empty array or an unknown key so an admin gets clear
 * feedback instead of a silently-dropped key (mirrors setMailRouting's per-entry validation). */
function parseWritableNavKeyArray(orgId: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidArgument(`byOrgId.${orgId} must be a non-empty array of Flu nav keys`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!isFluNavKey(item)) {
      throw invalidArgument(`byOrgId.${orgId} contains an unknown nav key: ${JSON.stringify(item)}`);
    }
    seen.add(item);
  }
  return [...seen];
}

export async function getOrgTabPresets(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "org_tab_presets.list", ["super_admin", "admin", "manager", "viewer"]);
  const presets = await readOrgTabPresets();
  if (auth.role === "super_admin") {
    return {
      ok: true,
      presets,
      behaviorLog: makeBehaviorLog(auth, "org_tab_presets.list", "success", "global", 0),
    };
  }
  const scope = await resolveVerifiedPresetOwnership(request, "org_tab_presets.list", ["admin", "manager", "viewer"]);
  if (!scope.orgId) throw Object.assign(new Error("failed-precondition: org tab preset account ownership is unavailable"), { code: "failed-precondition", errorCode: "account_ownership_scope_unavailable" });
  const ownPreset = presets.byOrgId[scope.orgId!] ?? null;
  return {
    ok: true,
    presets: {
      ...presets,
      byOrgId: ownPreset ? { [scope.orgId!]: ownPreset } : {},
    },
    behaviorLog: makeBehaviorLog(auth, "org_tab_presets.list", "success", "global", 0),
  };
}

export async function setOrgTabPresets(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "org_tab_presets.update", ["super_admin", "admin"]);
  const data = asRecord(request.data);
  // Shadow is an observational projection. It must never be accepted by a settings mutation,
  // even when the authenticated caller remains a super_admin.
  if (asString(data.viewAsUserId) || asString(data.viewAsEmail)) {
    throw Object.assign(new Error("permission-denied: org tab presets cannot be mutated while using viewAs"), {
      code: "permission-denied",
      errorCode: "org_tab_presets_view_as_write_forbidden",
    });
  }
  const db = resolveMailAccountsDb();
  const expectedRevision = requiredExpectedRevision(data.expectedRevision);
  // Partial-update callable (same doctrine as setMailRouting): the current doc is read first and
  // merged — never blind-overwritten from just the incoming payload, or another admin's mapping
  // would be silently dropped. 2026-09-10 adversarial review HIGH-2: the merge base must be a
  // Firestore FRESH read (readOrgTabPresetsUncached), never the process-local cache — this write
  // ends with a full overwrite (`merge: false` below), so a stale cache here would silently drop
  // a mapping another admin/instance wrote within the last ORG_TAB_PRESETS_CACHE_TTL_MS. Mirrors
  // readMailRouting, which setMailRouting always reads uncached for the same reason.
  const adminScope = auth.role === "admin"
    ? await resolveVerifiedPresetOwnership(request, "org_tab_presets.update", ["admin"])
    : null;
  if (adminScope && !adminScope.orgId) throw Object.assign(new Error("failed-precondition: org tab preset account ownership is unavailable"), { code: "failed-precondition", errorCode: "account_ownership_scope_unavailable" });
  const byOrgIdInput = asRecord(data.byOrgId);
  const buildNext = (current: OrgTabPresets): OrgTabPresets => {
    if (current.revision !== expectedRevision) {
      throw Object.assign(new Error("aborted: org tab presets revision is stale"), {
        code: "aborted",
        errorCode: "org_tab_presets_revision_stale",
      });
    }
    const byOrgId: Record<string, string[]> = Object.fromEntries(
      Object.entries(current.byOrgId).map(([orgId, navKeys]) => [orgId, [...navKeys]]),
    );
    for (const [orgId, navKeysValue] of Object.entries(byOrgIdInput)) {
      const trimmedOrgId = orgId.trim();
      if (!trimmedOrgId) throw invalidArgument("byOrgId keys must be non-empty org ids");
      if (adminScope && trimmedOrgId !== adminScope.orgId) {
        throw Object.assign(new Error("permission-denied: admin may update only their verified organization preset"), {
          code: "permission-denied",
          errorCode: "org_tab_presets_scope_mismatch",
        });
      }
      if (navKeysValue === null) delete byOrgId[trimmedOrgId];
      else byOrgId[trimmedOrgId] = parseWritableNavKeyArray(trimmedOrgId, navKeysValue);
    }
    return {
      byOrgId,
      policyVersion: DEFAULT_ORG_TAB_PRESET_POLICY_VERSION,
      revision: current.revision + 1,
      updatedBy: auth.userId,
      updatedAt: new Date().toISOString(),
    };
  };
  const ref = db.doc(ORG_TAB_PRESETS_DOC_PATH);
  type OrgTabPresetDocumentRef = {
    get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
    set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  };
  type TransactionalDb = {
    runTransaction<T>(fn: (transaction: { get(ref: OrgTabPresetDocumentRef): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>; set(ref: OrgTabPresetDocumentRef, data: OrgTabPresets, options?: { merge?: boolean }): void }) => Promise<T>): Promise<T>;
  };
  const transactional = db as unknown as Partial<TransactionalDb>;
  const next = typeof transactional.runTransaction === "function"
    ? await transactional.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const raw = snapshot.exists ? asRecord(snapshot.data()) : {};
      const current: OrgTabPresets = {
        byOrgId: Object.fromEntries(Object.entries(asRecord(raw.byOrgId)).map(([orgId, navKeys]) => [orgId, parseStoredNavKeyArray(navKeys)]).filter(([, navKeys]) => navKeys.length > 0)),
        policyVersion: asString(raw.policyVersion, DEFAULT_ORG_TAB_PRESET_POLICY_VERSION),
        revision: storedRevision(raw.revision),
        updatedBy: asString(raw.updatedBy),
        updatedAt: asString(raw.updatedAt),
      };
      const next = buildNext(current);
      transaction.set(ref, next, { merge: false });
      return next;
    })
    : (() => {
      // Test doubles deliberately omit Firestore transactions. Production adminDb supplies one;
      // retain this deterministic fallback only so the existing narrow unit seam remains usable.
      throw new Error("org_tab_presets transaction support is required");
    })();
  clearOrgTabPresetsCache();

  return {
    ok: true,
    presets: next,
    behaviorLog: makeBehaviorLog(auth, "org_tab_presets.update", "success", "global", 0),
  };
}
