/**
 * PLAN-ORG-MAIL-IDENTITY Slice 5 — a minimal per-user preference doc.
 *
 * The only consumer today is the dismissible "메일 연결(선택)" banner in the app shell: its
 * dismissed state must survive a refresh/new device, so it cannot live in localStorage, and
 * SEC-P0-004 forbids a client writing Firestore directly — this callable is the only writer.
 *
 * Deliberately tiny: a fixed allowlist of known keys, string values only, no arbitrary schema.
 * Same minimal Firestore seam pattern as functions/goldenSet.ts FirestoreDb (get/set only,
 * swappable in tests via setUserPreferencesDbForTests).
 */
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";

export const USER_PREFERENCES_COLLECTION = "user_preferences";

/** Add new keys here as they are needed — never accept an arbitrary key from the client.
 * Flu/Task-48: chatMailAccountView stores the Chat account-view toggle's last selection —
 * "personal" (the caller's own connected mailbox) or "org" (the org/scp account) — so it
 * survives a refresh/new device. The server never trusts this value as an account id or an
 * access grant; it is only ever a display-default hint re-validated against the caller's
 * current accessible set on every read (functions/mailAccountCallables.ts getMyOrgContext). */
export const ALLOWED_USER_PREFERENCE_KEYS = ["mailConnectNoticeDismissedAt", "chatMailAccountView"] as const;
export type UserPreferenceKey = typeof ALLOWED_USER_PREFERENCE_KEYS[number];

function isUserPreferenceKey(value: unknown): value is UserPreferenceKey {
  return typeof value === "string" && (ALLOWED_USER_PREFERENCE_KEYS as readonly string[]).includes(value);
}

/** Flu/Task-48 적대 리뷰 P2-7: chatMailAccountView is a display-default hint re-validated against
 * the caller's accessible set on every read (see the doc comment above), but the stored value
 * itself must still be one of the two view names — an arbitrary string here is never meaningful
 * and would just round-trip back out of getMyOrgContext's fallback. mailConnectNoticeDismissedAt
 * stays free-form (an ISO timestamp, defaulted below when the caller omits `value`). */
export const CHAT_MAIL_ACCOUNT_VIEW_VALUES = ["personal", "org"] as const;

function isValidUserPreferenceValue(key: UserPreferenceKey, value: string): boolean {
  if (key === "chatMailAccountView") {
    return (CHAT_MAIL_ACCOUNT_VIEW_VALUES as readonly string[]).includes(value);
  }
  return true;
}

type FirestoreSnapshot = {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
};

type FirestoreDocRef = {
  get(): Promise<FirestoreSnapshot>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
};

export type UserPreferencesFirestoreDb = {
  collection(name: string): { doc(id: string): FirestoreDocRef };
};

let dbOverrideForTests: UserPreferencesFirestoreDb | null = null;

/** Test-only seam (mirrors setMailAccountsDbForTests in functions/mailAccounts.ts). */
export function setUserPreferencesDbForTests(db: UserPreferencesFirestoreDb | null): void {
  dbOverrideForTests = db;
}

function resolveUserPreferencesDb(): UserPreferencesFirestoreDb {
  return dbOverrideForTests ?? (adminDb as unknown as UserPreferencesFirestoreDb);
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "user_preferences_invalid_argument",
  });
}

/** Returns "" when the doc, or the key on it, does not exist — never throws on a missing doc. */
export async function readUserPreference(uid: string, key: UserPreferenceKey): Promise<string> {
  if (!uid) return "";
  const db = resolveUserPreferencesDb();
  const snapshot = await db.collection(USER_PREFERENCES_COLLECTION).doc(uid).get();
  if (!snapshot.exists) return "";
  return asString(asRecord(snapshot.data())[key]);
}

export async function setUserPreference(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "user_preferences.set");
  const data = asRecord(request.data);
  const key = data.key;
  if (!isUserPreferenceKey(key)) {
    throw invalidArgument(`key must be one of: ${ALLOWED_USER_PREFERENCE_KEYS.join(", ")}`);
  }
  const value = asString(data.value, new Date().toISOString()).slice(0, 64);
  if (!isValidUserPreferenceValue(key, value)) {
    throw invalidArgument(`value for ${key} must be one of: ${CHAT_MAIL_ACCOUNT_VIEW_VALUES.join(", ")}`);
  }

  const db = resolveUserPreferencesDb();
  await db.collection(USER_PREFERENCES_COLLECTION).doc(auth.userId).set(
    { [key]: value, updatedAt: new Date().toISOString() },
    { merge: true },
  );

  return {
    ok: true,
    key,
    value,
    behaviorLog: makeBehaviorLog(auth, "user_preferences.set", "success", "global", 0),
  };
}
