import { expect, test, type Page } from "@playwright/test";
import {
  CASE_ID,
  CONNECTION_ID,
  LIVE_MESSAGE_ID,
  MIXMAX_DATABASE_ID,
  MIXMAX_PROJECT_ID,
  OUTSIDER_EMAIL,
  OWNER_EMAIL,
  OWNER_UID,
  OWNER_WORKSPACE_ID,
  PASSWORD,
  SECRET_ID,
  TEMPLATE_ID,
  THREAD_ID,
} from "../scripts/seed-mixmax-emulator.mjs";

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9499";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8480";
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5401";
const firestoreBase = `http://${firestoreHost}/v1/projects/${MIXMAX_PROJECT_ID}/databases/${MIXMAX_DATABASE_ID}/documents`;

function callableRequests(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().startsWith(`http://${functionsHost}/${MIXMAX_PROJECT_ID}/asia-northeast3/`)) {
      urls.push(request.url());
    }
  });
  return urls;
}

async function signInToken(email: string) {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const json = await response.json() as { idToken?: string; error?: unknown };
  if (!json.idToken) throw new Error(`Mixmax emulator sign-in failed: ${JSON.stringify(json)}`);
  return json.idToken;
}

async function firestoreGet(path: string, token: string) {
  return fetch(`${firestoreBase}/${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function firestorePatch(path: string, token: string, fields: Record<string, unknown>) {
  const url = new URL(`${firestoreBase}/${path}`);
  for (const key of Object.keys(fields)) url.searchParams.append("updateMask.fieldPaths", key);
  return fetch(url, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(fields) }),
  });
}

async function ownerCommit(path: string, fields: Record<string, unknown>) {
  const response = await fetch(`${firestoreBase}:commit`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({
      writes: [{
        update: {
          name: `projects/${MIXMAX_PROJECT_ID}/databases/${MIXMAX_DATABASE_ID}/documents/${path}`,
          fields: toFirestoreFields(fields),
        },
      }],
    }),
  });
  if (!response.ok) throw new Error(`Owner commit failed: ${response.status} ${await response.text()}`);
}

function toFirestoreFields(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, toFirestoreValue(value)]));
}

function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value && typeof value === "object") return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
  return { nullValue: null };
}

async function loginWithGoogleEmulator(page: Page, email = OWNER_EMAIL) {
  await page.goto("/mail");
  await expect(page.getByRole("button", { name: "Google로 계속하기" })).toBeVisible({ timeout: 20_000 });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Google로 계속하기" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");

  const existing = popup.getByText(email, { exact: true });
  if (await existing.count()) {
    await existing.first().click();
  } else {
    await popup.getByText("Add new account", { exact: true }).click();
    await popup.locator("#email-input").fill(email);
    await popup.locator("#display-name-input").fill("Mixmax QA");
    await popup.getByRole("button", { name: "Sign in with Google.com" }).click();
  }
  await popup.waitForEvent("close", { timeout: 20_000 }).catch(() => undefined);

  await expect(page.getByRole("heading", { name: "Live feed" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(OWNER_EMAIL).first()).toBeVisible();
}

test.describe("independent Mixmax runtime", () => {
  test("loads migrated Flu fixture, updates by realtime subscription, and stays quiet without polling callables", async ({ page }) => {
    const callables = callableRequests(page);
    await loginWithGoogleEmulator(page);
    await expect(page.getByText("Flu imported creator deal")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Imported fixture from Flu now belongs to Mixmax.")).toBeVisible();

    await page.getByTestId(`row-${THREAD_ID}`).click();
    const body = page.getByLabel("메일 본문");
    await expect(body).toBeVisible({ timeout: 20_000 });
    await body.fill("unsent local reply must survive live updates");

    await ownerCommit(`mixmax_messages/${LIVE_MESSAGE_ID}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      threadId: THREAD_ID,
      source: "gmail",
      from: "creator@example.com",
      to: [OWNER_EMAIL],
      subject: "Flu imported creator deal",
      text: "Realtime admin-inserted message",
      html: "",
      sentAt: "2026-10-07T00:03:00.000Z",
      direction: "inbound",
      gmailMessageId: "gmail-live-admin",
    });
    await ownerCommit(`mixmax_threads/${THREAD_ID}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      ownerUid: "mixmax-e2e-owner",
      source: "flu",
      sourceSystem: "flu",
      mailbox: OWNER_EMAIL,
      subject: "Flu imported creator deal",
      snippet: "Realtime admin-inserted message",
      participantEmails: [OWNER_EMAIL, "creator@example.com"],
      lastMessageAt: "2026-10-07T00:03:00.000Z",
      unread: true,
      starred: false,
      archived: false,
      updatedAt: "2026-10-07T00:03:00.000Z",
    });

    await expect(page.locator("pre").filter({ hasText: "Realtime admin-inserted message" })).toBeVisible({ timeout: 20_000 });
    await expect(body).toHaveValue("unsent local reply must survive live updates");

    callables.length = 0;
    await page.waitForTimeout(35_000);
    expect(callables).toEqual([]);
    await page.screenshot({ path: "artifacts/verification/mixmax-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "artifacts/verification/mixmax-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("saves a template through the real callable and reloads it from Firestore", async ({ page }) => {
    const callables = callableRequests(page);
    await loginWithGoogleEmulator(page);

    await page.getByRole("button", { name: "Email templates" }).click();
    await expect(page.getByText("Seed follow-up")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "＋ New template" }).click();
    await page.getByRole("dialog", { name: "Edit item" }).getByLabel("Name").fill("QA saved template");
    await page.getByRole("dialog", { name: "Edit item" }).getByLabel("Subject").fill("QA saved subject");
    await page.getByRole("dialog", { name: "Edit item" }).getByLabel("Body").fill("QA saved body from callable");
    await page.getByRole("dialog", { name: "Edit item" }).getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("QA saved template")).toBeVisible({ timeout: 20_000 });
    expect(callables.some((url) => url.includes("mixmaxSaveTemplate"))).toBe(true);

    await page.reload();
    await expect(page.getByRole("button", { name: "Email templates" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Email templates" }).click();
    await expect(page.getByText("QA saved template")).toBeVisible({ timeout: 20_000 });
  });

  test("opens imported AI drafts as replies with the original mailbox context", async ({ page }) => {
    const draftId = "draft-imported-review";
    const missingMailboxThreadId = "thread-imported-missing-mailbox";
    const missingMailboxDraftId = "draft-imported-missing-mailbox";
    const otherConnectionId = "conn-other-google";
    const importedSendId = "send-imported-shared";
    await ownerCommit(`mixmax_connections/${otherConnectionId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: OWNER_UID,
      email: "other@example.com",
      status: "connected",
      syncStatus: "ready",
      updatedAt: "2026-10-07T00:04:00.000Z",
    });
    await ownerCommit(`mixmax_drafts/${draftId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: OWNER_UID,
      threadId: THREAD_ID,
      subject: "Flu imported creator deal",
      body: "Imported AI draft reply",
      to: "",
      status: "needs_review",
      updatedAt: "2026-10-07T00:04:00.000Z",
      createdAt: "2026-10-07T00:04:00.000Z",
    });
    await ownerCommit(`mixmax_threads/${missingMailboxThreadId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      connectionId: "",
      ownerUid: OWNER_UID,
      source: "flu",
      sourceSystem: "flu",
      mailbox: "",
      subject: "Historical Flu thread without sender",
      snippet: "Imported fixture has no saved historical sender.",
      participantEmails: ["creator2@example.com"],
      lastMessageAt: "2026-10-07T00:04:30.000Z",
      unread: false,
      starred: false,
      archived: false,
      updatedAt: "2026-10-07T00:04:30.000Z",
    });
    await ownerCommit(`mixmax_drafts/${missingMailboxDraftId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: OWNER_UID,
      threadId: missingMailboxThreadId,
      subject: "Historical Flu thread without sender",
      body: "Missing mailbox imported draft reply",
      to: "",
      status: "needs_review",
      updatedAt: "2026-10-07T00:04:30.000Z",
      createdAt: "2026-10-07T00:04:30.000Z",
    });
    await ownerCommit(`mixmax_sends/${importedSendId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: "",
      threadId: THREAD_ID,
      to: "creator@example.com",
      subject: "Flu imported sent receipt",
      body: "Imported shared outbox receipt",
      status: "sent",
      importedReceipt: true,
      automaticRetryBlocked: true,
      createdAt: "2026-10-07T00:05:00.000Z",
      sentAt: "2026-10-07T00:05:00.000Z",
    });

    await loginWithGoogleEmulator(page);
    await page.getByRole("button", { name: "AI drafts" }).click();
    await page.getByTestId(`row-${draftId}`).click();
    await page.getByRole("button", { name: "검토하고 메일 작성" }).click();

    const dialog = page.getByRole("dialog", { name: "Compose email" });
    await expect(dialog.locator("header").getByRole("heading", { name: "Reply" })).toBeVisible();
    await expect(dialog.getByLabel("받는 사람")).toHaveValue("creator@example.com");
    await expect(dialog.getByLabel("메일 제목")).toHaveValue("Re: Flu imported creator deal");
    await expect(dialog.getByLabel("메일 본문")).toHaveValue("Imported AI draft reply");
    await expect(dialog.getByLabel("발신 계정")).toHaveValue(CONNECTION_ID);
    await expect(dialog.getByLabel("발신 계정").locator("option")).toHaveText([OWNER_EMAIL]);
    await expect(dialog.getByRole("button", { name: "✧ Draft with AI" })).toBeVisible();

    await dialog.getByLabel("작성창 닫기").click();
    await page.getByTestId(`row-${missingMailboxDraftId}`).click();
    await expect(page.getByText("저장된 과거 발신 계정이 없습니다.")).toBeVisible();
    await expect(page.getByRole("button", { name: "검토하고 메일 작성" })).toBeDisabled();
    await page.getByLabel("과거 대화 발신 계정").selectOption(otherConnectionId);
    await page.getByRole("button", { name: "발신 계정 지정" }).click();
    await expect(page.getByRole("button", { name: "검토하고 메일 작성" })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole("button", { name: "검토하고 메일 작성" }).click();

    await expect(dialog.locator("header").getByRole("heading", { name: "Reply" })).toBeVisible();
    await expect(dialog.getByLabel("받는 사람")).toHaveValue("creator2@example.com");
    await expect(dialog.getByLabel("메일 제목")).toHaveValue("Re: Historical Flu thread without sender");
    await expect(dialog.getByLabel("메일 본문")).toHaveValue("Missing mailbox imported draft reply");
    await expect(dialog.getByLabel("발신 계정")).toHaveValue(otherConnectionId);
    await expect(dialog.getByLabel("발신 계정").locator("option")).toHaveText(["other@example.com"]);
    await dialog.getByLabel("작성창 닫기").click();

    await page.getByRole("button", { name: "Outbox" }).click();
    await expect(page.getByTestId(`row-${importedSendId}`)).toBeVisible();
    await page.getByTestId(`row-${importedSendId}`).click();
    await expect(page.getByRole("heading", { name: "Flu imported sent receipt" })).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: "Imported shared outbox receipt" })).toBeVisible();
  });

  test("Firestore emulator rules deny outsider workspace reads, private secrets, and client writes", async () => {
    const ownerToken = await signInToken(OWNER_EMAIL);
    const outsiderToken = await signInToken(OUTSIDER_EMAIL);

    const ownerThread = await firestoreGet(`mixmax_threads/${THREAD_ID}`, ownerToken);
    expect(ownerThread.status).toBe(200);

    const outsiderThread = await firestoreGet(`mixmax_threads/${THREAD_ID}`, outsiderToken);
    expect([403, 404]).toContain(outsiderThread.status);

    const secret = await firestoreGet(`mixmax_credentials/${SECRET_ID}`, ownerToken);
    expect([403, 404]).toContain(secret.status);

    const clientWrite = await firestorePatch(`mixmax_templates/${TEMPLATE_ID}`, ownerToken, { body: "client write denied" });
    expect([403, 404]).toContain(clientWrite.status);

    const caseRead = await firestoreGet(`mixmax_cases/${CASE_ID}`, ownerToken);
    expect(caseRead.status).toBe(200);
  });
});
