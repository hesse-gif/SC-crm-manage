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

async function firestoreDoc(path: string, token: string) {
  const response = await firestoreGet(path, token);
  return { response, data: response.ok ? fromFirestoreFields((await response.json() as { fields?: Record<string, unknown> }).fields ?? {}) : null };
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

function fromFirestoreFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreValue(value as Record<string, unknown>)]));
}

function fromFirestoreValue(value: Record<string, unknown>): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("arrayValue" in value) return ((value.arrayValue as { values?: Record<string, unknown>[] }).values ?? []).map(fromFirestoreValue);
  if ("mapValue" in value) return fromFirestoreFields((value.mapValue as { fields?: Record<string, unknown> }).fields ?? {});
  return null;
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

  test("shows seeded automatic reply review state without invoking analysis", async ({ page }) => {
    const callables = callableRequests(page);
    const automationThreadId = "thread-automation-review";
    const automationRunId = "run-automation-review";
    const uncertainRunId = "run-automation-confirm";
    const pendingCaseId = "case-automation-pending";
    await ownerCommit(`mixmax_threads/${automationThreadId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      ownerUid: OWNER_UID,
      source: "gmail",
      mailbox: OWNER_EMAIL,
      subject: "Can you send the guide again?",
      snippet: "Please send the guide again.",
      participantEmails: [OWNER_EMAIL, "creator-auto@example.com"],
      latestMessageId: "msg-automation-review",
      latestMessageDirection: "inbound",
      automationCaseId: pendingCaseId,
      lastMessageAt: "2026-10-07T00:06:00.000Z",
      unread: true,
      starred: false,
      archived: false,
      updatedAt: "2026-10-07T00:06:00.000Z",
    });
    await ownerCommit(`mixmax_messages/msg-automation-review`, {
      workspaceId: OWNER_WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      threadId: automationThreadId,
      source: "gmail",
      from: "creator-auto@example.com",
      to: [OWNER_EMAIL],
      subject: "Can you send the guide again?",
      text: "Please send the guide again.",
      html: "",
      sentAt: "2026-10-07T00:06:00.000Z",
      direction: "inbound",
      gmailMessageId: "gmail-auto-review",
    });
    await ownerCommit(`mixmax_cases/${pendingCaseId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      name: "Guide resend request",
      description: "Creator asks for the program guide again.",
      proposedReply: "Sure, here is the program guide again.",
      status: "pending",
      policyDigest: "seed-review-digest",
      createdAt: "2026-10-07T00:06:01.000Z",
      updatedAt: "2026-10-07T00:06:01.000Z",
    });
    await ownerCommit(`mixmax_automation_runs/${automationRunId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: OWNER_UID,
      connectionId: CONNECTION_ID,
      threadId: automationThreadId,
      caseId: pendingCaseId,
      status: "needs_review",
      reason: "unknown_case_created",
      createdAt: "2026-10-07T00:06:02.000Z",
      updatedAt: "2026-10-07T00:06:02.000Z",
    });
    await ownerCommit(`mixmax_automation_runs/${uncertainRunId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: OWNER_UID,
      connectionId: CONNECTION_ID,
      threadId: automationThreadId,
      caseId: pendingCaseId,
      status: "sending",
      reason: "provider_uncertain",
      createdAt: "2026-10-07T00:06:03.000Z",
      updatedAt: "2026-10-07T00:06:03.000Z",
    });

    await loginWithGoogleEmulator(page);
    await page.getByTestId(`row-${automationThreadId}`).click();
    await expect(page.getByText("검토 필요 · 새 케이스 생성")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("발송 확인 중 · 결과 확인 필요")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Gmail 발송함에서 확인 후 선택해 주세요.")).toBeVisible();
    await expect(page.getByRole("button", { name: "발송됨 확인" })).toBeVisible();
    await expect(page.getByRole("button", { name: "발송되지 않음 확인" })).toBeVisible();

    await page.getByRole("button", { name: "응대 케이스" }).click();
    await expect(page.getByTestId(`row-${pendingCaseId}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("검토 필요")).toBeVisible();
    await page.getByTestId(`row-${pendingCaseId}`).click();
    await expect(page.getByRole("button", { name: "이 케이스 자동응대" })).toBeVisible();

    expect(callables.some((url) => url.includes("mixmaxAnalyzeThread"))).toBe(false);
  });

  test("uses real callables for settings and case approval without analysis", async ({ page }) => {
    const callables = callableRequests(page);
    const ownerToken = await signInToken(OWNER_EMAIL);
    const automationThreadId = "thread-automation-approval";
    const pendingCaseId = "case-automation-approval";
    await ownerCommit(`mixmax_threads/${automationThreadId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      ownerUid: OWNER_UID,
      source: "gmail",
      mailbox: OWNER_EMAIL,
      subject: "Can you send the guide again?",
      snippet: "Please send the guide again.",
      participantEmails: [OWNER_EMAIL, "creator-approval@example.com"],
      latestMessageId: "msg-automation-approval",
      latestMessageDirection: "inbound",
      automationCaseId: pendingCaseId,
      lastMessageAt: "2026-10-07T00:07:00.000Z",
      unread: true,
      starred: false,
      archived: false,
      updatedAt: "2026-10-07T00:07:00.000Z",
    });
    await ownerCommit(`mixmax_cases/${pendingCaseId}`, {
      workspaceId: OWNER_WORKSPACE_ID,
      name: "Guide resend request",
      description: "Creator asks for the program guide again.",
      proposedReply: "Sure, here is the program guide again.",
      status: "pending",
      policyDigest: "seed-approval-digest",
      createdAt: "2026-10-07T00:07:01.000Z",
      updatedAt: "2026-10-07T00:07:01.000Z",
    });

    await loginWithGoogleEmulator(page);
    await page.getByRole("button", { name: "My settings" }).click();
    const ownerAccount = page.getByRole("article").filter({ hasText: OWNER_EMAIL });
    await ownerAccount.getByLabel("새 메일 자동 분류").click();
    await expect(page.getByText("새 메일 자동 분류를 켰습니다.")).toBeVisible({ timeout: 20_000 });
    let connection = await firestoreDoc(`mixmax_connections/${CONNECTION_ID}`, ownerToken);
    expect(connection.data?.automationEnabled).toBe(true);

    await ownerAccount.getByLabel("새 메일 자동 분류").click();
    await expect(page.getByText("새 메일 자동 분류를 일시정지했습니다.")).toBeVisible({ timeout: 20_000 });
    connection = await firestoreDoc(`mixmax_connections/${CONNECTION_ID}`, ownerToken);
    expect(connection.data?.automationEnabled).toBe(false);

    await page.getByRole("button", { name: "Live feed" }).click();
    await page.getByTestId(`row-${automationThreadId}`).click();
    await page.getByText("자동응대 설정").click();
    await page.getByLabel("자동응대 케이스 이름").fill("Guide resend request");
    await page.getByLabel("자동응대 매칭 기준").fill("Creator asks for the program guide again.");
    await page.getByLabel("자동응대 답장").fill("Sure, here is the program guide again.");
    await page.getByRole("button", { name: "앞으로 자동응대" }).click();
    await expect(page.getByText("앞으로 같은 케이스는 저장한 답변으로 자동응대합니다.")).toBeVisible({ timeout: 20_000 });

    const approvedCase = await firestoreDoc(`mixmax_cases/${pendingCaseId}`, ownerToken);
    expect(approvedCase.response.status).toBe(200);
    expect(typeof approvedCase.data?.policyDigest).toBe("string");
    const automation = approvedCase.data?.automation as Record<string, Record<string, unknown>>;
    expect(automation[CONNECTION_ID]?.enabled).toBe(true);
    expect(automation[CONNECTION_ID]?.policyDigest).toBe(approvedCase.data?.policyDigest);

    expect(callables.some((url) => url.includes("mixmaxSetAutomationSettings"))).toBe(true);
    expect(callables.some((url) => url.includes("mixmaxAnalyzeThread"))).toBe(false);
    expect(callables.some((url) => url.includes("mixmaxConfigureCaseAutomation"))).toBe(true);
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

    await ownerCommit("mixmax_automation_runs/run-owner-readable", {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: OWNER_UID,
      threadId: THREAD_ID,
      connectionId: CONNECTION_ID,
      status: "needs_review",
      createdAt: "2026-10-07T00:08:00.000Z",
    });
    await ownerCommit("mixmax_automation_runs/run-outsider-private", {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: "someone-else",
      threadId: THREAD_ID,
      connectionId: CONNECTION_ID,
      status: "needs_review",
      createdAt: "2026-10-07T00:08:00.000Z",
    });
    await ownerCommit("mixmax_automation_budgets/test-private", {
      workspaceId: OWNER_WORKSPACE_ID,
      ownerUid: OWNER_UID,
      count: 1,
      updatedAt: "2026-10-07T00:08:00.000Z",
    });

    const ownerRun = await firestoreGet("mixmax_automation_runs/run-owner-readable", ownerToken);
    expect(ownerRun.status).toBe(200);

    const outsiderRun = await firestoreGet("mixmax_automation_runs/run-owner-readable", outsiderToken);
    expect([403, 404]).toContain(outsiderRun.status);

    const foreignRun = await firestoreGet("mixmax_automation_runs/run-outsider-private", ownerToken);
    expect([403, 404]).toContain(foreignRun.status);

    const budget = await firestoreGet("mixmax_automation_budgets/test-private", ownerToken);
    expect([403, 404]).toContain(budget.status);

    const clientCaseAutomationWrite = await firestorePatch(`mixmax_cases/${CASE_ID}`, ownerToken, { automation: { [CONNECTION_ID]: { enabled: true } } });
    expect([403, 404]).toContain(clientCaseAutomationWrite.status);

    const clientRunWrite = await firestorePatch("mixmax_automation_runs/run-owner-readable", ownerToken, { status: "sent" });
    expect([403, 404]).toContain(clientRunWrite.status);
  });
});
