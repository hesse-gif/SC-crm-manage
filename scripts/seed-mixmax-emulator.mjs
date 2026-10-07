import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromFunctions = createRequire(join(here, "..", "functions", "package.json"));
const admin = requireFromFunctions("firebase-admin");
const { getFirestore } = requireFromFunctions("firebase-admin/firestore");

export const MIXMAX_PROJECT_ID = "demo-mixmax";
export const MIXMAX_DATABASE_ID = "mixmax";
export const OWNER_UID = "mixmax-e2e-owner";
export const OUTSIDER_UID = "mixmax-e2e-outsider";
export const OWNER_EMAIL = "owner@mixmax.test";
export const OUTSIDER_EMAIL = "outsider@mixmax.test";
export const PASSWORD = "test1234";
export const OWNER_WORKSPACE_ID = "primary";
export const OUTSIDER_WORKSPACE_ID = "outsider-workspace";
export const THREAD_ID = "thread-imported-flu";
export const MESSAGE_ID = "message-imported-flu-1";
export const LIVE_MESSAGE_ID = "message-live-admin";
export const CONNECTION_ID = "conn-owner-google";
export const TEMPLATE_ID = "template-seed-followup";
export const CASE_ID = "case-seed-negotiation";
export const CONTACT_ID = "contact-seed-creator";
export const SECRET_ID = "secret-owner-google";

const now = "2026-10-07T00:00:00.000Z";

function assertEnv() {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required.");
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("FIRESTORE_EMULATOR_HOST is required.");
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || MIXMAX_PROJECT_ID;
  if (project !== MIXMAX_PROJECT_ID) throw new Error(`Mixmax seed is pinned to ${MIXMAX_PROJECT_ID}; got ${project}.`);
}

async function resetEndpoint(host, path, label) {
  const response = await fetch(`http://${host}${path}`, { method: "DELETE" });
  await response.arrayBuffer();
  if (!response.ok && response.status !== 404) throw new Error(`${label} reset failed: ${response.status}`);
}

async function resetEmulators() {
  await resetEndpoint(
    process.env.FIRESTORE_EMULATOR_HOST,
    `/emulator/v1/projects/${MIXMAX_PROJECT_ID}/databases/${MIXMAX_DATABASE_ID}/documents`,
    "Mixmax Firestore",
  );
  await resetEndpoint(
    process.env.FIREBASE_AUTH_EMULATOR_HOST,
    `/emulator/v1/projects/${MIXMAX_PROJECT_ID}/accounts`,
    "Mixmax Auth",
  );
}

async function upsertUser(auth, user) {
  try {
    await auth.getUser(user.uid);
    await auth.updateUser(user.uid, {
      email: user.email,
      password: PASSWORD,
      emailVerified: true,
      disabled: false,
      displayName: user.displayName,
    });
  } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
    await auth.createUser({
      uid: user.uid,
      email: user.email,
      password: PASSWORD,
      emailVerified: true,
      displayName: user.displayName,
    });
  }
  await auth.setCustomUserClaims(user.uid, { email_verified: true });
}

async function seedAuth(auth) {
  await upsertUser(auth, { uid: OWNER_UID, email: OWNER_EMAIL, displayName: "Mixmax Owner QA" });
  await upsertUser(auth, { uid: OUTSIDER_UID, email: OUTSIDER_EMAIL, displayName: "Mixmax Outsider QA" });
}

async function seedFirestore(db) {
  const batch = db.batch();
  const set = (path, data) => batch.set(db.doc(path), data);

  set(`mixmax_members/${OWNER_UID}`, {
    uid: OWNER_UID,
    email: OWNER_EMAIL,
    workspaceId: OWNER_WORKSPACE_ID,
    role: "owner",
    createdAt: now,
  });
  set(`mixmax_members/${OUTSIDER_UID}`, {
    uid: OUTSIDER_UID,
    email: OUTSIDER_EMAIL,
    workspaceId: OUTSIDER_WORKSPACE_ID,
    role: "owner",
    createdAt: now,
  });
  set(`mixmax_connections/${CONNECTION_ID}`, {
    workspaceId: OWNER_WORKSPACE_ID,
    ownerUid: OWNER_UID,
    email: OWNER_EMAIL,
    status: "connected",
    syncStatus: "ready",
    lastSyncAt: now,
    updatedAt: now,
  });
  set(`mixmax_credentials/${SECRET_ID}`, {
    workspaceId: OWNER_WORKSPACE_ID,
    ownerUid: OWNER_UID,
    connectionId: CONNECTION_ID,
    refreshToken: "do-not-expose-refresh-token",
    updatedAt: now,
  });
  set(`mixmax_threads/${THREAD_ID}`, {
    workspaceId: OWNER_WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    ownerUid: OWNER_UID,
    source: "flu",
    sourceSystem: "flu",
    mailbox: OWNER_EMAIL,
    subject: "Flu imported creator deal",
    snippet: "Imported fixture from Flu now belongs to Mixmax.",
    participantEmails: [OWNER_EMAIL, "creator@example.com"],
    lastMessageAt: "2026-10-07T00:01:00.000Z",
    unread: true,
    starred: false,
    archived: false,
    updatedAt: now,
  });
  set(`mixmax_messages/${MESSAGE_ID}`, {
    workspaceId: OWNER_WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    threadId: THREAD_ID,
    source: "flu",
    from: "creator@example.com",
    to: [OWNER_EMAIL],
    subject: "Flu imported creator deal",
    text: "Imported fixture from Flu now belongs to Mixmax.",
    html: "",
    sentAt: "2026-10-07T00:01:00.000Z",
    direction: "inbound",
    gmailMessageId: "",
  });
  set(`mixmax_contacts/${CONTACT_ID}`, {
    workspaceId: OWNER_WORKSPACE_ID,
    name: "Imported Creator",
    email: "creator@example.com",
    notes: "Seeded contact for independent Mixmax QA.",
    updatedAt: now,
    createdAt: now,
  });
  set(`mixmax_templates/${TEMPLATE_ID}`, {
    workspaceId: OWNER_WORKSPACE_ID,
    name: "Seed follow-up",
    subject: "Re: Collaboration",
    body: "Thanks for the details. Here is the next step.",
    updatedAt: now,
    createdAt: now,
  });
  set(`mixmax_cases/${CASE_ID}`, {
    workspaceId: OWNER_WORKSPACE_ID,
    name: "Negotiation guardrails",
    description: "Keep promises reviewable before sending.",
    body: "Do not invent prices, approvals, or deadlines.",
    updatedAt: now,
    createdAt: now,
  });
  set("mixmax_threads/thread-outsider", {
    workspaceId: OUTSIDER_WORKSPACE_ID,
    source: "gmail",
    subject: "Outsider private thread",
    snippet: "This must not leak to the owner workspace.",
    participantEmails: [OUTSIDER_EMAIL],
    lastMessageAt: "2026-10-07T00:02:00.000Z",
    unread: true,
    updatedAt: now,
  });

  await batch.commit();
}

export async function seedMixmaxEmulator() {
  assertEnv();
  if (!admin.apps.length) admin.initializeApp({ projectId: MIXMAX_PROJECT_ID });
  await resetEmulators();
  await seedAuth(admin.auth());
  await seedFirestore(getFirestore(admin.app(), MIXMAX_DATABASE_ID));
  return {
    projectId: MIXMAX_PROJECT_ID,
    databaseId: MIXMAX_DATABASE_ID,
    owner: { uid: OWNER_UID, email: OWNER_EMAIL },
    outsider: { uid: OUTSIDER_UID, email: OUTSIDER_EMAIL },
    threadId: THREAD_ID,
    connectionId: CONNECTION_ID,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedMixmaxEmulator()
    .then((result) => {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
