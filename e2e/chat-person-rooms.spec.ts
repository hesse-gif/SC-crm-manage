import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers/emulator";

// W106 Phase 4 (plans/flu-chat-person-rooms-metaprompt.md §7) — 사람 방 e2e.
//
// 시드 확인: scripts/seed-emulator.mjs 의 기본(비 --bulk) conversations 픽스처는 크리에이터당
// 갈래 1개뿐이다(appendAutoReplyFixtures 등 — creatorId 가 전부 서로 다름). 사람 방(다중 갈래
// 병합)이 성립하려면 같은 사람의 갈래가 2개 이상 있어야 하는데 기존 시드에는 없다. 그래서
// video-view-series.spec.ts 관례를 그대로 따라 이 스펙 안에서 Firestore emulator REST 로 최소
// 픽스처(같은 사람 2갈래: 콜드 direct 갈래 + 캠페인 갈래)를 직접 시드한다. 파일별 독립 에뮬(fresh
// emulator) 이므로 다른 스펙의 시드를 오염시키지 않는다. functions/ 는 건드리지 않는다.
//
// 시나리오(플랜 §7 Phase 4 완료 기준): 사람 방 진입 → 갈래 칩 필터 전환 → 답장 대상 칩
// 확인(기본값·갈래 필터 잠금·드롭업 전환) → 발송. "발송이 답장 대상 갈래의 conversation 으로
// 향하는지"는 program-workflow.spec.ts 관례(page.route 로 콜러블 요청 바디를 캡처해 어서션)를
// 그대로 재사용한다 — 실제 SMTP/메일-세이프티 게이트 통과 여부는 이 저장소의 기존 관례대로
// 별도 웨이브(chat-composer.spec.ts, scp-coldmail-history.spec.ts 주석: "실발송 검증은 G7
// (verify+live) 웨이브") 범위이므로 이 스펙은 요청 바디의 타깃 필드만 단언한다.

const project = process.env.GCLOUD_PROJECT || "demo-flu";
const firestoreHost = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").replace(/^https?:\/\//, "");
const documentsBase = `http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents`;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function encodeValue(value: Json): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) } };
}

async function writeDocument(collection: string, id: string, data: Record<string, Json>): Promise<void> {
  const response = await fetch(`${documentsBase}/${collection}/${id}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, item]) => [key, encodeValue(item)])) }),
  });
  if (!response.ok) throw new Error(`write ${collection}/${id} failed: ${response.status} ${await response.text()}`);
}

const CREATOR_ID = "e2e-person-room-creator";
const CREATOR_EMAIL = "e2e-person-room@example.com";
const CREATOR_HANDLE = "@e2e_person_room";
const CREATOR_NAME = "이플로우 페르소나";

const COLD_CONV_ID = "e2e-person-room-cold-conv";
const COLD_THREAD_ID = "e2e-person-room-cold-thread";
const COLD_STRAND_LABEL = "메일 thread"; // workflow-context.ts campaignId/programId 없는 기본 라벨(§4 L1).

const CAMPAIGN_CONV_ID = "e2e-person-room-campaign-conv";
const CAMPAIGN_THREAD_ID = "e2e-person-room-campaign-thread";
const CAMPAIGN_ID = "e2e-person-room-campaign-001";
const CAMPAIGN_TITLE = "E2E 발키리 캠페인";

// 콜드보다 캠페인 인바운드가 더 최신 → defaultReplyStrand = 캠페인 갈래(부록 규칙 2: 최신 인바운드).
const COLD_INBOUND_ISO = "2026-08-01T09:10:00.000Z";
const CAMPAIGN_INBOUND_ISO = "2026-08-10T09:20:00.000Z";

test.describe("chat: person rooms (W106 Phase 4)", () => {
  test.beforeAll(async () => {
    // conversations 는 lastMessageAtIso desc 로 정렬/투영된다(functions/read.ts
    // collectionOrderForKey) — 이 필드가 없으면 목록 투영에서 영구 제외된다(플랜 §5 리스크 2).
    await writeDocument("conversations", COLD_CONV_ID, {
      id: COLD_CONV_ID,
      threadId: COLD_THREAD_ID,
      creatorId: CREATOR_ID,
      creatorName: CREATOR_NAME,
      creatorEmail: CREATOR_EMAIL,
      creatorHandle: CREATOR_HANDLE,
      creatorPlatform: "YouTube",
      unread: 2,
      aiActive: false,
      hasCreatorReply: true,
      lastMessageFrom: "creator",
      lastMessage: "콜드 갈래 회신입니다",
      lastMessageAtIso: COLD_INBOUND_ISO,
      lastInboundAtIso: COLD_INBOUND_ISO,
      updatedAtIso: COLD_INBOUND_ISO,
      messages: [
        { id: "cold-m1", from: "human", author: "헤세", time: "09:00", createdAtIso: "2026-08-01T09:00:00.000Z", text: "협업 제안 — 콜드 갈래", trackingId: "e2e-person-room-cold-out-1", messageRef: "msgref-e2e-person-room-cold-m1" },
        { id: "cold-m2", from: "creator", author: CREATOR_NAME, time: "09:10", createdAtIso: COLD_INBOUND_ISO, text: "콜드 갈래 회신입니다", trackingId: "e2e-person-room-cold-in-1", messageRef: "msgref-e2e-person-room-cold-m2" },
      ],
    });

    await writeDocument("conversations", CAMPAIGN_CONV_ID, {
      id: CAMPAIGN_CONV_ID,
      threadId: CAMPAIGN_THREAD_ID,
      campaignId: CAMPAIGN_ID,
      campaignTitle: CAMPAIGN_TITLE,
      creatorId: CREATOR_ID,
      creatorName: CREATOR_NAME,
      creatorEmail: CREATOR_EMAIL,
      creatorHandle: CREATOR_HANDLE,
      creatorPlatform: "YouTube",
      unread: 3,
      aiActive: false,
      hasCreatorReply: true,
      lastMessageFrom: "creator",
      lastMessage: "캠페인 갈래 회신입니다",
      lastMessageAtIso: CAMPAIGN_INBOUND_ISO,
      lastInboundAtIso: CAMPAIGN_INBOUND_ISO,
      updatedAtIso: CAMPAIGN_INBOUND_ISO,
      messages: [
        { id: "campaign-m1", from: "human", author: "헤세", time: "09:00", createdAtIso: "2026-08-10T09:00:00.000Z", text: "협업 제안 — 캠페인 갈래", trackingId: "e2e-person-room-campaign-out-1", messageRef: "msgref-e2e-person-room-campaign-m1", campaignId: CAMPAIGN_ID },
        { id: "campaign-m2", from: "creator", author: CREATOR_NAME, time: "09:20", createdAtIso: CAMPAIGN_INBOUND_ISO, text: "캠페인 갈래 회신입니다", trackingId: "e2e-person-room-campaign-in-1", messageRef: "msgref-e2e-person-room-campaign-m2", campaignId: CAMPAIGN_ID },
      ],
    });
  });

  test("사람 방 진입 → 갈래 필터 전환 → 답장 대상 칩(기본값/잠금/드롭업) → 발송이 타깃 갈래로 향한다", async ({ page }) => {
    test.setTimeout(120_000);

    const markReadRequests: Record<string, unknown>[] = [];
    const sendEmailRequests: Record<string, unknown>[] = [];
    await page.route(/markConversationRead/, async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { data?: Record<string, unknown> } | null;
        markReadRequests.push(body?.data ?? {});
      }
      await route.continue();
    });
    await page.route(/sendEmail/, async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { data?: Record<string, unknown> } | null;
        sendEmailRequests.push(body?.data ?? {});
      }
      await route.continue();
    });

    await loginAsAdmin(page, "/chat");
    await page.getByRole("combobox", { name: "운영자 메일함 보기" }).selectOption("scp");

    // ── 1) 사람 탭 클릭 → 사람 카드 클릭 (방 진입) ──
    // W111 (헤세): 사람 뷰가 "전체" 탭 자리로 옮겨졌다 — 워딩만 바뀌고 내용은 같은 사람 방이다.
    await page.getByRole("tab", { name: "전체" }).click();
    // 검색으로 우리 픽스처 카드만 남긴다 — 가상 목록 순서/스크롤 위치에 의존하지 않기 위함.
    await page.getByPlaceholder("대화 검색 (이름·핸들·이메일·최근 메시지)").fill(CREATOR_HANDLE);
    const personCard = page.getByText(CREATOR_HANDLE, { exact: true });
    await expect(personCard).toBeVisible({ timeout: 20_000 });
    await personCard.click();

    // 방 진입 즉시 두 갈래가 병합되어 보인다(§4 L1 groupConversationsByPerson).
    await expect(page.getByText(`갈래 2 · 안읽음 5`)).toBeVisible({ timeout: 20_000 });

    // P-3: 방 전체 진입은 이 방의 모든 갈래를 기존 markConversationRead 로 순차 호출한다.
    await expect.poll(() => markReadRequests.map((r) => r.conversationId).sort(), { timeout: 20_000 })
      .toEqual([CAMPAIGN_CONV_ID, COLD_CONV_ID].sort());

    // ── 2) 답장 대상 칩 확인 — 기본값: 최신 인바운드 갈래(캠페인), 잠금 아님 ──
    const replyTargetChip = page.getByTestId("person-reply-target-chip");
    await expect(replyTargetChip).toContainText(CAMPAIGN_TITLE);
    await expect(replyTargetChip).toHaveAttribute("title", "클릭해서 답장 대상 갈래 변경");

    // ── 3) 갈래 칩 필터 전환 — 캠페인 갈래로 필터하면 답장 대상이 그 갈래로 고정(잠금)된다 ──
    const strandBar = page.getByTestId("person-strand-bar");
    await strandBar.getByRole("button", { name: new RegExp(CAMPAIGN_TITLE) }).click();
    await expect(replyTargetChip).toHaveAttribute("title", "갈래 보기 중에는 답장 대상이 고정됩니다");
    await expect(replyTargetChip).toContainText(CAMPAIGN_TITLE);

    // "전체" 칩으로 복귀하면 다시 잠금 해제(기본값)로 돌아간다.
    await strandBar.getByRole("button", { name: /^전체/ }).click();
    await expect(replyTargetChip).toHaveAttribute("title", "클릭해서 답장 대상 갈래 변경");
    await expect(replyTargetChip).toContainText(CAMPAIGN_TITLE);

    // ── 4) 드롭업 전환 — 답장 대상 칩을 열어 콜드 갈래로 수동 전환(override, 여전히 잠금 아님) ──
    await replyTargetChip.click();
    const dropup = page.getByTestId("person-reply-target-menu");
    await expect(dropup).toBeVisible();
    await dropup.getByRole("button", { name: new RegExp(COLD_STRAND_LABEL) }).click();
    await expect(replyTargetChip).toContainText(COLD_STRAND_LABEL);
    await expect(replyTargetChip).toHaveAttribute("title", "클릭해서 답장 대상 갈래 변경");

    // ── 5) 발송 — 답장 대상(콜드 갈래)의 conversation 으로 향하는지 확인 ──
    const sendText = `e2e 사람방 발송 확인 ${Date.now()}`;
    await page.getByPlaceholder(/메시지 입력/).fill(sendText);
    await page.getByRole("button", { name: "메일 발송" }).click();

    await expect.poll(() => sendEmailRequests.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(sendEmailRequests[0]).toMatchObject({
      conversationId: COLD_CONV_ID,
      threadId: COLD_THREAD_ID,
      text: sendText,
    });
    // 캠페인 갈래(잠겨 있지 않았고, 드롭업으로 콜드로 바꾼 뒤였다)로 새지 않았는지 명시적으로 확인.
    expect(sendEmailRequests[0].conversationId).not.toBe(CAMPAIGN_CONV_ID);

    // 발송 클릭의 비동기 왕복이 어떤 결과로든 정리되었는지(멈춰있지 않은지) — 버튼 타이틀이
    // "메일 발송 중"에서 되돌아오면 요청이 처리 완료된 것이다. 실제 SMTP/게이트 통과 여부(성공/차단)는
    // 이 스펙의 범위가 아니다(파일 상단 주석 — G7(verify+live) 웨이브).
    await expect(page.getByRole("button", { name: "메일 발송" })).toBeVisible({ timeout: 20_000 });
  });
});

type CallablePayload = Record<string, unknown>;

function callableResult(body: Record<string, unknown>) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ result: body }),
  };
}

function conversation(id: string, creatorHandle: string, lastMessageAtIso: string) {
  return {
    id,
    threadId: id,
    creatorId: `${id}-creator`,
    creatorHandle,
    creatorName: creatorHandle,
    creatorEmail: `${id}@example.com`,
    hasCreatorReply: true,
    hiddenFromDefaultChat: false,
    lastMessage: `메시지 ${creatorHandle}`,
    lastMessageAtIso,
    updatedAtIso: lastMessageAtIso,
    unread: 0,
    aiActive: false,
  };
}

test("chat person view keeps the first mailbox page bounded and loads older rows only on click", async ({ page }) => {
  const pageRequests: CallablePayload[] = [];
  const liveFeedRequests: CallablePayload[] = [];

  await page.route(/listConversations/, async (route) => {
    const body = route.request().postDataJSON() as { data?: CallablePayload } | null;
    const payload = body?.data ?? {};

    if (!payload.mailAccountId) {
      liveFeedRequests.push(payload);
      await route.fulfill(callableResult({ ok: true, key: "conversations", rows: [], counts: { conversations: 0 }, pageInfo: { limit: 100, truncated: false, nextCursor: null } }));
      return;
    }

    if (payload.ids) {
      await route.fulfill(callableResult({ ok: true, key: "conversations", rows: [], counts: { conversations: 0 }, pageInfo: { limit: 1, truncated: false, nextCursor: null } }));
      return;
    }

    pageRequests.push(payload);
    const isOlderPage = payload.cursor === "older-page";
    await route.fulfill(callableResult({
      ok: true,
      key: "conversations",
      rows: isOlderPage
        ? [conversation("chat-pagination-older", "@pagination_older", "2026-08-01T09:00:00.000Z")]
        : [conversation("chat-pagination-first", "@pagination_first", "2026-09-01T09:00:00.000Z")],
      counts: { conversations: 1 },
      pageInfo: { limit: 100, truncated: !isOlderPage, nextCursor: isOlderPage ? null : "older-page" },
    }));
  });

  await loginAsAdmin(page, "/chat");
  await page.getByRole("combobox", { name: "운영자 메일함 보기" }).selectOption("scp");
  await expect(page.getByRole("heading", { name: "메시지" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("aside").getByText("@pagination_first", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId("chat-load-older-conversations")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  expect(pageRequests).toHaveLength(1);
  expect(pageRequests[0]).toMatchObject({ mailAccountId: expect.any(String) });
  expect(pageRequests[0]).not.toHaveProperty("cursor");
  expect(pageRequests[0]).not.toHaveProperty("limit");

  await page.getByTestId("chat-load-older-conversations").click();
  await expect(page.locator("aside").getByText("@pagination_older", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(pageRequests).toHaveLength(2);
  expect(pageRequests[1]).toMatchObject({ mailAccountId: pageRequests[0].mailAccountId, cursor: "older-page" });
  expect(pageRequests[1]).not.toHaveProperty("limit");
});

test("chat person view keeps older-page CTA reachable after an empty scoped first page", async ({ page }) => {
  const pageRequests: CallablePayload[] = [];

  await page.route(/listConversations/, async (route) => {
    const body = route.request().postDataJSON() as { data?: CallablePayload } | null;
    const payload = body?.data ?? {};

    if (!payload.mailAccountId) {
      await route.fulfill(callableResult({ ok: true, key: "conversations", rows: [], counts: { conversations: 0 }, pageInfo: { limit: 100, truncated: false, nextCursor: null } }));
      return;
    }

    if (payload.ids) {
      await route.fulfill(callableResult({ ok: true, key: "conversations", rows: [], counts: { conversations: 0 }, pageInfo: { limit: 1, truncated: false, nextCursor: null } }));
      return;
    }

    pageRequests.push(payload);
    const isOlderPage = payload.cursor === "empty-first-older-page";
    await route.fulfill(callableResult({
      ok: true,
      key: "conversations",
      rows: isOlderPage
        ? [conversation("chat-empty-first-older", "@empty_first_older", "2026-07-01T09:00:00.000Z")]
        : [],
      counts: { conversations: isOlderPage ? 1 : 0 },
      pageInfo: { limit: 100, truncated: !isOlderPage, nextCursor: isOlderPage ? null : "empty-first-older-page" },
    }));
  });

  await loginAsAdmin(page, "/chat");
  await page.getByRole("combobox", { name: "운영자 메일함 보기" }).selectOption("scp");
  // The mailbox prefix is resolved from the current org/account context, so only the stable empty-state copy is fixed here.
  await expect(page.getByRole("main").getByRole("status").filter({
    hasText: "메일함에 표시할 대화가 없습니다. 다른 메일함의 기존 기록은 계정 보기에서 확인할 수 있습니다.",
  })).toBeVisible({ timeout: 20_000 });
  // The empty state is a full-page placeholder (no aside), so it carries its own CTA testid —
  // the aside header CTA keeps "chat-load-older-conversations" (see the populated-page test).
  await expect(page.getByTestId("chat-load-older-conversations-empty")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("aside").getByText("@empty_first_older", { exact: true })).toHaveCount(0);
  expect(pageRequests).toHaveLength(1);
  expect(pageRequests[0]).toMatchObject({ mailAccountId: expect.any(String) });
  expect(pageRequests[0]).not.toHaveProperty("cursor");
  expect(pageRequests[0]).not.toHaveProperty("limit");

  await page.getByTestId("chat-load-older-conversations-empty").click();
  await expect(page.locator("aside").getByText("@empty_first_older", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(pageRequests).toHaveLength(2);
  expect(pageRequests[1]).toMatchObject({ mailAccountId: pageRequests[0].mailAccountId, cursor: "empty-first-older-page" });
  expect(pageRequests[1]).not.toHaveProperty("limit");
});

test("chat person view surfaces a retryable banner and re-enables the button when the older page fails", async ({ page }) => {
  const pageRequests: CallablePayload[] = [];
  let olderPageAttempts = 0;

  await page.route(/listConversations/, async (route) => {
    const body = route.request().postDataJSON() as { data?: CallablePayload } | null;
    const payload = body?.data ?? {};

    if (!payload.mailAccountId) {
      await route.fulfill(callableResult({ ok: true, key: "conversations", rows: [], counts: { conversations: 0 }, pageInfo: { limit: 100, truncated: false, nextCursor: null } }));
      return;
    }

    if (payload.ids) {
      await route.fulfill(callableResult({ ok: true, key: "conversations", rows: [], counts: { conversations: 0 }, pageInfo: { limit: 1, truncated: false, nextCursor: null } }));
      return;
    }

    pageRequests.push(payload);
    const isOlderPage = payload.cursor === "older-page-retry";
    if (isOlderPage) {
      olderPageAttempts += 1;
      // The first older-page request fails closed; the retry (same cursor, re-issued by a
      // second click) succeeds so the test can assert the click actually re-fires the request.
      if (olderPageAttempts === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { status: "INTERNAL", message: "forced older-page failure" } }),
        });
        return;
      }
    }
    await route.fulfill(callableResult({
      ok: true,
      key: "conversations",
      rows: isOlderPage
        ? [conversation("chat-pagination-older-retry", "@pagination_older_retry", "2026-08-01T09:00:00.000Z")]
        : [conversation("chat-pagination-first-retry", "@pagination_first_retry", "2026-09-01T09:00:00.000Z")],
      counts: { conversations: 1 },
      pageInfo: { limit: 100, truncated: !isOlderPage, nextCursor: isOlderPage ? null : "older-page-retry" },
    }));
  });

  await loginAsAdmin(page, "/chat");
  await page.getByRole("combobox", { name: "운영자 메일함 보기" }).selectOption("scp");
  await expect(page.getByRole("heading", { name: "메시지" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("aside").getByText("@pagination_first_retry", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  const loadOlderButton = page.getByTestId("chat-load-older-conversations");
  await expect(loadOlderButton).toBeVisible({ timeout: 20_000 });
  await loadOlderButton.click();

  await expect(page.getByText("이전 대화 불러오기 실패 — 다시 시도해 주세요.")).toBeVisible({ timeout: 20_000 });
  await expect(loadOlderButton).toBeEnabled({ timeout: 20_000 });
  expect(pageRequests.filter((request) => request.cursor === "older-page-retry")).toHaveLength(1);

  await loadOlderButton.click();
  await expect(page.locator("aside").getByText("@pagination_older_retry", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(pageRequests.filter((request) => request.cursor === "older-page-retry")).toHaveLength(2);
});
