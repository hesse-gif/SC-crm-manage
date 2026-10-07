import { expect, test } from "@playwright/test";

const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "demo-flu";
const firestoreHost = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").replace(/^https?:\/\//, "");
const databaseName = `projects/${project}/databases/(default)`;
const databaseBase = `http://${firestoreHost}/v1/projects/${project}/databases/(default)`;

type FirestoreValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

function toFirestoreValue(value: unknown): FirestoreValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value && typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
            .map(([key, item]) => [key, toFirestoreValue(item)]),
        ),
      },
    };
  }
  return { nullValue: null };
}

function firestoreFields(record: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
      .map(([key, value]) => [key, toFirestoreValue(value)]),
  );
}

async function commitDocument(path: string, record: Record<string, unknown>) {
  const response = await fetch(`${databaseBase}/documents:commit`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({
      writes: [{
        update: {
          name: `${databaseName}/documents/${path}`,
          fields: firestoreFields(record),
        },
      }],
    }),
  });
  if (!response.ok) throw new Error(`Failed to seed ${path}: ${response.status} ${await response.text()}`);
}

async function loginToReceipts(page: import("@playwright/test").Page) {
  await page.goto("/login?next=%2Fchat%2Freceipts");
  await page.getByRole("button", { name: /Google로 로그인/ }).click();
  await expect(page).toHaveURL(/\/chat\/receipts$/, { timeout: 20_000 });
}

async function seedReceipts(stamp: number) {
  const nowIso = new Date().toISOString();
  const replyConversationId = `receipt-reply-${stamp}`;
  const noReplyConversationId = `receipt-no-reply-${stamp}`;
  const replyTrackingId = `receipt_reply_${stamp}`;
  const noReplyTrackingId = `receipt_no_reply_${stamp}`;
  const sparseTrackingId = `receipt_sparse_${stamp}`;
  const replyText = `수신자가 답장했습니다 ${stamp}`;
  await commitDocument(`conversations/${replyConversationId}`, {
    id: replyConversationId,
    threadId: replyConversationId,
    contextKey: `ctx-${replyConversationId}`,
    creatorId: `creator-${replyConversationId}`,
    creatorName: `Reply Receipt Creator ${stamp}`,
    creatorEmail: `reply-receipt-${stamp}@example.test`,
    creatorHandle: `@reply_receipt_${stamp}`,
    creatorAvatar: "R",
    creatorPlatform: "YouTube",
    aiActive: true,
    unread: 1,
    lastMessage: replyText,
    lastMessageFrom: "creator",
    lastMessageAtIso: nowIso,
    updatedAtIso: nowIso,
    messages: [
      { id: "m-out", from: "human", author: "헤세", text: `아웃바운드 ${stamp}`, createdAtIso: nowIso, trackingId: replyTrackingId },
      { id: "m-in", from: "creator", author: `Reply Receipt Creator ${stamp}`, text: replyText, createdAtIso: nowIso },
    ],
  });
  await commitDocument(`conversations/${replyConversationId}/messages/m-in`, {
    id: "m-in",
    from: "creator",
    author: `Reply Receipt Creator ${stamp}`,
    text: replyText,
    createdAtIso: nowIso,
  });
  await commitDocument(`conversations/${noReplyConversationId}`, {
    id: noReplyConversationId,
    threadId: noReplyConversationId,
    contextKey: `ctx-${noReplyConversationId}`,
    creatorId: `creator-${noReplyConversationId}`,
    creatorName: `No Reply Receipt Creator ${stamp}`,
    creatorEmail: `no-reply-receipt-${stamp}@example.test`,
    creatorAvatar: "N",
    aiActive: true,
    unread: 0,
    lastMessage: `발송만 완료 ${stamp}`,
    lastMessageFrom: "human",
    lastMessageAtIso: nowIso,
    updatedAtIso: nowIso,
    messages: [{ id: "m-out", from: "human", author: "헤세", text: `발송만 완료 ${stamp}`, createdAtIso: nowIso, trackingId: noReplyTrackingId }],
  });
  await commitDocument(`mail_outbound_log/${replyTrackingId}`, {
    trackingId: replyTrackingId,
    to: `reply-receipt-${stamp}@example.test`,
    subject: `Reply receipt ${stamp}`,
    deliveryState: "sent",
    sentAtIso: nowIso,
    openCount: 1,
    lastOpenedAtIso: nowIso,
    conversationId: replyConversationId,
    conversationRef: `conversations/${replyConversationId}`,
  });
  await commitDocument(`mail_outbound_log/${noReplyTrackingId}`, {
    trackingId: noReplyTrackingId,
    to: `no-reply-receipt-${stamp}@example.test`,
    subject: `No reply receipt ${stamp}`,
    deliveryState: "sent",
    sentAtIso: nowIso,
    openCount: 0,
    conversationId: noReplyConversationId,
    conversationRef: `conversations/${noReplyConversationId}`,
  });
  await commitDocument(`mail_outbound_log/${sparseTrackingId}`, {
    trackingId: sparseTrackingId,
    sentAtIso: nowIso,
    openCount: 3,
    lastOpenedAtIso: nowIso,
  });
  return { replyConversationId, replyTrackingId, noReplyTrackingId, sparseTrackingId, stamp, replyText };
}

test("mail receipts only enable conversation landing for replied rows", async ({ page }) => {
  test.setTimeout(120_000);
  const seeded = await seedReceipts(Date.now());
  await loginToReceipts(page);
  await expect(page.getByRole("heading", { name: /수신확인/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`Reply receipt ${seeded.stamp}`, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`No reply receipt ${seeded.stamp}`, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(seeded.sparseTrackingId)).toHaveCount(0);
  await expect(page.getByText(/픽셀 감지/).first()).toBeVisible();

  const activeOpen = page.getByTestId(`mail-receipt-open-conversation-${seeded.replyTrackingId}`);
  await expect(activeOpen).toHaveAttribute("href", `/chat?conversationId=${seeded.replyConversationId}`);
  const disabledOpen = page.getByTestId(`mail-receipt-open-conversation-${seeded.noReplyTrackingId}`);
  await expect(disabledOpen).toBeDisabled();
  await expect(page.getByText("회신이 오면 대화가 열립니다").first()).toBeVisible();

  await activeOpen.click();
  await expect(page).toHaveURL(new RegExp(`/chat\\?conversationId=${seeded.replyConversationId}$`), { timeout: 20_000 });
  await expect(page.getByText(`Reply Receipt Creator ${seeded.stamp}`).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(seeded.replyText).first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "evidence/g002-mail-receipts-conversation-landing.png", fullPage: true });
});
