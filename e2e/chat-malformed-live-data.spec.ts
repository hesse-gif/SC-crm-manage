import { expect, test } from "@playwright/test";

const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "demo-flu";
const databaseName = `projects/${project}/databases/(default)`;
const firestoreHost = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").replace(/^https?:\/\//, "");
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function seedMalformedConversation(stamp: number) {
  const conversationId = `malformed-chat-${stamp}`;
  const creatorId = `malformed-creator-${stamp}`;
  const name = `Malformed Live Shape ${stamp}`;
  const threadText = `Thread malformed row ${stamp}`;
  const nowIso = new Date().toISOString();
  await commitDocument(`creators/${creatorId}`, {
    id: creatorId,
    name: { nested: true },
    handle: { nested: true },
    avatar: { nested: true },
    followers: "many",
    updatedAtIso: nowIso,
  });
  await commitDocument(`conversations/${conversationId}`, {
    id: conversationId,
    creatorId,
    creatorName: name,
    creatorEmail: null,
    creatorFollowers: "2800000",
    unread: "2",
    aiActive: "true",
    // Creator-reply signal so this conversation belongs in the default chat inbox
    // (dee5863 added hasCreatorReplySignal gating); every other field stays malformed
    // so the test still exercises normalization robustness of a *displayed* row.
    hasCreatorReply: true,
    messages: "not-an-array",
    lastMessage: { nested: true },
    lastMessageFrom: "mystery",
    lastMessageAtIso: nowIso,
    updatedAtIso: nowIso,
  });
  await commitDocument(`conversations/${conversationId}/messages/msg-broken`, {
    id: "msg-broken",
    from: "alien",
    author: 42,
    text: threadText,
    time: { seconds: 123 },
    createdAtIso: nowIso,
    deliveryState: "not-real",
  });
  return { conversationId, creatorId, name, threadText };
}

async function loginToChat(page: import("@playwright/test").Page) {
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 20_000 });
  await page.getByRole("button", { name: /Google로 로그인/ }).click();
  await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });
}

test("chat normalizes malformed live Firestore conversation data", async ({ page }) => {
  const seeded = await seedMalformedConversation(Date.now());
  const logs: string[] = [];
  page.on("console", (message) => logs.push(`[console.${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}\n${error.stack ?? ""}`));

  await loginToChat(page);
  await expect(page.getByRole("heading", { name: "메시지" })).toBeVisible({ timeout: 20_000 });
  const conversationLabel = new RegExp(`${escapeRegExp(seeded.name)}|${escapeRegExp(seeded.creatorId)}`);
  const conversationButton = page.locator("aside button").filter({ hasText: conversationLabel }).first();
  await expect(conversationButton).toBeVisible({ timeout: 20_000 });
  await conversationButton.click();
  const detailPane = page.locator("section.flex.min-w-0.flex-1.flex-col.bg-canvas");
  await expect(detailPane.getByText(seeded.threadText)).toBeVisible({ timeout: 20_000 });
  await expect(detailPane).not.toContainText("[object Object]", { timeout: 5_000 });
  await expect(page.locator("body")).not.toContainText("Application error", { timeout: 5_000 });

  const pageErrors = logs.filter((line) => line.startsWith("[pageerror]"));
  expect(pageErrors, logs.join("\n")).toEqual([]);
});
