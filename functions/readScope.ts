import { asString } from "./shared";
import type { AuthContext } from "./shared";

const MANAGER_ACCOUNT_SCOPED_KEYS = new Set([
  "creators",
  "channelStats",
  "agencies",
  "campaigns",
  "programs",
  "programApplications",
  "contracts",
  "reviews",
  "escalations",
  "submissions",
  "candidatePool",
  "recCandidates",
  "conversations",
  "creatorComments",
]);

const UID_FIELDS = [
  "createdBy",
  "createdByUid",
  "accountOwnerUid",
  "ownerUid",
  "ownerUserId",
  "managerUid",
  "managerUserId",
  "assigneeUid",
  "assignedToUid",
  "memberUid",
  "userId",
  "programOwnerUid",
  "campaignOwnerUid",
  "creatorOwnerUid",
  "linkedBy",
  "reviewedBy",
];

const OWNER_UID_FIELDS = [
  "accountOwnerUid",
  "ownerUid",
  "ownerUserId",
  "managerUid",
  "managerUserId",
  "programOwnerUid",
  "campaignOwnerUid",
  "creatorOwnerUid",
];

const UID_ARRAY_FIELDS = [
  "accountOwnerUids",
  "ownerUids",
  "managerUids",
  "assigneeUids",
  "assignedToUids",
  "memberUids",
  "programOwnerUids",
  "campaignOwnerUids",
  "authorizedUids",
];

const OWNER_UID_ARRAY_FIELDS = [
  "accountOwnerUids",
  "ownerUids",
  "managerUids",
  "programOwnerUids",
  "campaignOwnerUids",
];

const EMAIL_FIELDS = [
  "createdByEmail",
  "ownerEmail",
  "managerEmail",
  "assigneeEmail",
  "programOwnerEmail",
  "campaignOwnerEmail",
];

const OWNER_EMAIL_FIELDS = [
  "ownerEmail",
  "managerEmail",
  "programOwnerEmail",
  "campaignOwnerEmail",
];

const NAME_FIELDS = [
  "owner",
  "ownerName",
  "manager",
  "managerName",
  "assignee",
  "assignedTo",
  "reviewer",
  "createdByName",
  "programOwnerName",
  "campaignOwnerName",
];

const OWNER_NAME_FIELDS = [
  "owner",
  "ownerName",
  "manager",
  "managerName",
  "programOwnerName",
  "campaignOwnerName",
];

const OWNER_AUTHORITATIVE_KEYS = new Set([
  "agencies",
  "campaigns",
  "contracts",
  "conversations",
  "creators",
  "escalations",
  "programs",
  "programApplications",
  "reviews",
  "submissions",
]);

// SCP pipeline collections are organization-shared (no per-owner ownership model) —
// Wave3 shared contract: program_sheet_leads / qualification_decisions /
// creator_links / submission_tasks / submissions / review_ledger / scp_mail_results.
// manager+ must see all rows in these collections regardless of owner fields
// (SCP documents never get a fake owner stamped on them). Both the snake_case
// Firestore collection names and the camelCase DatasetKey aliases wired through
// functions/read.ts getDataset() are listed since callers pass either form.
// This does NOT extend to "reviews" (plain) or "programs"/"campaigns"/"creators"/
// etc — those remain the live-product owner-scoped keys, unchanged by this set.
const SCP_ORG_WIDE_KEYS = new Set([
  "program_sheet_leads",
  "programSheetLeads",
  "qualification_decisions",
  "creator_links",
  "creatorLinks",
  "submission_tasks",
  "submissionTasks",
  "submissions",
  "review_ledger",
  "scp_mail_results",
  "scpMailResults",
  "scp_lifecycle_profiles",
  "scpLifecycleProfiles",
  "scp_identity_aliases",
  "scpIdentityAliases",
  "gem_grants",
  "gemGrants",
]);

function normalized(value: unknown): string {
  return asString(value).toLowerCase();
}

function hasAnyScalar(row: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => normalized(row[field]).length > 0);
}

function hasMatchingScalar(row: Record<string, unknown>, fields: readonly string[], values: ReadonlySet<string>): boolean {
  for (const field of fields) {
    const value = normalized(row[field]);
    if (value && values.has(value)) return true;
  }
  return false;
}

function hasMatchingUid(row: Record<string, unknown>, fields: readonly string[], uid: string): boolean {
  for (const field of fields) {
    if (asString(row[field]) === uid) return true;
  }
  return false;
}

function hasAnyArray(row: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => Array.isArray(row[field]) && (row[field] as unknown[]).some((item) => asString(item).length > 0));
}

function hasMatchingArray(row: Record<string, unknown>, fields: readonly string[], value: string): boolean {
  for (const field of fields) {
    const raw = row[field];
    if (!Array.isArray(raw)) continue;
    if (raw.some((item) => asString(item) === value)) return true;
  }
  return false;
}

function hasAuthoritativeOwner(row: Record<string, unknown>): boolean {
  return hasAnyScalar(row, OWNER_UID_FIELDS) ||
    hasAnyArray(row, OWNER_UID_ARRAY_FIELDS) ||
    hasAnyScalar(row, OWNER_EMAIL_FIELDS) ||
    hasAnyScalar(row, OWNER_NAME_FIELDS);
}

export function shouldApplyManagerAccountScope(key: string, auth: AuthContext): boolean {
  if (SCP_ORG_WIDE_KEYS.has(key)) return false;
  return auth.role === "manager" && MANAGER_ACCOUNT_SCOPED_KEYS.has(key);
}

export function rowMatchesAccountScope(key: string, row: Record<string, unknown>, auth?: AuthContext): boolean {
  if (!auth || !shouldApplyManagerAccountScope(key, auth)) return true;

  const uid = asString(auth.userId);
  if (!uid) return false;

  const email = normalized(auth.email);
  const names = [auth.name, auth.email]
    .map(normalized)
    .filter((value) => value.length > 0);

  if (OWNER_AUTHORITATIVE_KEYS.has(key) && hasAuthoritativeOwner(row)) {
    if (hasMatchingUid(row, OWNER_UID_FIELDS, uid)) return true;
    if (hasMatchingArray(row, OWNER_UID_ARRAY_FIELDS, uid)) return true;
    if (email && hasMatchingScalar(row, OWNER_EMAIL_FIELDS, new Set([email]))) return true;
    if (names.length > 0 && hasMatchingScalar(row, OWNER_NAME_FIELDS, new Set(names))) return true;
    return false;
  }

  if (hasMatchingUid(row, UID_FIELDS, uid)) return true;
  if (hasMatchingArray(row, UID_ARRAY_FIELDS, uid)) return true;

  if (email && hasMatchingScalar(row, EMAIL_FIELDS, new Set([email]))) return true;

  if (names.length > 0 && hasMatchingScalar(row, NAME_FIELDS, new Set(names))) return true;

  return false;
}

export function scopedOwnerFields(auth: AuthContext, ownerName = "") {
  const cleanOwnerName = asString(ownerName);
  return {
    createdBy: auth.userId,
    createdByRole: auth.role,
    ownerUid: auth.userId,
    ...(auth.email ? { createdByEmail: auth.email, ownerEmail: auth.email } : {}),
    ...(cleanOwnerName || auth.name ? { ownerName: cleanOwnerName || auth.name } : {}),
  };
}
