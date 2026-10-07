import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { commitDocument, deleteDocument, loginAsAdmin } from "./helpers/emulator";

// /chat/auto 검토 보드 (2026-10-05) — emulator-only, SYNTHETIC fixtures (example.test addresses,
// rb-e2e-* ids). Exercises the real listChatAutoReviewBoard emulator callable for the board, and
// route stubs only for UI states (loading/empty/error/2-page restore). Records every POST to a
// send/save/settings callable and asserts none happens. Screenshots are written only when
// REVIEW_BOARD_SCREENSHOT_DIR is set.
const SHOT_DIR = process.env.REVIEW_BOARD_SCREENSHOT_DIR ?? "";
const FORBIDDEN = /sendEmail|sendChatAutoCaseHeldBacklogNow|saveChatAutoCaseReply|resetChatAutoCaseReply|setChatAutoCasePermitArming|updateAutoReply|setConversationAutoReply|updateSettings|requeueAutoReplyBacklog/;
const NOW = "2026-10-05T09:00:00.000Z";
const hash24 = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);

type Fixture = {
  key: string;
  minutesAgo: number;
  caseId?: string;
  intents?: string[];
  body?: string;
  summary: string;
  aiActive?: boolean;
  lastMessageFrom?: string;
  email?: string;
  actorType?: string;
};

const FIXTURES: Fixture[] = [
  { key: "final", minutesAgo: 1, caseId: "submission_support", intents: ["submission_help"], body: "Hello, how do I submit my video for the program?", summary: "영상 제출 방법 문의" },
  { key: "replied", minutesAgo: 2, caseId: "requirements_question", intents: ["brief_request"], body: "What are the content requirements?", summary: "콘텐츠 요건 문의" },
  { key: "settle", minutesAgo: 3, caseId: "settlement_dispute", intents: ["settlement_question", "complaint"], body: "I was not paid last month. Why?", summary: "정산 누락 주장" },
  { key: "aioff", minutesAgo: 4, caseId: "interest_next_steps", intents: ["interest"], body: "I want to join.", summary: "참여 의사", aiActive: false },
  { key: "fixedfee", minutesAgo: 5, caseId: "fixed_terms_inquiry", intents: ["custom_terms_proposal"], body: "We offer a sponsored video at a flat fee of 300 USD per video.", summary: "고정 단가 협찬 제안" },
  { key: "greeting", minutesAgo: 6, caseId: "confusion_or_short", intents: [], body: "hello dear", summary: "인사" },
  { key: "rate", minutesAgo: 7, caseId: "counter_offer_guideline_reply", intents: ["custom_terms_proposal"], body: "Could you raise my rate per video for my channel?", summary: "개별 단가 인상 요청" },
  { key: "summaryonly", minutesAgo: 8, caseId: "interest_next_steps", intents: ["interest"], body: "참여 의사 표시", summary: "참여 의사 표시" },
  { key: "thanks", minutesAgo: 9, caseId: "closing_acknowledgment", intents: ["closing"], body: "Thanks 👍", summary: "감사 인사" },
  { key: "review-new", minutesAgo: 10, caseId: "approval_status_inquiry", intents: ["approval_status"], body: "Hi, I applied already. Has my review been completed?", summary: "심사 완료 여부 재문의", email: "rb-e2e-review@example.test" },
  { key: "review-old", minutesAgo: 600, caseId: "approval_status_inquiry", intents: ["approval_status"], body: "I already applied. Is my review complete? Do you need more documents?", summary: "지원 후 심사 상태 문의", email: "rb-e2e-review@example.test" },
  { key: "drafted", minutesAgo: 12, caseId: "submission_support", intents: ["submission_help"], body: "Hi, where do I upload my video?", summary: "영상 업로드 위치 문의" },
  { key: "typed", minutesAgo: 13, caseId: "submission_support", intents: ["submission_help"], body: "How long should my video be?", summary: "영상 길이 문의" },
  { key: "multi-a", minutesAgo: 14, caseId: "submission_support", intents: ["submission_help"], body: "Newest thread: where do I submit?", summary: "최신 갈래 문의", email: "rb-e2e-multi@example.test" },
  { key: "multi-b", minutesAgo: 120, caseId: "requirements_question", intents: ["brief_request"], body: "Older thread: what are the requirements?", summary: "이전 갈래 문의", email: "rb-e2e-multi@example.test" },
  { key: "ourlast", minutesAgo: 11, caseId: "eligibility_question", intents: ["other"], body: "Am I eligible?", summary: "참여 자격 문의", lastMessageFrom: "human" },
];

const convId = (key: string) => `rb-e2e-c-${key}`;
const srcId = (key: string) => `rb-e2e-${key}-in01`;

async function seedBoard() {
  const base = Date.parse(NOW);
  for (const fixture of FIXTURES) {
    const at = new Date(base - fixture.minutesAgo * 60_000).toISOString();
    const email = fixture.email ?? `rb-e2e-${fixture.key}@example.test`;
    const senderHash = hash24(email);
    const lastMessageRef = fixture.lastMessageFrom === "human" ? `message_sources/rb-e2e-${fixture.key}-out01` : `message_sources/${srcId(fixture.key)}`;
    await commitDocument(`conversations/${convId(fixture.key)}`, {
      id: convId(fixture.key),
      threadId: convId(fixture.key),
      contextKey: `ctx-${convId(fixture.key)}`,
      creatorId: `rb-e2e-creator-${fixture.email ? fixture.email.split("@")[0] : fixture.key}`,
      creatorName: `Review Board ${fixture.key}`,
      creatorEmail: email,
      mailAccountId: "scp",
      orgId: "T056",
      aiActive: fixture.aiActive ?? true,
      hasCreatorReply: true,
      lastMessage: fixture.summary,
      lastMessageFrom: fixture.lastMessageFrom ?? "creator",
      lastMessageAtIso: fixture.lastMessageFrom === "human" ? new Date(Date.parse(at) + 30_000).toISOString() : at,
      lastInboundAtIso: at,
      updatedAtIso: at,
      // "typed" is scheduled so /chat's automatic AI draft never touches the composer in that test.
      autoReplyStatus: fixture.key === "drafted" ? "draft_only" : fixture.key === "typed" ? "scheduled" : "waiting_for_human",
      // Unread conversations: the deep-link auto mark-read WOULD fire for them on a normal open.
      ...(["final", "drafted", "typed", "multi-a", "multi-b"].includes(fixture.key) ? { unread: 2 } : {}),
      ...(fixture.key === "drafted" ? { autoReplyDraftText: "Existing saved draft (synthetic)." } : {}),
      lastMessageRef,
      ...(fixture.caseId ? { autoCaseId: fixture.caseId, autoCaseMessageRef: `message_sources/${srcId(fixture.key)}` } : {}),
      autoCaseIntentLabels: fixture.intents ?? [],
      autoCaseActorType: fixture.actorType ?? "creator",
    });
    await commitDocument(`message_sources/${srcId(fixture.key)}`, {
      id: srcId(fixture.key),
      conversationId: convId(fixture.key),
      direction: "inbound",
      receivedAtIso: at,
      body: fixture.body ?? "",
      summaryKr: fixture.summary,
      inboundSenderHash: senderHash,
      senderIdentityBinding: { status: "verified", inboundSenderHash: senderHash, bindingScope: "identity_only", reasonCode: "verified" },
    });
    await commitDocument(`conversations/${convId(fixture.key)}/messages/rb-msg-${fixture.key}`, {
      id: `rb-msg-${fixture.key}`,
      conversationId: convId(fixture.key),
      from: "creator",
      author: "Creator",
      summaryKr: fixture.summary,
      messageRef: `message_sources/${srcId(fixture.key)}`,
      createdAtIso: at,
      receivedAtIso: at,
    });
  }
  // A creator message WITH a real original text (≠ summary) — must NOT get the 요약본 badge.
  await commitDocument(`conversations/${convId("final")}/messages/rb-msg-final-original`, {
    id: "rb-msg-final-original",
    conversationId: convId("final"),
    from: "creator",
    author: "Creator",
    text: "Real original text (synthetic).",
    summaryKr: "원문이 있는 메시지 요약",
    createdAtIso: new Date(Date.parse(NOW) - 30 * 60_000).toISOString(),
    receivedAtIso: new Date(Date.parse(NOW) - 30 * 60_000).toISOString(),
  });
  // A confirmed real reply (Flu send on the creator thread) to the "replied" address, and a general
  // outreach (not a reply) to the review-status address.
  await commitDocument("message_sources/rb-e2e-replied-out01", {
    id: "rb-e2e-replied-out01",
    direction: "outbound",
    source: "sendEmail",
    sendMailAccountId: "scp",
    deliveryState: "sent",
    conversationId: convId("replied"),
    replyToMessageRef: `message_sources/${srcId("replied")}`,
    toHash: hash24("rb-e2e-replied@example.test"),
    sentAtIso: new Date(Date.parse(NOW) - 60_000).toISOString(),
  });
  await commitDocument("message_sources/rb-e2e-review-outreach01", {
    id: "rb-e2e-review-outreach01",
    direction: "outbound",
    campaignId: "rb-e2e-campaign",
    targetId: "rb-e2e-target",
    conversationId: "campaign-rb-e2e-campaign-x",
    deliveryState: "sent",
    toHash: hash24("rb-e2e-review@example.test"),
    sentAtIso: new Date(Date.parse(NOW) - 300 * 60_000).toISOString(),
  });
}

async function cleanupBoard() {
  for (const fixture of FIXTURES) {
    await deleteDocument(`conversations/${convId(fixture.key)}/messages`, `rb-msg-${fixture.key}`).catch(() => undefined);
    await deleteDocument("conversations", convId(fixture.key)).catch(() => undefined);
    await deleteDocument("message_sources", srcId(fixture.key)).catch(() => undefined);
  }
  await deleteDocument(`conversations/${convId("final")}/messages`, "rb-msg-final-original").catch(() => undefined);
  await deleteDocument("message_sources", "rb-e2e-replied-out01").catch(() => undefined);
  await deleteDocument("message_sources", "rb-e2e-review-outreach01").catch(() => undefined);
}

function trackForbidden(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && FORBIDDEN.test(request.url())) calls.push(request.url().split("/").pop() ?? "");
  });
  return calls;
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

async function boardShot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.getByTestId("review-board").screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

const row = (page: Page, key: string) => page.getByTestId(`review-row-${convId(key).slice(-6)}`).filter({ hasText: `Review Board ${key}` });

test.describe("chat auto review board", () => {
  test.beforeAll(seedBoard);
  test.afterAll(cleanupBoard);

  // Isolation: any request to a host other than loopback is aborted and recorded; each test asserts none.
  let blockedRemoteRequests: string[] = [];
  test.beforeEach(async ({ context }) => {
    blockedRemoteRequests = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) || url.protocol === "data:" || url.protocol === "blob:") return route.fallback();
      blockedRemoteRequests.push(`${url.protocol}//${url.hostname}`);
      return route.abort("blockedbyclient");
    });
  });
  test.afterEach(() => {
    console.log(`[review-board-e2e] blockedRemoteRequests=${blockedRemoteRequests.length}`);
    expect(blockedRemoteRequests, "no request may leave loopback").toEqual([]);
  });

  test("real callable: tabs, independent chips, protected/AI-off rows locked, draft review with lint, no writes", async ({ page }) => {
    const forbidden = trackForbidden(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAsAdmin(page, "/chat/auto");
    const board = page.getByTestId("review-board");
    await expect(board.getByTestId("review-board-list")).toBeVisible({ timeout: 60_000 });
    await expect(row(page, "final")).toBeVisible();
    await boardShot(page, "01-board-tabs-desktop");

    await expect(row(page, "final").getByTestId("chip-batch")).toContainText("마지막 안전 확인 대기");
    await expect(row(page, "replied").getByTestId("chip-batch")).toContainText("최근 14일 실제 회신");
    await expect(row(page, "replied").getByTestId("chip-question")).toContainText("미해결");
    await expect(row(page, "fixedfee").getByTestId("chip-next")).toContainText("답장 없이 제외");
    await expect(row(page, "greeting").getByTestId("chip-next")).toContainText("참여 안내 초안 검토");
    await expect(row(page, "rate").getByTestId("chip-next")).toContainText("정책 안내 초안 검토");
    await expect(row(page, "thanks").getByTestId("chip-next")).toContainText("종결 인사");
    await expect(row(page, "summaryonly").getByTestId("chip-next")).toContainText("원문 미확보");
    await expect(row(page, "ourlast").getByTestId("chip-batch")).toContainText("마지막 메시지가 우리 쪽");
    await expect(row(page, "aioff").getByTestId("row-summary-line")).toContainText("운영자 담당(AI off)");
    await expect(row(page, "settle").getByTestId("row-summary-line")).toContainText("보호 · 요약 비표시");
    const review = page.locator('[data-testid^="review-row-"]').filter({ hasText: "Review Board review-new" });
    await expect(review.getByTestId("chip-next")).toContainText("개인 심사 상태 확인(운영자)");
    await expect(review.getByTestId("chip-new-inbound")).toBeVisible();
    await expect(review.getByTestId("chip-claim")).toContainText("상대 주장(미확인)");

    // tabs filter on the send-batch state only
    await board.getByRole("tab", { name: /이번 발송 제외/ }).click();
    await expect(page).toHaveURL(/rb=excluded/);
    await expect(row(page, "final")).toHaveCount(0);
    await expect(row(page, "fixedfee")).toBeVisible();
    await boardShot(page, "02-board-tab-excluded");
    await board.getByRole("tab", { name: /^전체/ }).click();

    // expanded row with template + lint
    await row(page, "rate").getByTestId(`review-row-toggle-${convId("rate").slice(-6)}`).click();
    await expect(page).toHaveURL(/rbOpen=/);
    const detail = page.getByTestId(`review-detail-${convId("rate").slice(-6)}`);
    await expect(detail.getByTestId("template-text")).toContainText("Under our internal policy");
    await expect(detail.getByTestId("template-lint")).toContainText("기계 검사에서 해당 표현 미검출");
    await detail.getByTestId("system-default-reply").locator("summary").click();
    await expect(detail.getByTestId("system-default-lint")).toContainText("요건 미충족");
    await detail.scrollIntoViewIfNeeded();
    await detail.screenshot({ path: SHOT_DIR ? `${SHOT_DIR}/03-expanded-draft-lint.png` : undefined }).catch(() => undefined);

    // protected row: no template panel, no composer button
    await row(page, "settle").getByTestId(`review-row-toggle-${convId("settle").slice(-6)}`).click();
    const locked = page.getByTestId(`review-detail-${convId("settle").slice(-6)}`);
    await expect(locked.getByTestId("detail-draft-locked")).toBeVisible();
    await expect(locked.getByTestId("template-to-composer")).toHaveCount(0);
    await locked.scrollIntoViewIfNeeded();
    if (SHOT_DIR) await locked.screenshot({ path: `${SHOT_DIR}/04-protected-row-locked.png` });

    // narrow layout
    await page.setViewportSize({ width: 390, height: 844 });
    await board.scrollIntoViewIfNeeded();
    await shot(page, "05-board-390");
    expect(forbidden).toEqual([]);
  });

  test("loading, empty and error states; 2-page restore after visiting /chat and coming back", async ({ page }) => {
    const forbidden = trackForbidden(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    let mode: "slow" | "empty" | "error" | "paged" = "slow";
    const stubRow = (n: number) => ({
      rowKey: `c:rb-stub-${n}`,
      conversationId: `rb-stub-conv-${String(n).padStart(6, "0")}`,
      conversationTail: String(n).padStart(6, "0"),
      primaryCaseId: "submission_support",
      primaryCaseLabel: "Submission support",
      evidenceCaseIds: [],
      protected: false,
      protectedReasons: [],
      sendBatch: { bucket: "operator_judgment", reason: null, reasonLabel: null, allReasons: [] },
      nextAction: "operator_judgment",
      nextActionLabel: "운영자 판단",
      classification: { kind: "auto", label: "자동 추천(원문 규칙)" },
      claims: [],
      newInboundSinceJudgment: false,
      question: { status: "unresolved", label: "미해결 질문", questionCount: 1, recommendedHandling: "운영자가 판단해 직접 답하세요." },
      draft: { status: "none", draftAllowed: true, reason: "시스템 기본 답신 없음", caseId: null, label: "시스템 기본 답신 없음", sourceLabel: null, basisLabel: null, text: null, suggestedTemplateId: "B", sendable: false, sendableLabel: "전송 불가(검토 전용)" },
      summary: { status: "confirmed", value: `합성 요약 ${n}`, reason: null, source: "body", sourceLabel: "AI 요약 · 원문은 Chat 원문 보기에서" },
      realReplies: { status: "confirmed", value: 0, reason: null, latestAtIso: null, latestAfterInbound: false, possibleCount: 0, evidence: [] },
      queued: { status: "confirmed", value: false, reason: null },
      suppressed: { status: "confirmed", value: false, reason: null },
      aiActive: { status: "confirmed", value: true, reason: null },
      orgAutomationOff: false,
      identity: { status: "unknown", value: "missing", reason: "발신자 연결 기록 없음", fromMatches: false },
      registration: { status: "confirmed", value: "not_applicable", reason: null },
      latestInboundAtIso: new Date(Date.parse(NOW) - n * 60_000).toISOString(),
      lastMessageSide: "creator",
      creatorName: `Stub ${n}`,
      creatorHandle: null,
      creatorEmailMasked: "s***@example.test",
      programLabel: null,
      unknowns: [],
      grouping: { kind: "single_conversation", label: "대화 1개 · 발신자 묶음 근거 없음" },
      conversations: [{ conversationId: `rb-stub-conv-${String(n).padStart(6, "0")}`, conversationTail: String(n).padStart(6, "0"), primaryCaseId: "submission_support", primaryCaseLabel: "Submission support", latestInboundAtIso: null, protected: false }],
    });
    await page.route(/listChatAutoReviewBoard/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (mode === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        return route.fulfill({ json: { result: { ok: true, rows: [], counts: { conversations: 0, people: 0, protectedConversations: 0, byBucket: { excluded: 0, operator_judgment: 0, final_safety_wait: 0 } }, scanned: 0, nextCursor: null, exhausted: true, verifiedAtIso: NOW, behaviorLog: {} } } });
      }
      if (mode === "empty") return route.fulfill({ json: { result: { ok: true, rows: [], counts: { conversations: 0, people: 0, protectedConversations: 0, byBucket: { excluded: 0, operator_judgment: 0, final_safety_wait: 0 } }, scanned: 0, nextCursor: null, exhausted: true, verifiedAtIso: NOW, behaviorLog: {} } } });
      if (mode === "error") return route.fulfill({ status: 500, json: { error: { status: "INTERNAL", message: "synthetic" } } });
      const body = route.request().postDataJSON() as { data?: { cursor?: string } };
      const second = body?.data?.cursor === "page2";
      const rows = second ? Array.from({ length: 5 }, (_, i) => stubRow(30 + i)) : Array.from({ length: 25 }, (_, i) => stubRow(i + 1));
      return route.fulfill({ json: { result: { ok: true, rows, counts: { conversations: rows.length, people: rows.length, protectedConversations: 0, byBucket: { excluded: 0, operator_judgment: rows.length, final_safety_wait: 0 } }, scanned: rows.length, nextCursor: second ? null : "page2", exhausted: second, verifiedAtIso: NOW, behaviorLog: {} } } });
    });

    await loginAsAdmin(page, "/chat/auto");
    await expect(page.getByTestId("review-board-loading")).toBeVisible({ timeout: 30_000 });
    await boardShot(page, "06-state-loading");
    await expect(page.getByTestId("review-board-empty")).toBeVisible({ timeout: 30_000 });
    mode = "empty";
    await page.reload();
    await expect(page.getByTestId("review-board-empty")).toBeVisible({ timeout: 30_000 });
    await boardShot(page, "07-state-empty");
    mode = "error";
    await page.reload();
    await expect(page.getByTestId("review-board-error")).toBeVisible({ timeout: 30_000 });
    await boardShot(page, "08-state-error");
    await page.setViewportSize({ width: 390, height: 844 });
    await boardShot(page, "08b-state-error-390");
    await page.setViewportSize({ width: 1280, height: 900 });

    mode = "paged";
    await page.getByTestId("review-board-error").getByRole("button", { name: "다시 시도" }).click();
    await expect(page.getByTestId("review-board-list")).toBeVisible();
    await expect(page.getByTestId("review-board-partial")).toContainText("부분 조회 · 1페이지 · 더 있음");
    await boardShot(page, "11-partial-load-banner");
    // Back/forward between two board history entries restores EACH entry's scroll position.
    const scrollerTop = (set?: number) => page.evaluate((value) => {
      const board = document.querySelector('[data-testid="review-board"]');
      let node = board?.parentElement?.parentElement ?? null;
      while (node && node !== document.body) {
        const overflowY = getComputedStyle(node).overflowY;
        if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) break;
        node = node.parentElement;
      }
      const host = node && node !== document.body ? node : null;
      if (typeof value === "number") { if (host) host.scrollTop = value; else window.scrollTo({ top: value }); }
      return host ? host.scrollTop : window.scrollY;
    }, set);
    // top (0) <-> nonzero
    await scrollerTop(0);
    await page.waitForTimeout(600);
    await page.getByTestId("review-row-toggle-000003").click();
    await expect(page).toHaveURL(/rbOpen=/);
    await scrollerTop(900);
    await expect(page).toHaveURL(/rbY=9\d\d/, { timeout: 5_000 });
    await page.goBack();
    await expect.poll(() => scrollerTop(), { timeout: 5_000 }).toBeLessThan(5);
    await page.goForward();
    await expect.poll(() => scrollerTop(), { timeout: 5_000 }).toBeGreaterThan(800);
    await page.getByTestId("review-row-toggle-000003").click();
    // nonzero <-> nonzero
    await scrollerTop(300);
    await expect(page).toHaveURL(/rbY=3\d\d/, { timeout: 5_000 });
    await page.getByTestId("review-row-toggle-000005").click();
    await expect(page).toHaveURL(/rbOpen=/);
    await scrollerTop(1100);
    await expect(page).toHaveURL(/rbY=1\d{3}/, { timeout: 5_000 });
    await page.goBack();
    await expect.poll(() => scrollerTop(), { timeout: 5_000 }).toBeLessThan(500);
    await page.goForward();
    await expect.poll(() => scrollerTop(), { timeout: 5_000 }).toBeGreaterThan(900);
    await page.getByTestId("review-row-toggle-000005").click();
    await page.getByTestId("review-board-more").click();
    await expect(page.getByTestId("review-row-000032")).toBeVisible();
    await expect(page).toHaveURL(/rbPages=2/);
    await page.getByTestId("review-row-toggle-000032").click();
    await expect(page.getByTestId("review-detail-000032")).toBeVisible();
    await page.getByTestId("review-detail-000032").scrollIntoViewIfNeeded();
    await page.waitForTimeout(700); // scroll position is debounced into the URL
    await expect(page).toHaveURL(/rbY=\d+/);
    const href = await page.getByTestId("review-row-link-000032").getAttribute("href");
    expect(href).toBe("/chat?conversationId=rb-stub-conv-000032");
    await page.getByTestId("review-row-link-000032").click();
    await expect(page).toHaveURL(/\/chat\?conversationId=rb-stub-conv-000032/);
    const savedY = Number(new URL(page.url()).searchParams.get("rbY"));
    await page.goBack();
    await expect(page.getByTestId("review-detail-000032")).toBeVisible({ timeout: 30_000 });
    // Restored on the element that actually scrolls (app shell container or window).
    await expect.poll(() => page.evaluate(() => {
      const board = document.querySelector('[data-testid="review-board"]');
      let node = board?.parentElement?.parentElement ?? null;
      while (node && node !== document.body) {
        const overflowY = getComputedStyle(node).overflowY;
        if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node.scrollTop;
        node = node.parentElement;
      }
      return window.scrollY;
    }), { timeout: 10_000 }).toBeGreaterThan(Math.max(0, savedY - 40));
    expect(forbidden).toEqual([]);
  });

  test("/chat deep link, 다른 대화 tag, 요약본 badge and template hand-off to the existing composer", async ({ page }) => {
    const forbidden = trackForbidden(page);
    const sideEffects: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /markConversationRead|gatewayProxy|previewEmailDraft/.test(request.url())) sideEffects.push(request.url().split("/").pop() ?? "");
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    let messageDelayMs = 3000;
    await page.route(/listConversationMessages/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      // (a) delayed message loading: the prefill must wait for the reply-source scope to settle.
      if (messageDelayMs) await new Promise((resolve) => setTimeout(resolve, messageDelayMs));
      const response = await route.fetch();
      const payload = await response.json();
      const result = payload.result ?? {};
      const key = Array.isArray(result.rows) ? "rows" : Array.isArray(result.messages) ? "messages" : null;
      if (key) {
        result[key] = [
          ...result[key],
          { id: "rb-msg-other", conversationId: "rb-e2e-other-thread-abc123", from: "human", author: "운영자", text: "Earlier reply from another thread.", createdAtIso: new Date(Date.parse(NOW) - 3600_000).toISOString() },
        ];
      }
      await route.fulfill({ response, json: payload });
    });
    const composer = page.getByPlaceholder(/메시지 입력/);
    const openTemplate = async (key: string) => {
      await expect(row(page, key)).toBeVisible({ timeout: 60_000 });
      await row(page, key).getByTestId(`review-row-toggle-${convId(key).slice(-6)}`).click();
      const detail = page.getByTestId(`review-detail-${convId(key).slice(-6)}`);
      await expect(detail.getByTestId("template-text")).toBeVisible({ timeout: 30_000 });
      await detail.getByTestId("template-to-composer").click();
      await expect(page).toHaveURL(new RegExp(`/chat\\?conversationId=${convId(key)}`));
    };

    await loginAsAdmin(page, "/chat/auto");
    await openTemplate("final");
    await expect(composer).toHaveValue(/Super Creator Partners Team/, { timeout: 60_000 });
    await expect(page).not.toHaveURL(/prefill=/);
    await expect(page.getByTestId("message-summary-badge").first()).toBeVisible();
    await expect(page.getByTestId("message-other-conversation").first()).toContainText("다른 대화 …abc123");
    await expect(page.locator("div.group").filter({ hasText: "Real original text (synthetic)." }).getByTestId("message-summary-badge")).toHaveCount(0);
    await page.waitForTimeout(3000); // past the 1.5s automatic-draft timer
    expect(sideEffects, "a review hand-off must not mark read or auto-draft").toEqual([]);
    await shot(page, "09-chat-deeplink-prefill-tags");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "10-chat-390");
    await page.setViewportSize({ width: 1440, height: 1000 });

    // (c) reload after consumption never re-applies the template. This reload is a NORMAL deep-link
    // open of the same unread conversation — the control case: the existing auto mark-read still fires.
    messageDelayMs = 0;
    const markRead = page.waitForRequest((request) => request.method() === "POST" && /markConversationRead/.test(request.url()), { timeout: 30_000 });
    await page.reload();
    await expect(page.getByTestId("message-summary-badge").first()).toBeVisible({ timeout: 60_000 });
    await markRead;
    await page.waitForTimeout(2500);
    await expect(composer).not.toHaveValue(/Super Creator Partners Team/);
    sideEffects.length = 0;

    // (b) a composer that already holds text asks first: cancel keeps it, accept replaces it.
    await page.goto("/chat/auto");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await openTemplate("drafted");
    await expect(composer).toHaveValue("Existing saved draft (synthetic).", { timeout: 60_000 });
    await page.waitForTimeout(1500);
    await expect(composer).toHaveValue("Existing saved draft (synthetic).");
    await page.goto("/chat/auto");
    page.once("dialog", (dialog) => void dialog.accept());
    await openTemplate("drafted");
    await expect(composer).toHaveValue(/Super Creator Partners Team/, { timeout: 60_000 });
    await page.waitForTimeout(2000);
    expect(sideEffects, "hand-offs to the saved-draft conversation never mark read or auto-draft").toEqual([]);
    expect(forbidden).toEqual([]);
  });

  test("unsaved TYPED composer text: a hand-off asks first — cancel keeps it exactly, accept replaces; no save/send/read calls", async ({ page }) => {
    const forbidden = trackForbidden(page);
    const sideEffects: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /markConversationRead|gatewayProxy|previewEmailDraft/.test(request.url())) sideEffects.push(request.url().split("/").pop() ?? "");
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const target = convId("typed");
    // Arrive as a hand-off with an already-consumed nonce, so this open is review-only (no mark-read).
    await loginAsAdmin(page, "/chat/auto");
    await page.evaluate((id) => {
      window.sessionStorage.setItem("flu.composerPrefill.v1", JSON.stringify({ conversationId: id, nonce: "seed0", templateId: "A", text: "", createdAtMs: Date.now() }));
    }, target);
    await page.goto(`/chat?conversationId=${encodeURIComponent(target)}&prefill=seed0`);
    const composer = page.getByPlaceholder(/메시지 입력/);
    await expect(page.getByTestId("message-summary-badge").first()).toBeVisible({ timeout: 60_000 });
    await composer.fill("My unsaved note (synthetic).");
    const handOff = async (nonce: string) => {
      await page.evaluate(({ id, n }) => {
        window.sessionStorage.setItem("flu.composerPrefill.v1", JSON.stringify({ conversationId: id, nonce: n, templateId: "A", text: "Hi :)\n\nTemplate body (synthetic).\n\nBest regards,\nSuper Creator Partners Team", createdAtMs: Date.now() }));
        window.history.pushState(null, "", `/chat?conversationId=${encodeURIComponent(id)}&prefill=${n}`);
      }, { id: target, n: nonce });
    };
    const dismissed = page.waitForEvent("dialog").then(async (dialog) => {
      expect(dialog.message()).toBe("작성 중인 내용을 선택한 템플릿으로 바꿀까요?");
      await dialog.dismiss();
    });
    await handOff("n1");
    await dismissed;
    await page.waitForTimeout(800);
    await expect(composer).toHaveValue("My unsaved note (synthetic).");
    const accepted = page.waitForEvent("dialog").then((dialog) => dialog.accept());
    await handOff("n2");
    await accepted;
    await expect(composer).toHaveValue(/Template body \(synthetic\)\./);
    await page.waitForTimeout(2500);
    expect(sideEffects).toEqual([]);
    expect(forbidden).toEqual([]);
  });

  test("person tab reply-target invariant: chip === composer context at every step; the deep-linked strand never comes back after user intent", async ({ page }) => {
    const forbidden = trackForbidden(page);
    const handOffSideEffects: string[] = [];
    let trackHandOff = true;
    page.on("request", (request) => {
      if (trackHandOff && request.method() === "POST" && /markConversationRead|gatewayProxy|previewEmailDraft/.test(request.url())) handOffSideEffects.push(request.url().split("/").pop() ?? "");
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const A = convId("multi-a"); // room default (newest)
    const B = convId("multi-b"); // older strand = deep-link target
    const chip = page.getByTestId("person-reply-target-chip");
    const context = page.getByTestId("chat-composer-context");
    const expectTarget = async (step: string, id: string) => {
      await expect(chip, `${step}: chip`).toHaveAttribute("data-target-strand", new RegExp(id), { timeout: 30_000 });
      await expect(context, `${step}: composer`).toHaveAttribute("data-compose-conversation", id);
    };
    const strandBar = page.getByTestId("person-strand-bar");

    await loginAsAdmin(page, "/chat/auto");
    await page.evaluate((id) => {
      window.sessionStorage.setItem("flu.composerPrefill.v1", JSON.stringify({ conversationId: id, nonce: "multi1", templateId: "B", text: "Hi,\n\nStrand B template (synthetic).\n\nBest regards,\nSuper Creator Partners Team", createdAtMs: Date.now() }));
    }, B);
    await page.goto(`/chat?conversationId=${encodeURIComponent(B)}&prefill=multi1`);
    const composer = page.getByPlaceholder(/메시지 입력/);
    await expect(composer).toHaveValue(/Strand B template \(synthetic\)\./, { timeout: 60_000 });
    await expectTarget("1 deep link B", B);
    await page.waitForTimeout(3000);
    expect(handOffSideEffects, "the hand-off itself marks nothing read and runs no auto draft").toEqual([]);
    await shot(page, "12-chat-person-nondefault-strand");
    trackHandOff = false;

    const steps: Array<[string, () => Promise<void>, string]> = [
      ["2a bubble 'reply to this' → A", async () => { await page.locator("div.group").filter({ hasText: "최신 갈래 문의" }).getByRole("button", { name: "이 갈래로 답장" }).first().click(); }, A],
      ["2b list tab Direct → 전체", async () => {
        await page.getByRole("tab", { name: /^Direct/ }).click();
        await page.getByRole("tab", { name: /^전체/ }).first().click();
        await expect(strandBar).toBeVisible({ timeout: 30_000 });
      }, A],
      ["2c filter change (반응 온 사람/콜드 포함)", async () => { await page.getByRole("button", { name: /콜드 포함/ }).click(); }, A],
      ["2 menu → A", async () => { await chip.click(); await page.getByTestId("person-reply-target-menu").locator(`[data-strand-key*="${A}"]`).click(); }, A],
      ["3 전체", async () => { await strandBar.getByRole("button", { name: /^전체/ }).click(); }, A],
      ["4 filter B", async () => { await strandBar.locator(`[data-strand-key*="${B}"]`).click(); }, B],
      ["5 전체 again (deep link already consumed)", async () => { await strandBar.getByRole("button", { name: /^전체/ }).click(); }, A],
      ["6 same-person link → A", async () => { await page.evaluate((id) => window.history.pushState(null, "", `/chat?conversationId=${encodeURIComponent(id)}`), A); }, A],
      ["7 same-person link → B", async () => { await page.evaluate((id) => window.history.pushState(null, "", `/chat?conversationId=${encodeURIComponent(id)}`), B); }, B],
      ["8 전체 after the new link", async () => { await strandBar.getByRole("button", { name: /^전체/ }).click(); }, A],
      ["9 reopen (reload of the B link)", async () => { await page.reload(); }, B],
    ];
    for (const [step, act, id] of steps) {
      await act();
      await expectTarget(step, id);
    }
    expect(forbidden).toEqual([]);
  });

  test("390px /chat: a hand-off opens the conversation full width with the prefilled composer; ← 목록 returns to the list; no horizontal scroll", async ({ page }) => {
    const forbidden = trackForbidden(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const target = convId("typed");
    await loginAsAdmin(page, "/chat/auto");
    await page.evaluate((id) => {
      window.sessionStorage.setItem("flu.composerPrefill.v1", JSON.stringify({ conversationId: id, nonce: "mob1", templateId: "B", text: "Hi,\n\nMobile template (synthetic).\n\nBest regards,\nSuper Creator Partners Team", createdAtMs: Date.now() }));
    }, target);
    // Board template review at 390: the template text block is (nearly) full width.
    await expect(row(page, "final")).toBeVisible({ timeout: 60_000 });
    await row(page, "final").getByTestId(`review-row-toggle-${convId("final").slice(-6)}`).click();
    const detailPanel = page.getByTestId(`review-detail-${convId("final").slice(-6)}`);
    const templateText = detailPanel.getByTestId("template-text");
    await expect(templateText).toBeVisible();
    // Fits its container: not wider than the detail panel, no horizontal overflow on the panel itself.
    const [textBox, panelBox] = [await templateText.boundingBox(), await detailPanel.boundingBox()];
    expect((textBox?.width ?? 0)).toBeLessThanOrEqual((panelBox?.width ?? 0) + 1);
    // Report every descendant that sticks out of the panel (tag/testid/class + overflow px) if any.
    const offenders = await detailPanel.evaluate((panel) => {
      const right = panel.getBoundingClientRect().right;
      return [...panel.querySelectorAll("*")]
        .map((el) => ({ el, over: Math.round(el.getBoundingClientRect().right - right) }))
        .filter(({ over }) => over > 1)
        .slice(0, 8)
        .map(({ el, over }) => `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? ""}] .${String(el.getAttribute("class") ?? "").slice(0, 60)} +${over}px`);
    });
    expect(offenders, "no element overflows the detail panel at 390px").toEqual([]);
    expect(await detailPanel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await templateText.scrollIntoViewIfNeeded();
    await shot(page, "05b-board-390-template");
    await page.goto(`/chat?conversationId=${encodeURIComponent(target)}&prefill=mob1`);
    const pane = page.getByTestId("chat-conversation-pane");
    await expect(pane).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("chat-list-pane")).toBeHidden();
    const composer = page.getByPlaceholder(/메시지 입력/);
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(/Mobile template \(synthetic\)\./, { timeout: 60_000 });
    expect((await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
    // Readable and editable: typed text lands in the textarea and the textarea is not clipped by the viewport.
    await composer.click();
    await composer.pressSequentially(" Typed on mobile.");
    await expect(composer).toHaveValue(/Typed on mobile\./);
    await expect(composer).toHaveValue(/Mobile template \(synthetic\)\./);
    const box = await composer.boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 391).toBe(true);
    const paneBox = await pane.boundingBox();
    expect(paneBox?.width ?? 0).toBeGreaterThan(350);
    const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(await noHorizontalScroll()).toBe(true);
    await shot(page, "10-chat-390-conversation");
    await page.getByTestId("chat-mobile-back").click();
    await expect(page.getByTestId("chat-list-pane")).toBeVisible();
    await expect(pane).toBeHidden();
    expect(await noHorizontalScroll()).toBe(true);
    await shot(page, "10-chat-390-list");
    expect(forbidden).toEqual([]);
  });
});
