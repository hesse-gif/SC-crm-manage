import { FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { POLICY_CACHE_TTL_SECONDS, SETTINGS, type Settings } from "./_settings-mock";
import { normalizeAdSpendRates } from "./videoSponsorship";
import { normalizeYoutubeCreatorCountryAllowlist } from "./youtubeCreatorCountries";
import { isCallerScpEntitled, readMailAccounts } from "./mailAccounts";
import { resolveViewAsTarget } from "./mailAccountCallables";
import type { AuthContext } from "./shared";

export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";

export type CallableRequest = {
  auth?: { uid?: string; token?: { role?: Role; team?: string; gameId?: string; email?: string } };
  data?: unknown;
  rawRequest?: { ip?: string };
  /**
   * W76-③ R1-P1-6: **서버 내부 호출 표식.**
   * 공개 콜러블 입구에서 서버 소유 필드(목 폴백 허용·인입 증거)를 strip 할 때 내부 워커
   * 호출만 예외로 통과시키는 축이다. 외부 요청은 이 값을 세울 수 없다 — HTTPS 콜러블
   * 프레임이 만들어 주는 요청 객체에는 존재하지 않는다.
   */
  internalTrustedInvocation?: boolean;
};

type BehaviorResult = "success" | "denied";

type CostLog = {
  provider: "mock";
  model: "policy-cache" | "none";
  tokensIn: 0;
  tokensOut: 0;
  estimatedUsd: 0;
  cacheChecked: boolean;
  reason: string;
};

type BehaviorLog = {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: BehaviorResult;
  cost: number;
};

type CacheMeta = {
  key: string;
  status: "hit" | "miss" | "refresh";
  ttlSeconds: typeof POLICY_CACHE_TTL_SECONDS;
  expiresAt: string;
};

type CallableOk<T> = T & {
  ok: true;
  cache: CacheMeta;
  costLog: CostLog;
  behaviorLog: BehaviorLog;
};

type CallableDenied = {
  ok: false;
  error: { code: "permission-denied"; message: string };
  cache: CacheMeta;
  costLog: CostLog;
  behaviorLog: BehaviorLog;
};

type PolicyCacheSnapshot = {
  key: typeof POLICY_CACHE_KEY;
  version: number;
  ttlSeconds: typeof POLICY_CACHE_TTL_SECONDS;
  expiresAt: string;
  automation: Settings["automation"];
  mailSafety: Settings["mailSafety"];
  programAi: Settings["programAi"];
  humanReviewPolicy: Settings["humanReviewPolicy"];
  costGuide: Settings["guideLinks"]["costGuide"];
  negotiationGuide: Settings["guideLinks"]["negotiationGuide"];
  negotiationCriteria: Settings["negotiationCriteria"];
  negotiationPricing: Settings["negotiationPricing"];
  llmModelRoutes: Settings["llmModelRoutes"];
  contractPolicy: Pick<Settings["contract"], "startRatio" | "targetRatio" | "exclusivityDays" | "payTermDays">;
};

const READ_ROLES = new Set<Role>(["super_admin", "admin", "manager", "viewer"]);
const WRITE_ROLES = new Set<Role>(["super_admin", "admin", "manager"]);
const SETTINGS_CACHE_KEY = "settings:default:v1";
const POLICY_CACHE_KEY = "settings:policy:v1";
export const SETTINGS_AUDIT_COLLECTION = "settings_audit_log";
// R5-C: weekly cap 권한은 인터뷰 미확정 상태로 manager 편집 가능을 그대로 유지한다(super_admin
// 승격 없음, 안전 디폴트). 대신 "누가/언제/이전값→새값"을 별도 감사 로그로 강화해 관측성만 높인다.
const WEEKLY_CAP_AUDIT_COLLECTION = "mail_weekly_cap_audit_log";

function settingsDoc() {
  return adminDb.doc("settings/default");
}

function policyCacheDoc() {
  return adminDb.doc("settings/policy_cache");
}

export async function getSettings(request: CallableRequest): Promise<CallableOk<{
  settings: Settings;
  revision: number;
  settingsContract: SettingsContractMeta;
}> | CallableDenied> {
  const costLog = makeCostLog("none", true, "settings read uses persisted Firestore settings");
  const auth = authorize(request, READ_ROLES, "settings.get", costLog);
  const cache = makeCache(SETTINGS_CACHE_KEY, "hit");

  if (!auth.allowed) return denied(auth.behaviorLog, cache, costLog);

  const { settings, revision, settingsContract } = await readSettingsWithRevisionCached();
  const scpEntitled = await callerScpEntitled(request);

  return {
    ok: true,
    settings: scpEntitled ? settings : stripScpAutomationFields(settings),
    revision,
    settingsContract,
    cache,
    costLog,
    behaviorLog: auth.behaviorLog,
  };
}

export async function updateSettings(request: CallableRequest): Promise<CallableOk<{
  settings: Settings;
  revision: number;
  updatedKeys: string[];
  changedKeys: string[];
  noop: boolean;
}> | CallableDenied> {
  const costLog = makeCostLog("policy-cache", true, "settings write invalidates persisted policy cache");
  const auth = authorize(request, WRITE_ROLES, "settings.update", costLog);
  const deniedCache = makeCache(SETTINGS_CACHE_KEY, "refresh");

  if (!auth.allowed) return denied(auth.behaviorLog, deniedCache, costLog);

  const patch = extractSettingsPatch(request.data);
  const expectedRevision = extractExpectedRevision(request.data);
  const role = request.auth?.token?.role ?? "guest";
  const viewAsRequested = isRecord(request.data)
    && (typeof request.data.viewAsUserId === "string" || typeof request.data.viewAsEmail === "string");
  if (viewAsRequested) {
    throwCodedError("failed-precondition", "settings cannot be changed while viewing as another member");
  }
  const confirm = isRecord(request.data) && (request.data as Record<string, unknown>).confirm === true;
  // Malformed section types are rejected: an object-typed settings section replaced by a non-object (array/scalar) would
  // make later leaf patches look like parent-only changes. (classification_v1 review: super_admin toggle bypass.)
  for (const [sectionKey, sectionValue] of Object.entries(patch)) {
    if (isRecord((SETTINGS as Record<string, unknown>)[sectionKey]) && !isRecord(sectionValue)) {
      throwCodedError("invalid-argument", `settings section ${sectionKey} must be an object`);
    }
  }
  const outboundPolicyPatch = isRecord(patch.mailSafety) && isRecord((patch.mailSafety as Record<string, unknown>).outboundPolicy)
    ? (patch.mailSafety as Record<string, unknown>).outboundPolicy as Record<string, unknown>
    : null;
  const actorUidHash = settingsActorUidHash(request.auth?.uid);
  const nowIso = new Date().toISOString();
  // 2026-09-27 codex adversarial review FAIL-5: resolved once, outside the transaction (a Peoply
  // lookup has no business retrying inside a Firestore transaction retry loop) — used below to
  // reject a change to either scp-only field for a non-entitled caller.
  const scpEntitled = await callerScpEntitled(request);
  const mutation = await adminDb.runTransaction(async (transaction) => {
    const settingsRef = settingsDoc();
    const cacheRef = policyCacheDoc();
    const [settingsSnapshot, policyCacheSnapshot] = await Promise.all([
      transaction.get(settingsRef),
      transaction.get(cacheRef),
    ]);
    const currentRecord = settingsSnapshot.data() ?? {};
    const current = mergeSettings(clone(SETTINGS), settingsSectionsFromRecord(currentRecord));
    const currentRevision = settingsRevisionFromRecord(currentRecord);
    if (expectedRevision !== currentRevision) {
      throwCodedError("aborted", "settings revision conflict");
    }

    const settings = mergeSettings(current, patch);
    const changedKeys = settingsChangedKeys(current, settings, patch);
    const inboundAllowlistChanged = changedKeys.includes("automation.inboundAutoReplyAllowedMailAccountIds");
    if (inboundAllowlistChanged) {
      if (role !== "super_admin") {
        throwCodedError("failed-precondition", "super_admin role is required for inbound auto-reply mailbox allowlist");
      }
      await assertInboundAutoReplyAllowlistAccounts(settings.automation.inboundAutoReplyAllowedMailAccountIds);
    }
    // 0.6.110 integration review (Codex): automation.emailUploadSampling is read by the
    // emailUploadSamplingSchedule onSchedule worker, which spends YouTube quota and mutates
    // candidates as a system actor. Letting manager/admin persist it through this general save path
    // would bypass the super_admin-only emailUploadSamplingBackfill callable, so the whole subtree
    // requires super_admin server-side (rejected, not stripped, so the operator sees it).
    const emailUploadSamplingChanged = changedKeys.some((key) => key === "automation.emailUploadSampling"
      || key.startsWith("automation.emailUploadSampling."));
    if (emailUploadSamplingChanged && role !== "super_admin") {
      throwCodedError("permission-denied", "super_admin role is required to change automation.emailUploadSampling");
    }
    // classification_v1 (2026-10-03): this toggle opens an AUTOMATIC reply lane (contact_channel_request redirect) —
    // like the inbound auto-reply allowlist it is super_admin-only (rejected, not stripped). Authorized on the
    // BEFORE/AFTER value, not on changed-key paths: a type-changing patch (e.g. humanReviewPolicy: []) only reports the
    // parent key, so a path check alone could be walked around in two saves.
    const redirectToggleBefore = (current.humanReviewPolicy as Record<string, unknown> | undefined)?.allowEmailOnlyRedirectForContactChannelRequest === true;
    const redirectToggleAfter = (settings.humanReviewPolicy as Record<string, unknown> | undefined)?.allowEmailOnlyRedirectForContactChannelRequest === true;
    if (redirectToggleBefore !== redirectToggleAfter && role !== "super_admin") {
      throwCodedError("permission-denied", "super_admin role is required to change humanReviewPolicy.allowEmailOnlyRedirectForContactChannelRequest");
    }
    // identity_only auto-reply kill switch (default ON; only an explicit false turns it off). Same before/after rule: any
    // change of the effective value needs super_admin, so a type-changing patch cannot walk around a path check.
    const identityOnlyBefore = (current.humanReviewPolicy as Record<string, unknown> | undefined)?.allowIdentityOnlyAutoReply !== false;
    const identityOnlyAfter = (settings.humanReviewPolicy as Record<string, unknown> | undefined)?.allowIdentityOnlyAutoReply !== false;
    if (identityOnlyBefore !== identityOnlyAfter && role !== "super_admin") {
      throwCodedError("permission-denied", "super_admin role is required to change humanReviewPolicy.allowIdentityOnlyAutoReply");
    }
    // 2026-09-27 codex adversarial review FAIL-5: these two fields are scp mailbox operational
    // config (auto-read behavior + coldmail follow-up cadence) — a role-permitted but
    // non-entitled manager/admin must not be able to change them even though the rest of
    // "automation"/"manageRules" is general-purpose and stays writable by any WRITE_ROLES caller.
    const scpAutomationFieldChanged = changedKeys.includes("automation.dismissAgencyAndUnregisteredSenderMail")
      || changedKeys.includes("manageRules.autoFollowupDays");
    if (scpAutomationFieldChanged && !scpEntitled) {
      throwCodedError("permission-denied", "scp entitlement is required to change scp mailbox automation settings");
    }
    const changedSections = Array.from(new Set(changedKeys.map((key) => key.split(".")[0]))).sort();
    if (changedKeys.length === 0) {
      return {
        settings,
        revision: currentRevision,
        updatedKeys: changedSections,
        changedKeys,
        noop: true,
        policyCache: policyCacheSnapshot.exists
          ? policyCacheFromRecord(settings, policyCacheSnapshot.data() ?? {})
          : makePolicyCache(settings, 0, expiresAtFrom(new Date())),
      };
    }

    // M2: only an actual transition into a high-volume or trusted-reputation
    // state requires super_admin + an explicit second confirmation.
    if (outboundPolicyPatch !== null && requiresHighRiskConfirmation(current, settings, outboundPolicyPatch)) {
      if (role !== "super_admin" || !confirm) {
        const reason = role !== "super_admin"
          ? "super_admin role is required"
          : "confirm: true is required for a high-risk settings change";
        throwCodedError("failed-precondition", reason);
      }
    }

    const nextRevision = currentRevision + 1;
    const previousWeeklyTotalCap = current.mailSafety.outboundPolicy.weeklyTotalCap;
    const weeklyTotalCapChanged = settings.mailSafety.outboundPolicy.weeklyTotalCap !== previousWeeklyTotalCap;
    const policyVersion = typeof policyCacheSnapshot.data()?.version === "number"
      ? policyCacheSnapshot.data()?.version as number
      : 0;
    const policyCache = makePolicyCache(settings, policyVersion + 1, expiresAtFrom(new Date()));

    transaction.set(settingsRef, {
      ...settings,
      revision: nextRevision,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByHash: actorUidHash,
    }, { merge: true });

    // MAIL-SETTINGS-CANONICAL: keep the legacy outbound-policy read overlay in
    // the same CAS transaction so the UI revision and send-engine policy cannot
    // diverge after a partially successful write.
    if (outboundPolicyPatch !== null) {
      transaction.set(adminDb.doc("settings/email"), {
        outboundPolicy: settings.mailSafety.outboundPolicy,
        settingsRevision: nextRevision,
        updatedAt: FieldValue.serverTimestamp(),
        updatedAtIso: nowIso,
        updatedByHash: actorUidHash,
        source: "functions.updateSettings",
      }, { merge: true });
    }

    transaction.set(cacheRef, {
      ...policyCache,
      settingsRevision: nextRevision,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const settingsAuditRef = adminDb.collection(SETTINGS_AUDIT_COLLECTION).doc();
    transaction.create(settingsAuditRef, makeSettingsAuditRecord({
      settingsRevision: nextRevision,
      changedSections,
      changedKeys,
      actorUidHash,
      actorRole: role,
      createdAtIso: nowIso,
      source: "functions.updateSettings",
    }));

    if (weeklyTotalCapChanged) {
      const weeklyAuditRef = adminDb.collection(WEEKLY_CAP_AUDIT_COLLECTION).doc();
      transaction.create(weeklyAuditRef, {
        field: "mailSafety.outboundPolicy.weeklyTotalCap",
        settingsRevision: nextRevision,
        actorUidHash,
        actorRole: role,
        createdAtIso: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      settings,
      revision: nextRevision,
      updatedKeys: changedSections,
      changedKeys,
      noop: false,
      policyCache,
    };
  });

  const { settings, revision, updatedKeys, changedKeys, noop, policyCache } = mutation;
  // Perf/cost 2026-09-24: drop this instance's cached settings read so the same warm instance's
  // very next getSettings/getAppBootstrap sees the write immediately instead of waiting out the
  // TTL — see readSettingsWithRevisionCached above.
  settingsInstanceCacheEntry = null;
  const cache = makeCache(SETTINGS_CACHE_KEY, "refresh", policyCache.expiresAt);

  return {
    ok: true,
    // 2026-09-27 codex adversarial review round 2 FAIL-1: this returned the full merged settings
    // (including the caller's real scp automation values) after ANY permitted save, even a no-op
    // or a change to an unrelated field — a non-entitled manager could read the actual scp values
    // this way even though getSettings already masks them. Same strip, same entitlement source.
    settings: scpEntitled ? settings : stripScpAutomationFields(settings),
    revision,
    updatedKeys,
    changedKeys,
    noop,
    cache,
    costLog,
    behaviorLog: auth.behaviorLog,
  };
}

export async function refreshPolicyCache(request: CallableRequest): Promise<CallableOk<{ policyCache: PolicyCacheSnapshot }> | CallableDenied> {
  const costLog = makeCostLog("policy-cache", true, "policy cache refresh links cost and negotiation guides");
  const auth = authorize(request, WRITE_ROLES, "settings.policyCache.refresh", costLog);
  const deniedCache = makeCache(POLICY_CACHE_KEY, "refresh");

  if (!auth.allowed) return denied(auth.behaviorLog, deniedCache, costLog);

  const settings = await readSettings();
  const policyCache = await writePolicyCache(settings);
  const cache = makeCache(POLICY_CACHE_KEY, "refresh", policyCache.expiresAt);

  return {
    ok: true,
    policyCache,
    cache,
    costLog,
    behaviorLog: auth.behaviorLog,
  };
}

export async function readSettings(): Promise<Settings> {
  return (await readSettingsWithRevision()).settings;
}

type SettingsContractMeta = {
  firestorePath: "settings/default";
  source: "persisted" | "initialized_defaults";
  persistedSections: string[];
};

type SettingsWithRevision = {
  settings: Settings;
  revision: number;
  settingsContract: SettingsContractMeta;
};

function persistedSettingsSections(record: Record<string, unknown>): string[] {
  return Object.keys(settingsSectionsFromRecord(record)).sort();
}

// Perf/cost 2026-09-24: getSettings ran a fresh 2-doc Firestore transaction on every call even
// though settings/default is a single global doc shared by every caller (no per-org/team/gameId
// scoping — see SETTINGS_CACHE_KEY above, a constant not a template). Memoize the caller-
// independent read for a short TTL in the Cloud Functions instance's own memory: a warm instance
// serving several getSettings/getAppBootstrap calls in a row reuses one transaction instead of
// repeating it. Deliberately short relative to this codebase's other instance-lifetime caches
// (MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS/ORG_TAB_PRESETS_CACHE_TTL_MS in functions/mailAccounts.ts
// and functions/orgTabPresets.ts are both 5min) since updateSettings below invalidates it
// explicitly anyway — the TTL only bounds staleness on *other* warm instances that didn't see
// the write.
const SETTINGS_INSTANCE_CACHE_TTL_MS = 20_000;
let settingsInstanceCacheEntry: { expiresAt: number; value: Promise<SettingsWithRevision> } | null = null;

function readSettingsWithRevisionCached(): Promise<SettingsWithRevision> {
  const now = Date.now();
  if (settingsInstanceCacheEntry && settingsInstanceCacheEntry.expiresAt > now) {
    return settingsInstanceCacheEntry.value;
  }
  const value = readSettingsWithRevision();
  settingsInstanceCacheEntry = { expiresAt: now + SETTINGS_INSTANCE_CACHE_TTL_MS, value };
  value.catch(() => {
    if (settingsInstanceCacheEntry?.value === value) settingsInstanceCacheEntry = null;
  });
  return value;
}

/** Test-only: forces the next getSettings call to hit Firestore again. */
export function __clearSettingsInstanceCacheForTests(): void {
  settingsInstanceCacheEntry = null;
}

// Exported (auto-reply-backlog recentlyDenied re-arm fix, 2026-09-27) so
// autoReplyBacklog.ts's requeue policy fingerprint can compare the settings/default CAS
// revision without re-implementing readSettings()'s own transaction — see
// defaultReadRequeuePolicyFingerprint in autoReplyBacklog.ts for why the bare revision
// number (not just the settings content) is the more precise signal: it bumps on every
// settings/default mutation, including a humanReviewPolicy.jevAlwaysSendCaseIds change,
// which is exactly the kind of policy change that should re-open a previously-denied
// backlog candidate for re-judgment.
export async function readSettingsWithRevision(): Promise<SettingsWithRevision> {
  const result = await adminDb.runTransaction<SettingsWithRevision>(async (transaction) => {
    const ref = settingsDoc();
    const cacheRef = policyCacheDoc();
    const [snapshot, cacheSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(cacheRef),
    ]);
    if (snapshot.exists) {
      const record = snapshot.data() ?? {};
      const settings = mergeSettings(clone(SETTINGS), settingsSectionsFromRecord(record));
      const revision = settingsRevisionFromRecord(record);
      if (!cacheSnapshot.exists) {
        transaction.set(cacheRef, {
          ...makePolicyCache(settings, 1, expiresAtFrom(new Date())),
          settingsRevision: revision,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return {
        settings,
        revision,
        settingsContract: {
          firestorePath: "settings/default",
          source: "persisted",
          persistedSections: persistedSettingsSections(record),
        },
      };
    }
    const settings = clone(SETTINGS);
    const revision = 1;
    const initializedRecord: Record<string, unknown> = {
      ...settings,
      revision,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(ref, initializedRecord);
    if (!cacheSnapshot.exists) {
      transaction.set(cacheRef, {
        ...makePolicyCache(settings, 1, expiresAtFrom(new Date())),
        settingsRevision: revision,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return {
      settings,
      revision,
      settingsContract: {
        firestorePath: "settings/default",
        // The defaults were just atomically written above. Reporting them as
        // non-persisted made first-run callers reject their own durable policy
        // and left the feed/settings surfaces permanently disabled until a
        // second request happened to arrive.
        source: "persisted",
        persistedSections: persistedSettingsSections(initializedRecord),
      },
    };
  });
  return result;
}

async function writePolicyCache(settings: Settings): Promise<PolicyCacheSnapshot> {
  const previous = await policyCacheDoc().get();
  const version = typeof previous.data()?.version === "number" ? previous.data()?.version as number : 0;
  const policyCache = makePolicyCache(settings, version + 1, expiresAtFrom(new Date()));
  await policyCacheDoc().set({
    ...policyCache,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return policyCache;
}

function policyCacheFromRecord(settings: Settings, record: Record<string, unknown>): PolicyCacheSnapshot {
  const version = typeof record.version === "number" ? record.version : 1;
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : expiresAtFrom(new Date());
  return makePolicyCache(settings, version, expiresAt);
}

function makePolicyCache(settings: Settings, version: number, expiresAt: string): PolicyCacheSnapshot {
  return {
    key: POLICY_CACHE_KEY,
    version,
    ttlSeconds: POLICY_CACHE_TTL_SECONDS,
    expiresAt,
    automation: clone(settings.automation),
    mailSafety: clone(settings.mailSafety),
    programAi: clone(settings.programAi),
    humanReviewPolicy: clone(settings.humanReviewPolicy),
    costGuide: clone(settings.guideLinks.costGuide),
    negotiationGuide: clone(settings.guideLinks.negotiationGuide),
    negotiationCriteria: clone(settings.negotiationCriteria),
    negotiationPricing: clone(settings.negotiationPricing),
    llmModelRoutes: clone(settings.llmModelRoutes),
    contractPolicy: {
      startRatio: settings.contract.startRatio,
      targetRatio: settings.contract.targetRatio,
      exclusivityDays: settings.contract.exclusivityDays,
      payTermDays: settings.contract.payTermDays,
    },
  };
}

function authorize(request: CallableRequest, allowedRoles: Set<Role>, action: string, cost: CostLog): { allowed: boolean; behaviorLog: BehaviorLog } {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  const allowed = Boolean(uid) && role !== "guest" && allowedRoles.has(role);
  return { allowed, behaviorLog: makeBehaviorLog(request, action, allowed ? "success" : "denied", cost) };
}

// 2026-09-27 codex adversarial review FAIL-5: two fields under `automation`/`manageRules`
// (dismissAgencyAndUnregisteredSenderMail, autoFollowupDays) are scp mailbox operational config,
// not general automation policy — getSettings must not return the caller's real configured value
// to a non-entitled reader, and updateSettings must not accept a change to them. super_admin
// bypasses without a Peoply lookup, same short-circuit as functions/mailAccounts.ts's
// isCallerScpEntitled itself uses.
async function callerScpEntitled(request: CallableRequest): Promise<boolean> {
  const role = request.auth?.token?.role ?? "guest";
  // 2026-09-27 codex adversarial review round 2 FAIL-5: a super_admin "대신 보기" (viewAs) a
  // non-granted person must see that person's real (denied) scp scope, never the super_admin's
  // own bypass — same AUTH-P0-003 contract getMyOrgContext already enforces. resolveViewAsTarget
  // (functions/mailAccountCallables.ts) re-verifies the target server-side against the members
  // collection/Auth (never trusts the client-supplied uid/email pair as-is) and itself throws for
  // a non-super_admin caller attempting it, so no separate role check is needed here first.
  const authCtx: AuthContext = {
    userId: request.auth?.uid ?? "",
    // AuthContext excludes "guest" — authorize() has already rejected a guest caller by the time
    // callerScpEntitled runs from getSettings/updateSettings, so this cast reflects a real
    // invariant, not a bypass; resolveViewAsTarget also independently requires role==="super_admin".
    role: (role === "guest" ? "viewer" : role) as Exclude<Role, "guest">,
    team: request.auth?.token?.team ?? "unassigned",
    ip: request.rawRequest?.ip ?? "0.0.0.0",
    gameId: request.auth?.token?.gameId ?? "global",
    email: request.auth?.token?.email,
  };
  const target = await resolveViewAsTarget(authCtx, isRecord(request.data) ? request.data : {});
  if (target) {
    // 2026-09-27 codex adversarial review round 3 FAIL-11: a target who is themselves a
    // super_admin (viewed by another super_admin, e.g. shadow-login QA) must get that target's
    // own super_admin bypass, not be treated as though they lack it — hardcoding false here masked
    // scp settings for a super_admin target with no separate explicit grant, contrary to their
    // real scope. resolveViewAsTarget re-verifies the target's role server-side (members
    // collection), so target.role is trustworthy, never client-supplied as-is.
    return isCallerScpEntitled(target.email, target.role === "super_admin", { userId: target.uid });
  }
  if (role === "super_admin") return true;
  return isCallerScpEntitled(request.auth?.token?.email ?? "", false, { userId: request.auth?.uid });
}

/** Down-projects the two scp-only fields to their code defaults for a non-entitled reader — an
 * allowlist of what to strip, not a blocklist: only the fields identified as scp-only change,
 * every other (general-purpose) field is returned as-is. */
export function stripScpAutomationFields(settings: Settings): Settings {
  return {
    ...settings,
    automation: {
      ...settings.automation,
      dismissAgencyAndUnregisteredSenderMail: SETTINGS.automation.dismissAgencyAndUnregisteredSenderMail,
    },
    manageRules: {
      ...settings.manageRules,
      autoFollowupDays: SETTINGS.manageRules.autoFollowupDays,
    },
  };
}

function makeBehaviorLog(request: CallableRequest, action: string, result: BehaviorResult, _cost: CostLog): BehaviorLog {
  return {
    userId: request.auth?.uid ?? "anonymous",
    role: request.auth?.token?.role ?? "guest",
    team: request.auth?.token?.team ?? "unassigned",
    gameId: request.auth?.token?.gameId ?? "global",
    action,
    time: new Date().toISOString(),
    IP: request.rawRequest?.ip ?? "0.0.0.0",
    result,
    cost: 0,
  };
}

function denied(behaviorLog: BehaviorLog, cache: CacheMeta, costLog: CostLog): CallableDenied {
  return {
    ok: false,
    error: { code: "permission-denied", message: "Guest is blocked and this role is not allowed for the settings callable." },
    cache,
    costLog,
    behaviorLog,
  };
}

function makeCache(key: string, status: CacheMeta["status"], expiresAt = expiresAtFrom(new Date())): CacheMeta {
  return { key, status: Date.now() > Date.parse(expiresAt) ? "miss" : status, ttlSeconds: POLICY_CACHE_TTL_SECONDS, expiresAt };
}

function makeCostLog(model: CostLog["model"], cacheChecked: boolean, reason: string): CostLog {
  return { provider: "mock", model, tokensIn: 0, tokensOut: 0, estimatedUsd: 0, cacheChecked, reason };
}

function expiresAtFrom(now: Date): string {
  return new Date(now.getTime() + POLICY_CACHE_TTL_SECONDS * 1000).toISOString();
}

function extractExpectedRevision(data: unknown): number {
  const value = isRecord(data) ? data.expectedRevision : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throwCodedError("invalid-argument", "expectedRevision is required");
  }
  return value;
}

function extractSettingsPatch(data: unknown): Partial<Settings> {
  const root = isRecord(data) && isRecord(data.patch) ? data.patch : null;
  if (!root) {
    throwCodedError("invalid-argument", "patch is required");
  }

  const patch = settingsSectionsFromRecord(root);
  const automationPatch = isRecord(root.automation) ? root.automation : null;
  if (automationPatch && Object.prototype.hasOwnProperty.call(automationPatch, "inboundAutoReplyAllowedMailAccountIds")) {
    validateInboundAutoReplyAllowlistPatch(automationPatch.inboundAutoReplyAllowedMailAccountIds);
  }
  if (Object.prototype.hasOwnProperty.call(root, "policy")) {
    throwCodedError("invalid-argument", "policy settings are server-controlled");
  }
  if (Object.keys(patch).length === 0) throwCodedError("invalid-argument", "patch has no writable settings sections");
  return patch;
}

export function settingsRevisionFromRecord(record: Record<string, unknown>): number {
  const revision = record.revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 1 ? revision : 1;
}

export function settingsActorUidHash(uid: string | undefined): string {
  return createHash("sha256").update(uid || "unknown").digest("hex");
}

export function makeSettingsAuditRecord(input: {
  settingsRevision: number;
  changedSections: string[];
  changedKeys: string[];
  actorUidHash: string;
  actorRole: Role;
  createdAtIso: string;
  source: string;
}): Record<string, unknown> {
  return {
    settingsRevision: input.settingsRevision,
    changedSections: [...input.changedSections].sort(),
    changedKeys: [...input.changedKeys].sort(),
    actorUidHash: input.actorUidHash,
    actorRole: input.actorRole,
    source: input.source,
    createdAtIso: input.createdAtIso,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function requiresHighRiskConfirmation(current: Settings, next: Settings, outboundPolicyPatch: Record<string, unknown>): boolean {
  const currentPolicy = current.mailSafety.outboundPolicy;
  const nextPolicy = next.mailSafety.outboundPolicy;
  const dailyCapTransition = Object.prototype.hasOwnProperty.call(outboundPolicyPatch, "dailyCap")
    && nextPolicy.dailyCap >= 500
    && nextPolicy.dailyCap !== currentPolicy.dailyCap;
  const highVolumeTransition = Object.prototype.hasOwnProperty.call(outboundPolicyPatch, "highVolumeEnabled")
    && nextPolicy.highVolumeEnabled === true
    && currentPolicy.highVolumeEnabled !== true;
  const reputationTransition = Object.prototype.hasOwnProperty.call(outboundPolicyPatch, "reputationStatus")
    && nextPolicy.reputationStatus === "healthy"
    && currentPolicy.reputationStatus !== "healthy";
  return dailyCapTransition || highVolumeTransition || reputationTransition;
}

function settingsChangedKeys(current: Settings, next: Settings, patch: Partial<Settings>): string[] {
  return collectChangedPaths(current, next, patch, "").sort();
}

function collectChangedPaths(before: unknown, after: unknown, patch: unknown, prefix: string): string[] {
  if (isRecord(patch) && isRecord(before) && isRecord(after)) {
    return Object.keys(patch).flatMap((key) => collectChangedPaths(
      before[key],
      after[key],
      patch[key],
      prefix ? `${prefix}.${key}` : key,
    ));
  }
  return valuesEqual(before, after) ? [] : [prefix];
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function throwCodedError(code: "invalid-argument" | "failed-precondition" | "aborted" | "permission-denied", message: string): never {
  const error = new Error(`${code}: ${message}`);
  Object.assign(error, { code });
  throw error;
}

function settingsSectionsFromRecord(record: Record<string, unknown>): Partial<Settings> {
  const allowedKeys = new Set<keyof Settings>(Object.keys(SETTINGS) as Array<keyof Settings>);
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (!allowedKeys.has(key as keyof Settings)) continue;
    if (!isRecord(value) && !Array.isArray(value)) continue;
    patch[key] = clone(value);
  }

  return patch as Partial<Settings>;
}

function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  const next = clone(current) as Record<keyof Settings, unknown>;
  for (const [key, value] of Object.entries(patch) as Array<[keyof Settings, unknown]>) {
    const existing = next[key];
    next[key] = mergeSettingValue(existing, value);
  }
  return normalizeSettings(next as Settings);
}

function normalizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    feed: {
      ...settings.feed,
      youtubeCreatorCountries: normalizeYoutubeCreatorCountryAllowlist(settings.feed.youtubeCreatorCountries),
      adSpendRates: normalizeAdSpendRates(settings.feed.adSpendRates),
    },
    llmModelRoutes: normalizeLlmModelRoutes(settings.llmModelRoutes),
    automation: {
      ...settings.automation,
      inboundAutoReplyAllowedMailAccountIds: normalizeInboundAutoReplyAllowedMailAccountIds(
        settings.automation.inboundAutoReplyAllowedMailAccountIds,
      ),
      keywordExpansionDisabledOrgIds: normalizeKeywordExpansionDisabledOrgIds(
        settings.automation.keywordExpansionDisabledOrgIds,
      ),
      // auto-reply-org-controls (2026-09-24): T049(AI Drama) 자동응답 차단 목록 — 같은
      // trim/dedupe/sort 원칙, 저장은 정상 배열(빈 배열 포함)만 허용한다. 기본값 자체는
      // _settings-mock.ts SETTINGS.automation.autoReplyDisabledOrgIds(["T049"])가 채운다 —
      // 여기서 빈 배열로 되돌리지 않는다(정상적인 운영자 편집 결과를 존중).
      autoReplyDisabledOrgIds: normalizeKeywordExpansionDisabledOrgIds(
        settings.automation.autoReplyDisabledOrgIds,
      ),
      autoReplyBusinessHoursKst: normalizeAutoReplyBusinessHoursKst(
        settings.automation.autoReplyBusinessHoursKst,
      ),
    },
  };
}

// AI-DRAMA-DISCOVERY-METAPROMPT W1: same trim/dedupe/sort doctrine as
// normalizeInboundAutoReplyAllowedMailAccountIds — orgIds are free-form Peoply org ids (e.g.
// "T049"), not mail account ids, so the allowed charset is looser (uppercase-friendly).
function normalizeKeywordExpansionDisabledOrgIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9_-]{1,40}$/.test(item)))]
    .sort();
}

// auto-reply-org-controls (2026-09-24): the KST business-hours window used to be operator-only
// (edited straight in Firestore, never through the settings callable) — now that /flu/settings
// exposes it to super_admin/admin/manager, a malformed write (e.g. startHour: 99) must not reach
// autoReplySendWindow.ts's send-time gate. Any invalid/missing field falls back to the current
// SETTINGS default for that field only (not the whole object), so a partial patch never resets
// the rest of the window.
function normalizeAutoReplyBusinessHoursKst(value: unknown): Settings["automation"]["autoReplyBusinessHoursKst"] {
  const fallback = SETTINGS.automation.autoReplyBusinessHoursKst;
  const record = isRecord(value) ? value : {};
  const isHour = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;
  const isMinute = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 59;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    weekdaysOnly: typeof record.weekdaysOnly === "boolean" ? record.weekdaysOnly : fallback.weekdaysOnly,
    startHour: isHour(record.startHour) ? record.startHour : fallback.startHour,
    startMinute: isMinute(record.startMinute) ? record.startMinute : fallback.startMinute,
    endHour: isHour(record.endHour) ? record.endHour : fallback.endHour,
    endMinute: isMinute(record.endMinute) ? record.endMinute : fallback.endMinute,
  };
}

function normalizeInboundAutoReplyAllowedMailAccountIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(item)))]
    .sort();
}

function validateInboundAutoReplyAllowlistPatch(value: unknown): void {
  if (!Array.isArray(value) || value.length > 20 || value.some((item) => (
    typeof item !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(item.trim().toLowerCase())
  ))) {
    throwCodedError("invalid-argument", "inbound auto-reply mailbox allowlist must contain at most 20 valid account IDs");
  }
}

async function assertInboundAutoReplyAllowlistAccounts(accountIds: string[]): Promise<void> {
  if (accountIds.length > 20) {
    throwCodedError("invalid-argument", "inbound auto-reply mailbox allowlist exceeds 20 accounts");
  }
  const activeIds = new Set((await readMailAccounts())
    .filter((account) => account.status === "active")
    .map((account) => account.accountId));
  if (accountIds.some((accountId) => !activeIds.has(accountId))) {
    throwCodedError("invalid-argument", "inbound auto-reply mailbox allowlist requires active registered accounts");
  }
}

function normalizeLlmModelRoutes(routes: Settings["llmModelRoutes"]): Settings["llmModelRoutes"] {
  const normalized = clone(SETTINGS.llmModelRoutes);
  const routeRecord = routes as Record<string, unknown>;

  for (const key of Object.keys(normalized) as Array<keyof Settings["llmModelRoutes"]>) {
    const merged = mergeSettingValue(normalized[key], routeRecord[key]) as Settings["llmModelRoutes"][typeof key];
    const currentModel = merged.mode === "quality" ? merged.premiumModel : merged.costModel;
    normalized[key] = {
      ...merged,
      currentModel: typeof currentModel === "string" && currentModel ? currentModel : merged.currentModel,
    };
  }

  return normalized;
}

function mergeSettingValue(existing: unknown, value: unknown): unknown {
  if (isRecord(existing) && isRecord(value)) {
    const merged: Record<string, unknown> = { ...clone(existing) };
    for (const [childKey, childValue] of Object.entries(value)) {
      merged[childKey] = mergeSettingValue(merged[childKey], childValue);
    }
    return merged;
  }
  return clone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
