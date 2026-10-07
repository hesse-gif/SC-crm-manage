/**
 * Flu/Task-47 — [Chat 스코프] does a personal-mailbox counterparty belong to a registered
 * candidate (candidate_pool)? Header-address-only match (SEC-P0-009 — never inspects message
 * body): the caller passes the parsed From address, nothing else.
 *
 * candidate_pool docs already store `email` lowercased (functions/discovery.ts's
 * cleanEmailCandidate) — a single normalized-equality query is enough and needs no composite
 * index (Firestore auto-indexes every field for single-field equality). Doc ids are candidate
 * ids (functions/candidateScope.ts), reused here so the produced candidateRef matches the same
 * `candidate_pool/{candidateId}` shape every other reader of that collection expects.
 */
import { adminDb } from "./firebaseAdmin";
import { candidateIdFromCandidate, candidatePoolRefForCandidate } from "./candidateScope";
import { normalizeEmailAddress } from "./mailSafetyShared";

export const CANDIDATE_POOL_COLLECTION = "candidate_pool";

export type RegisteredCandidateMatch = {
  readonly candidateId: string;
  readonly candidateRef: string;
};

// ---------- minimal Firestore seam (mirrors functions/mailAccounts.ts's test seam) ----------

type FirestoreDocSnapshot = {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
};

type FirestoreQuerySnapshot = {
  readonly docs: readonly FirestoreDocSnapshot[];
};

type FirestoreQuery = {
  orderBy(field: string): FirestoreQuery;
  limit(count: number): FirestoreQuery;
  get(): Promise<FirestoreQuerySnapshot>;
};

type FirestoreCollectionRef = {
  where(field: string, op: "==", value: unknown): FirestoreQuery;
};

export type CandidateRegistrationFirestoreDb = {
  collection(name: string): FirestoreCollectionRef;
};

let dbOverrideForTests: CandidateRegistrationFirestoreDb | null = null;

/** Test-only seam (mirrors setMailAccountsDbForTests in functions/mailAccounts.ts). */
export function setCandidateRegistrationDbForTests(db: CandidateRegistrationFirestoreDb | null): void {
  dbOverrideForTests = db;
}

function resolveCandidateRegistrationDb(explicit?: CandidateRegistrationFirestoreDb): CandidateRegistrationFirestoreDb {
  return explicit ?? dbOverrideForTests ?? (adminDb as unknown as CandidateRegistrationFirestoreDb);
}

export type FindRegisteredCandidateByEmailDeps = {
  readonly db?: CandidateRegistrationFirestoreDb;
};

/**
 * Returns the matching candidate's identity when `email` (a raw or already-normalized address —
 * pass the parsed From header, never a body snippet) equals a candidate_pool document's `email`
 * field. Returns null on no match, an empty/invalid address, or a missing/invalid doc id.
 *
 * P1-4 (2026-09-11 adversarial review): when more than one candidate_pool doc shares the same
 * `email`, `orderBy("__name__")` makes the pick deterministic (lowest doc id) instead of
 * whatever order an un-ordered equality query happens to return. candidate_pool has no `orgId`
 * field today, so this intentionally does not scope by org — flagged for the ticket owner to
 * confirm whether that scoping is needed.
 */
export async function findRegisteredCandidateByEmail(
  email: string,
  deps: FindRegisteredCandidateByEmailDeps = {},
): Promise<RegisteredCandidateMatch | null> {
  const normalized = normalizeEmailAddress(email);
  if (!normalized || !normalized.includes("@")) return null;
  const db = resolveCandidateRegistrationDb(deps.db);
  const snapshot = await db
    .collection(CANDIDATE_POOL_COLLECTION)
    .where("email", "==", normalized)
    .orderBy("__name__")
    .limit(1)
    .get();
  const doc = snapshot.docs[0];
  if (!doc || !doc.exists) return null;
  const candidateId = candidateIdFromCandidate({ id: doc.id });
  if (!candidateId) return null;
  return { candidateId, candidateRef: candidatePoolRefForCandidate({ id: doc.id }) };
}
