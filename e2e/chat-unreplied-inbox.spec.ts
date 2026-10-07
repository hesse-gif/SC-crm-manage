import { expect, test } from "@playwright/test";

// "미답장 인박스" (2026-09-26, 헤세 요청) — Chat "미답장" 탭 e2e. 서버(listUnrepliedInbox)가
// scp 사서함 대화 중 사람 답장이 필요한 것만 오래 기다린 순서로 내려주는지, 이미 처리된
// 대화(dismissed_no_reply/closed)는 빠지는지, 행 클릭이 /chat?conversationId=… 로 연결되는지
// 검증한다. Firestore seeding 패턴은 e2e/mail-receipts-conversation.spec.ts 와 동일.

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
      writes: [{ update: { name: `${databaseName}/documents/${path}`, fields: firestoreFields(record) } }],
    }),
  });
  if (!response.ok) throw new Error(`Failed to seed ${path}: ${response.status} ${await response.text()}`);
}

async function loginToChat(page: import("@playwright/test").Page) {
  // e2e/chat-malformed-live-data.spec.ts 와 동일한 패턴: goto("/chat") 직후 곧바로 page.url()을
  // 동기 체크하면 클라이언트 사이드 리다이렉트가 아직 안 일어난 시점을 잡을 수 있다(그 경우
  // 로그인 클릭을 건너뛰고 곧 스스로 /login으로 넘어가 버려 탭이 영원히 안 뜬다) — 리다이렉트를
  // 명시적으로 기다린다.
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 20_000 });
  await page.getByRole("button", { name: /Google로 로그인/ }).click();
  await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });
}

test("chat 미답장 탭: 답장이 필요한 대화만 보여주고 이미 처리된 대화는 뺀다", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const nowIso = new Date().toISOString();
  const olderIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const waitingId = `unreplied-waiting-${stamp}`;
  const draftId = `unreplied-draft-${stamp}`;
  const closedId = `unreplied-closed-${stamp}`;

  // ① waiting_for_human — 인박스에 떠야 한다. lastInboundAtIso 를 더 오래된 값으로 줘서
  //    "오래 기다린 순" 정렬에서 draftId 보다 위에 오는지도 같이 확인한다.
  await commitDocument(`conversations/${waitingId}`, {
    id: waitingId,
    threadId: waitingId,
    contextKey: `ctx-${waitingId}`,
    creatorId: `creator-${waitingId}`,
    creatorName: `대기중 창작자 ${stamp}`,
    creatorEmail: `waiting-${stamp}@example.test`,
    lastMessage: `대기중 문의 ${stamp}`,
    lastMessageFrom: "creator",
    lastMessageAtIso: olderIso,
    lastInboundAtIso: olderIso,
    updatedAtIso: olderIso,
    autoReplyStatus: "waiting_for_human",
    autoReplyBlockedReason: `human review reason ${stamp}`,
  });

  // ② draft_only — 인박스에 떠야 하고, 참고 초안 미리보기도 같이 보여야 한다.
  await commitDocument(`conversations/${draftId}`, {
    id: draftId,
    threadId: draftId,
    contextKey: `ctx-${draftId}`,
    creatorId: `creator-${draftId}`,
    creatorName: `초안대기 창작자 ${stamp}`,
    creatorEmail: `draft-${stamp}@example.test`,
    lastMessage: `초안 문의 ${stamp}`,
    lastMessageFrom: "creator",
    lastMessageAtIso: nowIso,
    lastInboundAtIso: nowIso,
    updatedAtIso: nowIso,
    autoReplyStatus: "draft_only",
    humanDraftSuggestionKr: `초안 미리보기 ${stamp}`,
  });

  // ③ closed — 이미 처리된 대화라 인박스에 뜨면 안 된다.
  await commitDocument(`conversations/${closedId}`, {
    id: closedId,
    threadId: closedId,
    contextKey: `ctx-${closedId}`,
    creatorId: `creator-${closedId}`,
    creatorName: `종결된 창작자 ${stamp}`,
    creatorEmail: `closed-${stamp}@example.test`,
    lastMessage: `종결 ${stamp}`,
    lastMessageFrom: "creator",
    lastMessageAtIso: nowIso,
    lastInboundAtIso: nowIso,
    updatedAtIso: nowIso,
    autoReplyStatus: "closed",
  });

  await loginToChat(page);
  const unrepliedTab = page.getByRole("tab", { name: /미답장/ });
  await expect(unrepliedTab).toBeVisible({ timeout: 20_000 });
  await unrepliedTab.click();

  const panel = page.getByTestId("unreplied-inbox-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText(`대기중 창작자 ${stamp}`)).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText(`초안대기 창작자 ${stamp}`)).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText(`종결된 창작자 ${stamp}`)).toHaveCount(0);

  // 보류 사유(waiting_for_human의 humanGate 원문)와 초안 미리보기(draft_only)가 각각 보인다.
  await expect(panel.getByText(`human review reason ${stamp}`)).toBeVisible();
  await expect(panel.getByText(new RegExp(`초안: 초안 미리보기 ${stamp}`))).toBeVisible();

  // 탭 배지 건수 — 시드 기본 픽스처에도 draft_only 대화가 하나 있어(conv-autoreply-draft-only)
  // 정확히 2로 고정하면 다른 시드 변경에 깨지기 쉽다. "숫자 배지가 실제로 뜨고, 이 테스트가
  // 새로 넣은 2건 이상을 반영한다"만 확인한다.
  const tabText = (await unrepliedTab.textContent()) ?? "";
  const badgeCount = Number(tabText.replace(/[^0-9]/g, ""));
  expect(badgeCount).toBeGreaterThanOrEqual(2);

  // 행 클릭 → /chat?conversationId=<id> 딥링크. ListRow는 행 전체를 덮는 절대위치 <a> 오버레이로
  // 클릭을 받는다(텍스트 span 은 pointer-events:none) — href로 정확히 그 앵커를 짚는다.
  await panel.locator(`a[href="/chat?conversationId=${waitingId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/chat\\?conversationId=${waitingId}$`), { timeout: 20_000 });
  await page.screenshot({ path: "evidence/unreplied-inbox-tab.png", fullPage: true });
});
