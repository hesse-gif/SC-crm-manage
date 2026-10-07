import { expect, test } from "@playwright/test";
import { commitDocument, loginAsAdmin } from "./helpers/emulator";

async function waitForQuietListConversationRequests(readCount: () => number) {
  let lastCount = readCount();
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const nextCount = readCount();
    if (nextCount === lastCount) return;
    lastCount = nextCount;
  }
}

test("chat list avoids periodic rereads and refreshes from explicit data events", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const conversationId = `migration-live-${stamp}`;
  const creatorHandle = `@migration_live_${stamp}`;
  const creatorName = `Migration Live ${stamp}`;
  const nowIso = new Date().toISOString();

  let fullListConversationsAfterInitialSettle = 0;
  let selectedConversationPollsAfterInitialSettle = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().includes("listConversations")) return;
    const payload = request.postDataJSON() as { data?: { ids?: unknown } } | null;
    if (Array.isArray(payload?.data?.ids)) {
      selectedConversationPollsAfterInitialSettle += 1;
      return;
    }
    fullListConversationsAfterInitialSettle += 1;
  });

  await loginAsAdmin(page, "/chat");
  await expect(page.getByTestId("chat-list-pane")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Live feed" })).toBeVisible();
  await expect(page.getByText(creatorHandle, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("chat-foreground-sync-status")).not.toHaveText("갱신 중", { timeout: 20_000 });
  await waitForQuietListConversationRequests(() => fullListConversationsAfterInitialSettle + selectedConversationPollsAfterInitialSettle);

  const draftBox = page.getByPlaceholder(/메시지 입력/);
  const draftText = `unsent draft survives explicit refresh ${stamp}`;
  await draftBox.fill(draftText);

  fullListConversationsAfterInitialSettle = 0;
  selectedConversationPollsAfterInitialSettle = 0;
  await page.waitForTimeout(5_000);
  await expect(page.getByTestId("chat-foreground-sync-status")).not.toHaveText("갱신 중", { timeout: 20_000 });
  expect(fullListConversationsAfterInitialSettle).toBe(0);
  expect(selectedConversationPollsAfterInitialSettle).toBeLessThanOrEqual(7);
  await expect(draftBox).toHaveValue(draftText);

  await commitDocument(`conversations/${conversationId}`, {
    id: conversationId,
    threadId: conversationId,
    contextKey: `mail:${conversationId}`,
    creatorId: `creator-${conversationId}`,
    creatorName,
    creatorEmail: `${conversationId}@example.com`,
    creatorHandle,
    creatorPlatform: "YouTube",
    mailAccountId: "scp",
    unread: 1,
    aiActive: true,
    hasCreatorReply: true,
    lastMessageFrom: "creator",
    lastMessage: "streaming migration proof",
    lastMessageAtIso: nowIso,
    lastInboundAtIso: nowIso,
    updatedAtIso: nowIso,
    messages: [
      {
        id: `${conversationId}-m1`,
        from: "creator",
        author: creatorName,
        text: "streaming migration proof",
        createdAtIso: nowIso,
        messageRef: `${conversationId}-message-ref`,
      },
    ],
  });

  await page.evaluate(() => window.dispatchEvent(new Event("flu:data-refresh")));
  await expect(page.getByText(creatorHandle, { exact: true })).toBeVisible({ timeout: 45_000 });
  await page.getByText(creatorHandle, { exact: true }).click();
  await expect(page.getByTestId("chat-conversation-pane").getByText("streaming migration proof")).toBeVisible({ timeout: 20_000 });
});
