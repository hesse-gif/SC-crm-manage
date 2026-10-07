import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import { error as logError } from "firebase-functions/logger";
import { db, REGION, PROJECT, assertTargetProject, requireMember, inputId, ownedDocument, callableOptions } from "./common";
import { buildGoogleOAuthUrl, randomOAuthState, oauthStateDocId, connectionIdFor, exchangeOAuthCode, refreshAccessToken, getGmailProfile, watchGmailMailbox, watchExpirationIso, gmailFetch, GmailApiError, projectGmailMessage, collectHistoryMessageIds, encodeSimpleRawEmail, sendGmailRawMessage, headerValue, threadDocId, type GmailMessage, type GmailHistoryPage, type GoogleOAuthClientConfig } from "./gmail-core";

export const googleSecret = defineSecret("MIXMAX_GOOGLE_CLIENT_SECRET");
export const googleClientId = defineString("MIXMAX_GOOGLE_CLIENT_ID", { default: "" });
export const oauthReady = defineString("MIXMAX_GOOGLE_OAUTH_READY", { default: "false" });
const deps = { fetch: (url: string, init?: Parameters<typeof fetch>[1]) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) }) };
const now = () => new Date().toISOString();
function config(): GoogleOAuthClientConfig {
  if (!googleClientId.value() || !googleSecret.value()) throw new HttpsError("failed-precondition", "Google 메일 연결 설정이 필요합니다.");
  return { clientId: googleClientId.value(), clientSecret: googleSecret.value() };
}
async function tokenFor(id: string) {
  const secret = (await db.doc(`mixmax_credentials/${id}`).get()).data();
  if (!secret?.refreshToken) throw new HttpsError("failed-precondition", "메일 계정을 다시 연결해 주세요.");
  return refreshAccessToken(deps, config(), secret.refreshToken);
}
export async function queueSync(id: string) {
  await db.doc(`mixmax_sync_jobs/${id}`).set({ requestedAt: now(), nonce: randomUUID() });
}
export const mixmaxBeginGoogleOAuth = onCall({ ...callableOptions, secrets: [googleSecret] }, async request => {
  const member = await requireMember(request);
  if (oauthReady.value() !== "true") throw new HttpsError("failed-precondition", "Google Cloud에서 Mixmax 메일 OAuth 콜백 설정을 완료해야 합니다. Google 로그인은 사용할 수 있습니다.");
  const state = randomOAuthState();
  await db.doc(`mixmax_oauth_states/${oauthStateDocId(state)}`).create({ ownerUid: member.uid, workspaceId: member.workspaceId, expiresAt: Date.now() + 600000 });
  return { url: buildGoogleOAuthUrl(config(), state) };
});

export const mixmaxGoogleCallback = onRequest({ region: REGION, secrets: [googleSecret], maxInstances: 3, timeoutSeconds: 120 }, async (request, response) => {
  assertTargetProject();
  response.set("Cache-Control", "no-store");
  const state = typeof request.query.state === "string" ? request.query.state : "";
  if (state.length < 32 || state.length > 128) { response.status(400).send("Invalid OAuth state."); return; }
  let phase = "state";
  try {
    const ref = db.doc(`mixmax_oauth_states/${oauthStateDocId(state)}`);
    const binding = await db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      if (!data || data.expiresAt < Date.now()) throw new Error("Expired OAuth state");
      tx.delete(ref);
      return data;
    });
    if (request.query.error) { response.redirect(303, "/mail?connection=cancelled"); return; }
    if (typeof request.query.code !== "string" || request.query.code.length > 4096) throw new Error("Missing OAuth code");
    phase = "membership";
    const member = (await db.doc(`mixmax_members/${binding.ownerUid}`).get()).data();
    if (!member || member.disabled || member.workspaceId !== binding.workspaceId) throw new Error("Membership changed");
    phase = "token_exchange";
    const tokens = await exchangeOAuthCode(deps, config(), request.query.code);
    phase = "scopes";
    const scopes = new Set((tokens.scope ?? "").split(" "));
    if (!scopes.has("https://www.googleapis.com/auth/gmail.readonly") || !scopes.has("https://www.googleapis.com/auth/gmail.send")) throw new Error("Required scopes declined");
    phase = "profile";
    const profile = await getGmailProfile(deps, tokens.access_token);
    const id = connectionIdFor(binding.workspaceId, binding.ownerUid, profile.emailAddress);
    phase = "mailbox_binding";
    const existing = await db.collection("mixmax_connections").where("email", "==", profile.emailAddress).get();
    if (existing.docs.some(doc => doc.id !== id && doc.data().status !== "disconnected")) throw new Error("Mailbox already connected");
    const credentialRef = db.doc(`mixmax_credentials/${id}`);
    const prior = (await credentialRef.get()).data();
    const refreshToken = tokens.refresh_token || prior?.refreshToken;
    if (!refreshToken) throw new Error("Offline consent required");
    phase = "gmail_watch";
    const watch = await watchGmailMailbox(deps, tokens.access_token);
    // No durable credential is created until watch succeeds. The explicit sync below
    // covers the initial push even if it arrives before this atomic mapping commit.
    const batch = db.batch();
    batch.set(credentialRef, { refreshToken, ownerUid: binding.ownerUid, workspaceId: binding.workspaceId, updatedAt: now() });
    batch.set(db.doc(`mixmax_connections/${id}`), { ownerUid: binding.ownerUid, workspaceId: binding.workspaceId, email: profile.emailAddress, status: "connected", watchExpiration: watchExpirationIso(watch.expiration), updatedAt: now() }, { merge: true });
    phase = "persist_connection";
    await batch.commit();
    phase = "queue_sync";
    await queueSync(id);
    response.redirect(303, "/mail?connection=connected");
  } catch (error) {
    // Retain only the failing phase/status, never OAuth query strings, raw errors,
    // access tokens or provider bodies. Consuming state early prevents replay.
    logError("Mixmax Google OAuth callback failed", { phase, ...(error instanceof GmailApiError ? { providerStatus: error.status } : {}) });
    response.redirect(303, "/mail?connection=failed");
  }
});

export const mixmaxSyncMailbox = onCall(callableOptions, async request => {
  const member = await requireMember(request);
  const id = inputId(request.data.connectionId);
  const { data } = await ownedDocument("mixmax_connections", id, member);
  if (data.ownerUid !== member.uid || data.status !== "connected") throw new HttpsError("permission-denied", "연결된 본인 계정만 갱신할 수 있습니다.");
  await queueSync(id);
  return { queued: true };
});
export const mixmaxDisconnectGoogle = onCall({ ...callableOptions, secrets: [googleSecret] }, async request => {
  const member = await requireMember(request);
  const id = inputId(request.data.connectionId);
  const { ref, data } = await ownedDocument("mixmax_connections", id, member);
  if (data.ownerUid !== member.uid) throw new HttpsError("permission-denied", "본인 계정만 해제할 수 있습니다.");
  // Stop target-only watch before deleting target-owned credentials. No Google grant revocation.
  try { await gmailFetch(deps, await tokenFor(id), "/users/me/stop", { method: "POST" }); }
  catch (error) { if (!(error instanceof GmailApiError) || ![400, 401, 403].includes(error.status)) throw new HttpsError("unavailable", "Google 연결 해제에 실패했습니다. 다시 시도해 주세요."); }
  await db.doc(`mixmax_credentials/${id}`).delete();
  await ref.update({ status: "disconnected", updatedAt: now() });
  return { ok: true };
});

export const mixmaxGmailPush = onMessagePublished({ topic: "mixmax-gmail", region: REGION, retry: true, maxInstances: 5 }, async event => {
  assertTargetProject();
  let payload: { emailAddress?: string; historyId?: string };
  try { payload = event.data.message.json; } catch { return; }
  if (!payload?.emailAddress || !/^\d+$/.test(payload.historyId ?? "")) return;
  const connections = await db.collection("mixmax_connections").where("email", "==", payload.emailAddress.toLowerCase()).get();
  for (const row of connections.docs) if (["connected", "connecting"].includes(row.data().status)) await queueSync(row.id);
});

async function persistThread(accessToken: string, connection: { id: string; workspaceId: string; ownerUid: string; email: string }, gmailThreadId: string) {
  let thread: { messages?: GmailMessage[] };
  try { thread = await gmailFetch(deps, accessToken, `/users/me/threads/${encodeURIComponent(gmailThreadId)}`, { query: { format: "full" } }); }
  catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    await db.doc(`mixmax_threads/${threadDocId(connection.id, gmailThreadId)}`).set({ workspaceId: connection.workspaceId, sourceDeleted: true, archived: true }, { merge: true });
    return;
  }
  const projections = (thread.messages ?? []).map(message => projectGmailMessage(connection, message)).sort((a, b) => a.message.sentAt.localeCompare(b.message.sentAt));
  if (!projections.length) return;
  const latest = projections[projections.length - 1];
  const present = new Set(projections.map(p => p.message.id));
  const stored = await db.collection("mixmax_messages").where("threadId", "==", latest.thread.id).get();
  const removed = stored.docs.filter(doc => !present.has(doc.id));
  for (let offset = 0; offset < removed.length; offset += 200) {
    const batch = db.batch();
    for (const doc of removed.slice(offset, offset + 200)) batch.delete(doc.ref);
    await batch.commit();
  }
  for (let offset = 0; offset < projections.length; offset += 200) {
    const batch = db.batch();
    for (const projection of projections.slice(offset, offset + 200)) batch.set(db.doc(`mixmax_messages/${projection.message.id}`), { ...projection.message, text: projection.message.text.slice(0, 180000), html: "" }, { merge: true });
    await batch.commit();
  }
  await db.doc(`mixmax_threads/${latest.thread.id}`).set({ ...latest.thread, mailbox: connection.email, unread: projections.some(p => p.thread.unread), sourceDeleted: false, updatedAt: now() }, { merge: true });
}

export async function syncMailbox(id: string) {
  assertTargetProject();
  const leaseRef = db.doc(`mixmax_sync_leases/${id}`);
  const leaseId = randomUUID();
  await db.runTransaction(async tx => {
    const lease = (await tx.get(leaseRef)).data();
    if (lease?.expiresAt > Date.now()) throw new Error("Mailbox sync is busy; retry this event");
    tx.set(leaseRef, { leaseId, expiresAt: Date.now() + 600000 });
  });
  let continuation = false;
  const connectionRef = db.doc(`mixmax_connections/${id}`);
  try {
    const data = (await connectionRef.get()).data();
    if (!data || data.status !== "connected") return;
    const connection = { id, workspaceId: String(data.workspaceId), ownerUid: String(data.ownerUid), email: String(data.email) };
    const token = await tokenFor(id);
    await connectionRef.update({ syncStatus: "syncing", syncError: "" });
    let full = !data.historyId || Boolean(data.fullSync);
    let pageToken = data.deltaPageToken || undefined;
    let nextHistoryId: string | undefined;
    let messageIds: string[] = [];
    const threads = new Set<string>();
    if (!full) {
      try {
        const page = await gmailFetch<GmailHistoryPage>(deps, token, "/users/me/history", { query: { startHistoryId: data.historyId, pageToken, maxResults: 100 } });
        messageIds = collectHistoryMessageIds(page);
        for (const row of page.history ?? []) for (const item of row.messagesDeleted ?? []) if (item.message?.threadId) threads.add(item.message.threadId);
        pageToken = page.nextPageToken;
        nextHistoryId = page.historyId;
      } catch (error) {
        if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
        full = true;
      }
    }
    let fullStart = data.fullStartHistoryId;
    if (full) {
      if (!data.fullSync) {
        fullStart = (await getGmailProfile(deps, token)).historyId;
        await connectionRef.update({ fullSync: true, fullStartHistoryId: fullStart, fullPageToken: "" });
      }
      const page = await gmailFetch<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(deps, token, "/users/me/messages", { query: { maxResults: 100, pageToken: data.fullSync ? data.fullPageToken || undefined : undefined } });
      for (const message of page.messages ?? []) threads.add(message.threadId);
      pageToken = page.nextPageToken;
    } else {
      for (const messageId of messageIds) {
        try {
          const message = await gmailFetch<GmailMessage>(deps, token, `/users/me/messages/${encodeURIComponent(messageId)}`, { query: { format: "minimal" } });
          if (message.threadId) threads.add(message.threadId);
        } catch (error) { if (!(error instanceof GmailApiError) || error.status !== 404) throw error; }
      }
    }
    for (const threadId of threads) await persistThread(token, connection, threadId);
    // Cursor only commits after all projections from this page are durable.
    if (full) {
      await connectionRef.update(pageToken ? { fullPageToken: pageToken } : { fullSync: false, fullPageToken: "", historyId: fullStart, deltaPageToken: "" });
      continuation = true; // Finish the full snapshot with a delta from its starting cursor.
    } else {
      await connectionRef.update(pageToken ? { deltaPageToken: pageToken } : { deltaPageToken: "", ...(nextHistoryId ? { historyId: nextHistoryId } : {}) });
      continuation = Boolean(pageToken);
    }
    await connectionRef.update({ syncStatus: continuation ? "syncing" : "ready", lastSyncAt: now(), syncError: "" });
  } catch (error) {
    await connectionRef.set({ syncStatus: "error", syncError: "메일 동기화가 지연되었습니다. 자동 재시도하거나 다시 연결해 주세요." }, { merge: true });
    if (error instanceof GmailApiError && [400, 401, 403].includes(error.status)) {
      await connectionRef.update({ status: "reconnect_required" });
      return;
    }
    throw new Error(error instanceof GmailApiError ? `Gmail sync failed (${error.status})` : "Mailbox sync failed");
  } finally {
    await db.runTransaction(async tx => { if ((await tx.get(leaseRef)).data()?.leaseId === leaseId) tx.delete(leaseRef); });
  }
  if (continuation) await queueSync(id);
}

export const mixmaxSyncJob = onDocumentWritten({ document: "mixmax_sync_jobs/{connectionId}", database: "mixmax", region: REGION, retry: true, secrets: [googleSecret], timeoutSeconds: 540, maxInstances: 5 }, async event => {
  if (!event.data?.after.exists) return;
  await syncMailbox(event.params.connectionId);
});

export const mixmaxRenewGmailWatches = onSchedule({ schedule: "every 24 hours", region: REGION, secrets: [googleSecret], timeoutSeconds: 540, maxInstances: 1 }, async () => {
  assertTargetProject();
  const rows = await db.collection("mixmax_connections").where("status", "==", "connected").get();
  const failures: string[] = [];
  for (const row of rows.docs) {
    try {
      const watch = await watchGmailMailbox(deps, await tokenFor(row.id));
      await row.ref.update({ watchExpiration: watchExpirationIso(watch.expiration) });
      await queueSync(row.id); // Also recovers a missed push from the existing history cursor.
    } catch { failures.push(row.id); }
  }
  if (failures.length) throw new Error(`${failures.length} mailbox watches could not be renewed`);
});

export class GmailSendAttemptError extends Error {
  constructor(readonly uncertain: boolean) { super(uncertain ? "Gmail send outcome is unknown" : "Gmail send was not accepted"); }
}
export async function sendForConnection(id: string, input: Parameters<typeof encodeSimpleRawEmail>[0], gmailThreadId?: string) {
  assertTargetProject();
  let token: string;
  let raw: string;
  try {
    token = await tokenFor(id);
    if (gmailThreadId) {
      const thread = await gmailFetch<{ messages?: GmailMessage[] }>(deps, token, `/users/me/threads/${encodeURIComponent(gmailThreadId)}`, { query: { format: "metadata" } });
      const last = thread.messages?.at(-1);
      const ref = headerValue(last?.payload?.headers, "message-id");
      if (ref && !/[\r\n]/.test(ref)) { input.inReplyTo = ref; input.references = ref; }
    }
    raw = encodeSimpleRawEmail(input);
  } catch { throw new GmailSendAttemptError(false); }
  let sent;
  try { sent = await sendGmailRawMessage(deps, token, raw, gmailThreadId); }
  catch (error) {
    void queueSync(id).catch(() => undefined);
    const rejected = error instanceof GmailApiError && error.status >= 400 && error.status < 500;
    throw new GmailSendAttemptError(!rejected);
  }
  // A sync enqueue failure must not turn a known successful send into an unknown send.
  await queueSync(id).catch(() => undefined);
  return sent;
}
