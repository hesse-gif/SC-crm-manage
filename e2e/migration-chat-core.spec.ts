import { expect, test, type Page } from "@playwright/test";
import { commitDocument, loginAsAdmin, loginAsDramaManager } from "./helpers/emulator";

const runId = `migration-${Date.now()}`;
const receiptTrackingId = `${runId}-receipt-001`;
const receiptConversationId = `${runId}-receipt-conv`;
const dramaPersonalConversationId = `${runId}-drama-personal-conv`;
const dramaPersonalHandle = `@migration_drama_personal_${runId}`;

async function seedReceiptFixture() {
  const sentAtIso = "2026-10-07T01:00:00.000Z";
  await commitDocument(`conversations/${receiptConversationId}`, {
    id: receiptConversationId,
    threadId: receiptConversationId,
    contextKey: `mail:${receiptConversationId}`,
    creatorId: `${runId}-receipt-creator`,
    creatorName: "Migration Receipt Creator",
    creatorEmail: "migration.receipt@example.com",
    creatorHandle: "@migration_receipt",
    creatorPlatform: "YouTube",
    mailAccountId: "scp",
    unread: 0,
    aiActive: false,
    hasCreatorReply: true,
    lastMessageFrom: "creator",
    lastMessage: "receipt reply",
    lastMessageAtIso: sentAtIso,
    updatedAtIso: sentAtIso,
    messages: [
      {
        id: "receipt-message-1",
        from: "creator",
        author: "Migration Receipt Creator",
        text: "receipt reply",
        createdAtIso: sentAtIso,
      },
    ],
  });
  await commitDocument(`mail_outbound_log/${receiptTrackingId}`, {
    trackingId: receiptTrackingId,
    to: "migration.receipt@example.com",
    toMasked: "mi***@example.com",
    subject: "Migration receipt proof",
    deliveryState: "sent",
    draftRef: `${runId}-draft`,
    gameId: "migration",
    sentByUserId: "flu-emulator-admin",
    sentByRole: "super_admin",
    sentAtIso,
    mailAccountId: "scp",
    conversationId: receiptConversationId,
    conversationRef: `conversations/${receiptConversationId}`,
    conversationSnapshot: {
      id: receiptConversationId,
      mailAccountId: "scp",
      lastMessageFrom: "creator",
      lastMessageAtIso: sentAtIso,
    },
    openCount: 1,
    lastOpenedAtIso: "2026-10-07T01:01:00.000Z",
    hasReply: true,
  });
}

async function seedDramaPersonalFixture() {
  const sentAtIso = "2026-10-07T01:02:00.000Z";
  await commitDocument(`conversations/${dramaPersonalConversationId}`, {
    id: dramaPersonalConversationId,
    threadId: dramaPersonalConversationId,
    contextKey: `mail:${dramaPersonalConversationId}`,
    creatorId: `${runId}-drama-personal-creator`,
    creatorName: "Migration Drama Personal Creator",
    creatorEmail: "migration.drama.personal@example.com",
    creatorHandle: dramaPersonalHandle,
    creatorPlatform: "YouTube",
    mailAccountId: "test-drama-personal",
    unread: 1,
    aiActive: false,
    hasCreatorReply: true,
    lastMessageFrom: "creator",
    lastMessage: "personal mailbox isolation proof",
    lastMessageAtIso: sentAtIso,
    updatedAtIso: sentAtIso,
    messages: [
      {
        id: "drama-personal-message-1",
        from: "creator",
        author: "Migration Drama Personal Creator",
        text: "personal mailbox isolation proof",
        createdAtIso: sentAtIso,
      },
    ],
  });
}

function callableResponses(page: Page, callableName: string) {
  const responses: unknown[] = [];
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || !response.url().includes(callableName)) return;
    try {
      const json = await response.json();
      responses.push(json.result ?? json);
    } catch {
      responses.push({ status: response.status() });
    }
  });
  return responses;
}

test.describe("migration chat core", () => {
  test.beforeAll(async () => {
    await seedReceiptFixture();
    await seedDramaPersonalFixture();
  });

  test("login opens a seeded Flu conversation through real local list/message/read callables", async ({ page }) => {
    const listResponses = callableResponses(page, "listConversations");
    const messageResponses = callableResponses(page, "listConversationMessages");
    const readResponses = callableResponses(page, "markConversationRead");

    await loginAsAdmin(page, "/chat?conversationId=conv-autoreply-creator-reply");

    await expect(page.getByTestId("chat-list-pane")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("chat-conversation-pane")).toBeVisible();
    await expect(page.getByText("Replied Creator", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("chat-conversation-pane").getByText("좋아요, 진행하고 싶습니다!")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByPlaceholder(/메시지 입력/)).toBeVisible();
    await expect(page.getByRole("button", { name: "초안 재생성" })).toBeVisible();

    await expect.poll(() => listResponses.some((response) => Array.isArray((response as { rows?: unknown[] }).rows)), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => messageResponses.some((response) => Array.isArray((response as { messages?: unknown[] }).messages)), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => readResponses.length, { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test("new standalone draft previews through the server without sending a real message", async ({ page }) => {
    const previewResponses = callableResponses(page, "previewEmailDraft");
    const sendRequests: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("sendEmail")) {
        sendRequests.push(request.postDataJSON());
      }
    });

    await loginAsAdmin(page, "/chat?compose=new");

    const compose = page.getByTestId("new-mail-compose");
    await expect(compose).toBeVisible({ timeout: 20_000 });
    await expect(compose.getByRole("combobox", { name: "발신 계정" })).toBeEnabled({ timeout: 20_000 });
    await compose.getByRole("combobox", { name: "발신 계정" }).selectOption("scp");

    const recipient = compose.getByPlaceholder("이메일 주소 또는 Workspace 그룹 주소");
    const subject = compose.getByPlaceholder("메일 제목");
    const draft = compose.getByPlaceholder(/메시지 입력/);
    await recipient.fill("migration-preview@example.com");
    await expect(recipient).toHaveValue("migration-preview@example.com");
    await subject.fill("Migration preview proof");
    await expect(subject).toHaveValue("Migration preview proof");
    await draft.fill("This is a preview-only migration draft.");
    await expect(draft).toHaveValue("This is a preview-only migration draft.");

    const previewButton = compose.getByRole("button", { name: "메일 미리보기" });
    await expect(previewButton).toBeEnabled({ timeout: 20_000 });
    await previewButton.click();

    await expect(page.getByRole("dialog").filter({ hasText: "메일 미리보기" })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => previewResponses.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(sendRequests).toEqual([]);
  });

  test("receipts, templates, and casebook surfaces load from emulator-backed Flu data", async ({ page }) => {
    await loginAsAdmin(page, "/chat/receipts");

    await expect(page.getByText("Migration receipt proof").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`mail-receipt-open-conversation-${receiptTrackingId}`)).toBeVisible();

    await page.goto("/chat/templates");
    await expect(page.getByRole("heading", { name: "메시지 템플릿" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("템플릿 목록")).toBeVisible();
    await expect(page.getByText("메시지 본문")).toBeVisible();

    await page.goto("/chat/auto");
    await expect(page.getByTestId("permit-chat-auto-ui")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pending-headline-card")).toBeVisible();
  });

  test("mailbox-scoped auth does not show another account's shared mailbox rows to a personal-mailbox manager", async ({ page }) => {
    await loginAsDramaManager(page, "/chat");

    const mailboxSelect = page.getByRole("combobox", { name: "운영자 메일함 보기" });
    await expect(mailboxSelect).toBeHidden({ timeout: 20_000 });
    await expect(page.getByText("보기 · AI Drama 매니저 개인 메일함(QA)").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(dramaPersonalHandle, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("@migration_receipt", { exact: true })).toHaveCount(0);
  });
});
