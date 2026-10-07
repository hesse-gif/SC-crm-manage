import { expect, test, type Page } from "@playwright/test";
import { commitDocument, deleteDocument, loginAsAdmin } from "./helpers/emulator";

// 0.6.104 live fix: the default 사람 처리 필요 view hides OFF cases with nothing pending, and the
// emulator seed has no pending conversations — tests that drive specific case rows switch to 전체.
async function showAllCasebookEntries(page: Page) {
  const allTab = page.getByTestId("casebook-inbox-filter").getByRole("tab", { name: /^전체/ });
  await expect(allTab).toBeVisible({ timeout: 30_000 });
  await allTab.click();
  await expect(allTab).toHaveAttribute("aria-selected", "true");
}

const KNOWN_CASE_IDS = new Set([
  "interest_next_steps",
  "submission_support",
  "requirements_question",
  "eligibility_question",
  "reward_overview",
]);

const waitForPermitStatusResponse = (page: Page) =>
  page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes("getChatAutoCasePermitStatus")
  );

// Codex adversarial review round 9 (2026-09-28): /chat/auto's casebook console was simplified to
// call ONE read callable, getChatAutoCasebookSnapshot (see functions/chatAutoCasePermitCallables.ts)
// — it replaces the old getChatAutoCasePermitStatus/getChatAutoCaseSendHistory/
// getChatAutoCaseUnhandledStats trio for that page specifically. getChatAutoCasePermitStatus itself
// is unchanged and still used directly by /admin/verify (waitForPermitStatusResponse above stays
// correct for that). The snapshot's rows carry the same caseId/state/armed shape
// (ChatAutoCasebookSnapshotRow is `Omit<ChatAutoCasePermitStatusRow, "replyText"> & {...}`), so
// findKnownDefaultOffRow below still applies unchanged.
const waitForCasebookSnapshotResponse = (page: Page) =>
  page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes("getChatAutoCasebookSnapshot")
  );

function findKnownDefaultOffRow(rows: Array<{ caseId?: string; state?: string; armed?: boolean }>) {
  return rows.find((row) =>
    typeof row.caseId === "string" &&
    KNOWN_CASE_IDS.has(row.caseId) &&
    row.state === "default_off" &&
    row.armed === false
  );
}

test.describe("chat auto permit UI", () => {
  test("completed cached counts show integers and incomplete snapshots never imply an exact zero", async ({ page }) => {
    let exact = true;
    await page.route(/getChatAutoCasebookSnapshot/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      expect(response.ok()).toBe(true);
      expect(payload.result.ok).toBe(true);
      payload.result.pendingTotal = {
        count: exact ? 1203 : 0,
        exact, countStatus: exact ? "exact" : "unknown", truncated: false,
        status: "fresh", computedAtIso: "2026-09-30T00:00:00.000Z",
        asOfIso: "2026-09-30T00:00:00.000Z",
      };
      // Server rule: needsHuman = pending > 0 || armed_unhealthy || count not proven exact.
      payload.result.rows = payload.result.rows.map((row: { caseId: string; attention?: { autoReply: string; reasons: string[] } }) => {
        const pendingCount = exact && row.caseId === "confusion_or_short" ? 17 : 0;
        return {
          ...row, pendingCount,
          attention: { autoReply: row.attention?.autoReply ?? "off", reasons: row.attention?.reasons ?? [], needsHuman: pendingCount > 0 || row.attention?.autoReply === "armed_unhealthy" || !exact },
        };
      });
      await route.fulfill({ response, json: payload });
    });
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const headline = page.getByTestId("pending-headline-card");
    await expect(headline.getByTestId("pending-headline-count")).toHaveText("1203");
    await expect(headline.getByTestId("pending-headline-computed-at")).toContainText("기준");
    await expect(page.getByTestId("permit-case-confusion_or_short")).toContainText("17건");
    await expect(headline).not.toContainText("1203+");
    exact = false;
    await page.reload();
    // Unknown counts: OFF zero-count case rows must be visible on the DEFAULT 사람 처리 필요 tab
    // (no switch to 전체) — an unknown backlog is never hidden.
    await expect(page.getByTestId("casebook-inbox-filter").getByRole("tab", { name: /^사람 처리 필요/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(headline.getByTestId("pending-headline-computing")).toBeVisible();
    await expect(headline.getByTestId("pending-headline-count")).toHaveCount(0);
    await expect(page.getByTestId("permit-case-confusion_or_short")).toContainText("집계 중");
    await expect(page.getByTestId("casebook-filter-empty")).toHaveCount(0);
  });

  test("Korean case explanation, unsaved AI opinion, and revision-checked human reply save/reset are wired", async ({ page }) => {
    test.setTimeout(120_000);
    const caseId = "confusion_or_short";
    const suggestionText = "Hi:)\n\nCould you clarify which part of the program you would like help with?\n\nBest regards,\nSupercent";
    const saves: unknown[] = [];
    await page.route(/suggestChatAutoCaseReply/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: {
        ok: true, caseId, text: suggestionText, reason: "뜻이 불분명한 문의이므로 내용을 먼저 확인합니다.",
        provider: "vertex", modelId: "gemini-3.1-flash-lite", transport: "vertex_direct", cacheHit: true,
      } }) });
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("saveChatAutoCaseReply")) saves.push(request.postDataJSON());
    });
    try {
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const row = page.getByTestId(`permit-case-${caseId}`);
      await expect(row.getByRole("heading", { name: "내용 확인 필요" })).toBeVisible({ timeout: 20_000 });
      await expect(row).toContainText("짧거나 뜻이 불분명");
      const blockedRow = page.getByTestId("permit-case-opt_out_or_legal");
      await expect(blockedRow.getByTestId("case-reply-toggle-opt_out_or_legal")).toHaveCount(0);
      await row.getByTestId(`case-reply-toggle-${caseId}`).click();
      await row.getByTestId(`case-reply-instruction-${caseId}`).fill("불명확한 내용을 정중하게 되물어 주세요.");
      await row.getByTestId(`case-reply-suggest-${caseId}`).click();
      const opinion = row.getByTestId(`case-reply-suggestion-${caseId}`);
      await expect(opinion).toContainText("이렇게 답장할까요?");
      await expect(opinion).toContainText("Vertex AI");
      await expect(opinion).toContainText("저장된 제안");
      expect(saves).toHaveLength(0);
      await row.getByTestId(`case-reply-apply-suggestion-${caseId}`).click();
      await expect(row.getByTestId(`case-reply-text-${caseId}`)).toHaveValue(suggestionText);
      expect(saves).toHaveLength(0);
      const saveResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("saveChatAutoCaseReply"));
      await row.getByTestId(`case-reply-save-${caseId}`).click();
      const saveResponse = await saveResponsePromise;
      expect(saveResponse.ok()).toBe(true);
      const saved = (await saveResponse.json()).result;
      expect(saved.ok).toBe(true);
      expect(saved.replyText).toMatchObject({ text: suggestionText, source: "operator_override", reviewRequired: true, automaticStatus: "human_review_only" });
      expect(saved.replyText.revision).toBeGreaterThan(0);
      expect(saves).toHaveLength(1);
      await page.reload();
      await showAllCasebookEntries(page);
      await row.getByTestId(`case-reply-toggle-${caseId}`).click();
      await expect(row.getByTestId(`case-reply-text-${caseId}`)).toHaveValue(suggestionText);
      await expect(row.getByRole("button", { name: "자동발송 켜기", exact: true })).toBeDisabled();
      await row.getByRole("button", { name: "기본 답신 문구로 되돌리기", exact: true }).click();
      const resetResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("resetChatAutoCaseReply"));
      await row.getByTestId(`case-reply-reset-confirm-${caseId}`).click();
      const resetResponse = await resetResponsePromise;
      expect(resetResponse.ok()).toBe(true);
      expect((await resetResponse.json()).result.replyText.source).not.toBe("operator_override");
    } finally {
      // Emulator-only test data; avoid changing later lanes' reply policy.
      await deleteDocument("chat_auto_case_replies", "config");
    }
  });

  test("ViewAs stays read-only until the super admin returns to their own console", async ({ page }) => {
    await commitDocument("members/flu-emulator-growth-manager", {
      uid: "flu-emulator-growth-manager", email: "test-growth-manager@demo-flu",
      role: "manager", team: "Growth", status: "active", name: "Growth QA",
    });
    const initialSnapshotPromise = waitForCasebookSnapshotResponse(page);
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    expect((await initialSnapshotPromise).ok()).toBe(true);
    await expect(page.getByTestId("permit-chat-auto-ui").locator('[data-testid^="permit-case-"]')).toHaveCount(20);
    await page.evaluate(() => {
      sessionStorage.setItem("flu.viewAs.target", JSON.stringify({
        userId: "flu-emulator-growth-manager",
        email: "test-growth-manager@demo-flu",
        name: "Growth QA",
      }));
    });
    const consoleRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /getChatAutoCasebookSnapshot|listChatAutoCasebookUnclassified|previewChatAutoCaseReply|setChatAutoCasePermitArming|runChatAutoCasePermitEval|updateAutoReply/.test(request.url())) {
        consoleRequests.push(request.url());
      }
    });
    await page.reload();
    const blocked = page.getByTestId("casebook-view-as-blocked");
    await expect(blocked).toBeVisible();
    await expect(page.getByTestId("permit-chat-auto-ui")).toHaveCount(0);
    await expect(page.getByRole("switch").first()).toBeDisabled();
    expect(consoleRequests).toEqual([]);

    const snapshotPromise = waitForCasebookSnapshotResponse(page);
    await blocked.getByRole("button", { name: "내 슈퍼어드민 화면으로 돌아가기" }).click();
    const response = await snapshotPromise;
    expect(response.ok()).toBe(true);
    expect((await response.json()).result?.ok).toBe(true);
    expect(response.request().postDataJSON().data).not.toHaveProperty("viewAsUserId");
    expect(response.request().postDataJSON().data).not.toHaveProperty("viewAsEmail");
    await expect(page.getByTestId("permit-chat-auto-ui")).toBeVisible();
    await expect(blocked).toHaveCount(0);
    await expect(page.getByRole("switch").first()).toBeEnabled();
    expect(await page.evaluate(() => sessionStorage.getItem("flu.viewAs.target"))).toBeNull();
    expect(consoleRequests.every((url) => url.includes("getChatAutoCasebookSnapshot"))).toBe(true);
  });

  test("status page renders real permit callable state without exposing private evidence", async ({ page }) => {
    const snapshotResponsePromise = waitForCasebookSnapshotResponse(page);

    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const statusResponse = await snapshotResponsePromise;
    const statusPayload = await statusResponse.json() as {
      result?: {
        ok?: boolean;
        rows?: Array<{ caseId?: string; state?: string; armed?: boolean }>;
        pendingTotal?: { count?: number; truncated?: boolean; status?: string; computedAtIso?: string | null };
      };
    };
    const rows = statusPayload.result?.rows ?? [];
    const defaultOffRow = findKnownDefaultOffRow(rows);

    expect(statusResponse.ok()).toBe(true);
    expect(statusPayload.result?.ok).toBe(true);
    expect(defaultOffRow).toMatchObject({
      state: "default_off",
      armed: false,
    });

    // Casebook snapshot 504 hotfix (2026-09-29): the callable must resolve WITHOUT ever running the
    // unreplied-inbox scan itself — it only ever reads a precomputed doc. In this emulator, the
    // scheduled precompute (chatAutoCasebookPendingPrecomputeSchedule) never ran, so no doc exists
    // yet for any scope: pendingTotal.status must be "missing", never a value that implies a live
    // scan happened, and the callable must still have resolved fast enough for the page to render.
    expect(statusPayload.result?.pendingTotal?.status).toBe("missing");
    expect(statusPayload.result?.pendingTotal?.computedAtIso).toBeNull();

    const panel = page.getByTestId("permit-chat-auto-ui");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText("케이스별 자동발송");
    await expect(panel).toContainText("승인 발송");
    await expect(panel).toContainText("기본 꺼짐");
    await expect(panel.getByTestId("permit-status-error")).toHaveCount(0);
    await expect(panel).not.toContainText(/rawPrompt|privateIntent|providerTrace|rawResponse|apiKey|secret/i);

    // The pending headline must show the "계산 중" placeholder, never a red error banner, when no
    // precomputed doc exists yet (missing is not a failure state).
    const pendingHeadline = page.getByTestId("pending-headline-card");
    await expect(pendingHeadline).toBeVisible();
    await expect(pendingHeadline.getByTestId("pending-headline-computing")).toBeVisible();
    await expect(pendingHeadline.locator('[role="alert"]')).toHaveCount(0);
  });

  test("verify console can call the sanitized permit status callable", async ({ page }) => {
    await loginAsAdmin(page, "/chat/auto");
    await page.goto("/admin/verify");

    const row = page.getByTestId("row-getChatAutoCasePermitStatus");
    await expect(row).toBeVisible({ timeout: 20_000 });

    const statusResponsePromise = waitForPermitStatusResponse(page);
    await row.getByTestId("run-getChatAutoCasePermitStatus").click();
    const statusResponse = await statusResponsePromise;
    const statusPayload = await statusResponse.json() as {
      result?: { ok?: boolean; rows?: Array<{ caseId?: string; state?: string }> };
    };

    expect(statusResponse.ok()).toBe(true);
    expect(statusPayload.result?.ok).toBe(true);
    expect(findKnownDefaultOffRow(statusPayload.result?.rows ?? [])).toMatchObject({
      state: "default_off",
      armed: false,
    });
    await expect(row.getByTestId("status-getChatAutoCasePermitStatus")).toContainText("성공", { timeout: 20_000 });
    await expect(row.getByTestId("output-getChatAutoCasePermitStatus")).toContainText('"ok": true');
    await expect(row.getByTestId("output-getChatAutoCasePermitStatus")).not.toContainText(/rawPrompt|privateIntent|providerTrace|rawResponse|apiKey|secret/i);
  });

  test("read-only preview cannot run verification or change case send settings", async ({ page }) => {
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);

    const sidebar = page.getByTestId("app-sidebar");
    await sidebar.getByRole("button").filter({ hasText: /Super Admin|Admin|Manager/ }).click();
    await page.getByRole("button", { name: "Viewer" }).click();

    const panel = page.getByTestId("permit-chat-auto-ui");
    await expect(panel).toContainText("조회 전용");
    await showAllCasebookEntries(page);
    await expect.poll(async () => {
      const verifyButtons = await panel.getByRole("button", { name: "최신 검증 실행" }).count();
      const statusErrors = await panel.getByTestId("permit-status-error").count();
      return verifyButtons + statusErrors;
    }).toBeGreaterThan(0);

    if (await panel.getByRole("button", { name: "최신 검증 실행" }).count() > 0) {
      await expect(panel.getByRole("button", { name: "최신 검증 실행" }).first()).toBeDisabled();
      await expect(panel.getByRole("button", { name: /자동발송 켜기|자동발송 끄기/ }).first()).toBeDisabled();
    } else {
      await expect(panel.getByTestId("permit-status-error")).toHaveCount(1);
    }
  });

  // "보류 N건 지금 보내기" (case-backlog-send, 2026-09-28): functions/chatAutoCaseBacklogSend.ts
  // requires the case be ARMED before any real send, and PermitCasePanel.tsx only renders the
  // "보류 확인"/"지금 보내기" control for row.armed rows. No case in this emulator seed is armed
  // (arming needs a passed eval + approval-count floor, out of scope for this fixture), so this
  // proves the negative — the control must not render at all for a known default_off/unarmed case.
  test("case-backlog-send: the '보류 확인' control never renders for a case that is not armed", async ({ page }) => {
    const snapshotResponsePromise = waitForCasebookSnapshotResponse(page);

    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const statusResponse = await snapshotResponsePromise;
    const statusPayload = await statusResponse.json() as {
      result?: { ok?: boolean; rows?: Array<{ caseId?: string; state?: string; armed?: boolean }> };
    };
    const rows = statusPayload.result?.rows ?? [];
    const defaultOffRow = findKnownDefaultOffRow(rows);
    expect(defaultOffRow).toMatchObject({ state: "default_off", armed: false });
    const caseId = defaultOffRow?.caseId;
    expect(typeof caseId).toBe("string");

    const panel = page.getByTestId("permit-chat-auto-ui");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const row = page.getByTestId(`permit-case-${caseId}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId(`permit-case-backlog-send-${caseId}`)).toHaveCount(0);
    await expect(row.getByText("보류 확인")).toHaveCount(0);
    await expect(row.getByText("지금 보내기")).toHaveCount(0);
  });
});


// ── Casebook inbox UI (2026-10-01) ─────────────────────────────────────────────────────────────
// UI behaviour for the explained total, the sort, the view filter, the 미분류 entry, the default
// suggestion, link insertion, preview and unsaved-text safety. The real emulator snapshot supplies
// the 19 rows (revision hashes, replyText, canonical order); the contract §1 additions are layered
// on top by a route handler, and the two new read callables are fulfilled by route handlers, so
// these run without the AGG/SUGGEST backend lanes merged. Real-backend wiring (the snapshot actually
// carrying these fields, listChatAutoCasebookUnclassified, previewChatAutoCaseReply, the precompute
// docs) is the integrator's post-merge check: AGG lane → pendingBreakdown/attention/unclassified list,
// SUGGEST lane → defaultSuggestion/allowedLinkTokens/replyLinkCatalog/preview.
const INBOX_JSON = { contentType: "application/json" } as const;

type InboxFixture = {
  counts?: Record<string, number>;
  attention?: Record<string, { autoReply: string; needsHuman: boolean; reasons?: string[] }>;
  suggestions?: Record<string, { status: string; text?: string | null; generatedAtIso?: string | null; modelId?: string | null }>;
  unclassified?: { total: number; byReason: Record<string, number>; neverClassifiedBeforeStampLaunch?: number | null };
  closed?: number;
  allowedTokens?: string[];
  noReplyNeeded?: { total: number; byCaseId: Record<string, number> };
};

function applyInboxFixture(result: any, fixture: InboxFixture) {
  const now = new Date().toISOString();
  const rows = result.rows as any[];
  for (const row of rows) {
    row.pendingCount = fixture.counts?.[row.caseId] ?? 0;
    // Same rule as the server: an OFF case needs a human only when conversations are waiting.
    row.attention = fixture.attention?.[row.caseId] ?? { autoReply: "off", needsHuman: row.pendingCount > 0, reasons: ["not_armed"] };
    row.allowedLinkTokens = fixture.allowedTokens ?? ["GUIDE_LINK", "APPLY_LINK"];
    row.defaultSuggestion = fixture.suggestions?.[row.caseId] ?? { status: "not_applicable", text: null, generatedAtIso: null, modelId: null };
  }
  const managed = rows.reduce((sum, row) => sum + row.pendingCount, 0);
  const unclassified = fixture.unclassified ?? { total: 0, byReason: { never_classified: 0, unknown_case: 0, stale_stamp: 0 } };
  const closed = fixture.closed ?? 0;
  result.pendingTotal = {
    count: managed + unclassified.total + closed,
    exact: true, countStatus: "exact", truncated: false, status: "fresh", computedAtIso: now, asOfIso: now,
  };
  result.unclassifiedPendingCount = unclassified.total;
  result.pendingBreakdown = {
    status: "available", managedCaseTotal: managed, closedCaseCount: closed, unclassified,
    ...(fixture.noReplyNeeded ? { noReplyNeeded: fixture.noReplyNeeded } : {}),
  };
  result.replyLinkCatalog = [
    { token: "GUIDE_LINK", label: "Guide", url: "https://example.test/guide" },
    { token: "APPLY_LINK", label: "Apply", url: "https://example.test/apply" },
    { token: "SUBMIT_LINK", label: "Submit", url: "https://example.test/submit" },
    { token: "SAMPLE_LINK", label: "Sample", url: "https://example.test/sample" },
  ];
}

async function routeInboxSnapshot(page: Page, build: (result: any, requestData: any) => void) {
  await page.route(/getChatAutoCasebookSnapshot/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    build(payload.result, route.request().postDataJSON().data ?? {});
    await route.fulfill({ response, json: payload });
  });
}

// DOM order of the console's entries: case rows by caseId, 미분류 as "__unclassified__".
const inboxOrder = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid="casebook-unclassified"], [data-testid^="permit-case-"]'))
    .map((element) => element.getAttribute("data-testid") ?? "")
    .filter((id) => id === "casebook-unclassified" || (id.startsWith("permit-case-") && !id.startsWith("permit-case-backlog-send-")))
    .map((id) => (id === "casebook-unclassified" ? "__unclassified__" : id.slice("permit-case-".length))),
);

test.describe("casebook inbox UI", () => {
  test("total is explained, rows sort by pending count with canonical ties, and the filter never overwrites the total", async ({ page }) => {
    let canonical: string[] = [];
    const counts: Record<string, number> = { requirements_question: 40, interest_next_steps: 3, submission_support: 3 };
    await routeInboxSnapshot(page, (result) => {
      canonical = (result.rows as Array<{ caseId: string }>).map((row) => row.caseId);
      applyInboxFixture(result, {
        counts,
        attention: {
          eligibility_question: { autoReply: "healthy", needsHuman: false, reasons: [] },
          interest_next_steps: { autoReply: "armed_unhealthy", needsHuman: true, reasons: ["eval_expired", "pending_while_armed"] },
        },
        unclassified: { total: 287, byReason: { never_classified: 200, unknown_case: 50, stale_stamp: 37 } },
        closed: 7,
      });
    });
    await loginAsAdmin(page, "/chat/auto");

    // Explained total: 전체 대기 N건 = 케이스 M건 + 미분류 U건 (+ 종결 C건), as-of time kept.
    const headline = page.getByTestId("pending-headline-card");
    await expect(headline.getByTestId("pending-headline-count")).toHaveText("340");
    await expect(headline.getByTestId("pending-breakdown-equation")).toContainText("전체 대기 340건 = 케이스 46건 + 미분류 287건 (+ 종결 7건)");
    await expect(headline.getByTestId("pending-headline-computed-at")).toContainText("기준");
    await expect(headline).not.toContainText("발송 가능");

    // Default view = 사람 처리 필요: only entries with conversations waiting (or an armed-but-broken
    // auto reply) — the healthy case and every OFF case with nothing pending are hidden; 미분류 (287) leads.
    await expect(page.getByTestId("permit-case-eligibility_question")).toHaveCount(0);
    await expect(page.getByTestId("permit-case-reward_overview")).toHaveCount(0);
    expect(await inboxOrder(page)).toEqual(["__unclassified__", "requirements_question", "interest_next_steps", "submission_support"]);

    // Attention reasons are small Korean badges.
    await expect(page.getByTestId("permit-case-interest_next_steps")).toContainText("검증 만료");
    await expect(page.getByTestId("permit-case-interest_next_steps")).toContainText("자동답장 중 보류 3건");
    await expect(page.getByTestId("permit-case-requirements_question")).toContainText("자동답장 꺼짐");

    // The filter hides one case: both numbers are shown and the headline total is untouched.
    const summary = page.getByTestId("casebook-filter-summary");
    await expect(summary).toContainText(`필터로 ${canonical.length + 1 - 4}개를 숨겼습니다`);
    await expect(summary.getByTestId("casebook-filter-total")).toHaveText("전체 대기 340건");
    // 현재 보이는 합계 counts every visible entry, including 미분류: 287 + 40 + 3 + 3.
    await expect(summary.getByTestId("casebook-filter-visible-sum")).toHaveText("현재 보이는 합계 333건");
    await expect(headline.getByTestId("pending-headline-count")).toHaveText("340");

    await page.getByRole("tab", { name: /^자동답장 설정됨/ }).click();
    expect(await inboxOrder(page)).toEqual(["eligibility_question"]);
    await expect(summary.getByTestId("casebook-filter-total")).toHaveText("전체 대기 340건");
    await expect(summary.getByTestId("casebook-filter-visible-sum")).toHaveText("현재 보이는 합계 0건");
    await expect(headline.getByTestId("pending-headline-count")).toHaveText("340");

    await page.getByRole("tab", { name: /^전체/ }).click();
    expect((await inboxOrder(page)).length).toBe(canonical.length + 1);
    await expect(page.getByTestId("casebook-filter-summary")).toHaveCount(0);
  });

  test("답장 불필요: headline is 답장 필요 N (total kept in the explanation), its own tab, and hidden from the default view", async ({ page }) => {
    let oldServer = false;
    let stale = false;
    await routeInboxSnapshot(page, (result) => {
      if (oldServer) {
        applyInboxFixture(result, { counts: { out_of_office: 80, interest_next_steps: 30 }, closed: 11 });
        return;
      }
      if (stale) {
        // Server rule: a stale snapshot proves nothing, so the 부재중 row is not marked no_reply_needed.
        applyInboxFixture(result, {
          counts: { out_of_office: 80, interest_next_steps: 30 },
          unclassified: { total: 11, byReason: { never_classified: 11, unknown_case: 0, stale_stamp: 0 } },
          closed: 11,
          noReplyNeeded: { total: 91, byCaseId: { out_of_office: 80, closing_acknowledgment: 11 } },
        });
        const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        result.pendingTotal = { ...result.pendingTotal, status: "stale", computedAtIso: old, asOfIso: old };
        return;
      }
      applyInboxFixture(result, {
        counts: { out_of_office: 80, interest_next_steps: 30 },
        attention: { out_of_office: { autoReply: "off", needsHuman: false, reasons: ["no_reply_needed"] } },
        unclassified: { total: 11, byReason: { never_classified: 11, unknown_case: 0, stale_stamp: 0 } },
        closed: 11,
        noReplyNeeded: { total: 91, byCaseId: { out_of_office: 80, closing_acknowledgment: 11 } },
      });
    });
    await loginAsAdmin(page, "/chat/auto");
    const headline = page.getByTestId("pending-headline-card");
    // 132 = 80 + 30 + 11 unclassified + 11 closed; 답장 필요 = 132 − 91.
    await expect(headline.getByTestId("pending-headline-reply-needed-count")).toHaveText("41");
    await expect(headline.getByTestId("pending-no-reply-equation")).toHaveText("전체 대기 132건 = 답장 필요 41건 + 답장 불필요 91건 (부재중 80 · 종결 인사 11)");
    await expect(headline.getByTestId("pending-breakdown-equation")).toContainText("전체 대기 132건 = 케이스 110건 + 미분류 11건 (+ 종결 11건)");

    // Default 사람 처리 필요 hides the 부재중 row; the tab sits after 자동답장 설정됨.
    await expect(page.getByTestId("permit-case-out_of_office")).toHaveCount(0);
    expect(await inboxOrder(page)).toEqual(["interest_next_steps", "__unclassified__"]);
    const tabNames = await page.getByRole("tab").allTextContents();
    const order = ["사람 처리 필요", "자동답장 설정됨", "답장 불필요", "전체"].map((label) => tabNames.findIndex((name) => name.startsWith(label)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    await page.getByRole("tab", { name: /^답장 불필요/ }).click();
    expect(await inboxOrder(page)).toEqual(["out_of_office"]);
    await expect(page.getByTestId("permit-case-out_of_office")).toContainText("답장 불필요");
    await expect(page.getByTestId("casebook-filter-total")).toHaveText("전체 대기 132건");

    // Older server (no overlay, no reason) → the plain total headline and no 답장 불필요 tab.
    // Stale snapshot (codex round 5): never subtract — the plain total headline with its stale label.
    stale = true;
    await page.reload();
    await expect(headline.getByTestId("pending-headline-count")).toHaveText("132");
    await expect(headline.getByTestId("pending-headline-reply-needed-count")).toHaveCount(0);
    await expect(headline.getByTestId("pending-headline-computed-at")).toContainText("최신 집계 지연 중");
    await expect(page.getByTestId("permit-case-out_of_office")).toBeVisible();

    stale = false;
    oldServer = true;
    await page.reload();
    await expect(headline.getByTestId("pending-headline-count")).toHaveText("121");
    await expect(headline.getByTestId("pending-headline-reply-needed-count")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^답장 불필요/ })).toHaveCount(0);
    await expect(page.getByTestId("permit-case-out_of_office")).toBeVisible();
  });

  test("an empty filter result is a friendly state that links back to 전체; missing, partial and in-progress counts never look like a real 0", async ({ page }) => {
    let mode: "exact_zero" | "lower_bound" | "missing" | "stale_exact_zero" = "exact_zero";
    await routeInboxSnapshot(page, (result) => {
      applyInboxFixture(result, {});
      if (mode === "lower_bound") {
        result.pendingTotal = { count: 120, exact: false, countStatus: "lower_bound", truncated: true, status: "fresh", computedAtIso: new Date().toISOString(), asOfIso: new Date().toISOString() };
        result.rows.forEach((row: { pendingCount: number }, index: number) => { row.pendingCount = index === 0 ? 7 : 0; });
        result.pendingBreakdown = { status: "unavailable", managedCaseTotal: 0, closedCaseCount: 0, unclassified: { total: 0, byReason: { never_classified: 0, unknown_case: 0, stale_stamp: 0 } } };
        result.rows.forEach((row: { attention: { needsHuman: boolean } }) => { row.attention.needsHuman = true; });
      }
      if (mode === "stale_exact_zero") {
        // The last precompute was a complete 0, but it is stale: new inquiries may have arrived since.
        const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        result.pendingTotal = { ...result.pendingTotal, status: "stale", computedAtIso: old, asOfIso: old };
        // Server rule (codex round 4): only a FRESH exact 0 is proven, so every OFF zero row needs a human.
        result.rows.forEach((row: { attention: { needsHuman: boolean } }) => { row.attention.needsHuman = true; });
      }
      if (mode === "missing") {
        result.pendingTotal = { count: 0, exact: false, countStatus: "unknown", truncated: false, status: "missing", computedAtIso: null, asOfIso: null };
        result.pendingBreakdown = { status: "unavailable", managedCaseTotal: 0, closedCaseCount: 0, unclassified: { total: 0, byReason: { never_classified: 0, unknown_case: 0, stale_stamp: 0 } } };
        result.rows.forEach((row: { attention: { needsHuman: boolean } }) => { row.attention.needsHuman = true; });
      }
    });
    await loginAsAdmin(page, "/chat/auto");
    const headline = page.getByTestId("pending-headline-card");
    const pendingMetric = (index: number) => page.locator('[data-testid^="case-pending-metric-"]').nth(index);

    // Nothing is waiting anywhere → the default 사람 처리 필요 view is a friendly empty state.
    const showAll = () => page.getByRole("tab", { name: /^전체/ }).click();
    await expect(page.getByTestId("casebook-filter-empty")).toContainText("지금 사람이 처리할 케이스가 없습니다");
    await expect(page.getByTestId("casebook-unclassified"), "a known (exact) 미분류 0 is the only case hidden from the default view").toHaveCount(0);
    await expect(pendingMetric(0), "exact zero: OFF zero-count case rows are hidden on the default tab").toHaveCount(0);
    await showAll();

    // A real, complete 0 is the only state that may say 0건 / 없음.
    await expect(headline.getByTestId("pending-headline-count")).toHaveText("0");
    await expect(headline.getByTestId("pending-breakdown-equation")).toContainText("전체 대기 0건 = 케이스 0건 + 미분류 0건");
    await expect(pendingMetric(0)).toContainText("0건");
    await expect(pendingMetric(0)).toContainText("없음");

    // 자동답장 설정됨 has nothing in it → friendly empty state → one click back to 전체.
    await page.getByRole("tab", { name: /^자동답장 설정됨/ }).click();
    const empty = page.getByTestId("casebook-filter-empty");
    await expect(empty).toContainText("자동답장이 설정된 케이스가 없습니다");
    await empty.getByTestId("casebook-filter-show-all").click();
    await expect(page.getByTestId("casebook-filter-empty")).toHaveCount(0);
    expect((await inboxOrder(page)).length).toBeGreaterThan(0);

    mode = "lower_bound";
    await page.reload();
    await expect(headline.getByTestId("pending-headline-lower-bound-count")).toHaveText("120");
    // An unknown 미분류 count (a 0 floor of a capped scan) stays in the default view, never shown as 0.
    await expect(page.getByTestId("casebook-unclassified")).toBeVisible();
    await expect(page.getByTestId("casebook-unclassified-count")).toHaveText("집계 중");
    // Default tab: OFF zero-count case rows stay visible while counts are unknown.
    await expect(pendingMetric(0)).toContainText("7건 이상");
    await expect(pendingMetric(1)).toContainText("집계 중");
    await showAll();
    await expect(headline.getByTestId("pending-headline-lower-bound")).toContainText("건 이상 대기 중");
    await expect(headline.getByTestId("pending-headline-count")).toHaveCount(0);
    await expect(headline.getByTestId("pending-breakdown-equation")).toHaveCount(0);
    await expect(pendingMetric(0)).toContainText("7건 이상");
    await expect(pendingMetric(1)).toContainText("집계 중");
    await expect(pendingMetric(1)).not.toContainText("0건");
    await expect(pendingMetric(1)).not.toContainText("없음");

    mode = "missing";
    await page.reload();
    await expect(headline.getByTestId("pending-headline-computing")).toBeVisible();
    // No precompute yet: the 미분류 backlog is unknown, so it stays visible in 사람 처리 필요.
    await expect(page.getByTestId("casebook-unclassified")).toBeVisible();
    await expect(page.getByTestId("casebook-unclassified-count")).toHaveText("집계 전");
    // Default tab: unknown backlog never hides OFF zero-count case rows.
    await expect(pendingMetric(0)).toContainText("집계 전");
    await showAll();
    await expect(headline.getByTestId("pending-headline-count")).toHaveCount(0);
    await expect(pendingMetric(0)).toContainText("집계 전");
    await expect(pendingMetric(0)).not.toContainText("0건");
    await expect(pendingMetric(0)).not.toContainText("없음");

    mode = "stale_exact_zero";
    await page.reload();
    // A stale exact 0 still shows its number (with its as-of time) but hides nothing from 사람 처리 필요.
    await expect(headline.getByTestId("pending-headline-count")).toHaveText("0");
    await expect(page.getByTestId("casebook-filter-empty")).toHaveCount(0);
    await expect(page.getByTestId("casebook-unclassified")).toBeVisible();
    await expect(page.getByTestId("casebook-unclassified-count")).toHaveText("0건");
    await expect(pendingMetric(0), "stale exact zero: OFF zero-count rows stay on the default tab").toContainText("0건");
  });

  test("미분류 is a sorted entry; its list loads only on expand, pages, filters by reason, and deep-links to the chat", async ({ page }) => {
    const listRequests: Array<Record<string, unknown>> = [];
    let failNext = false;
    const mk = (id: string, reason: string, legacy?: boolean) => ({
      conversationId: id, reason, ...(legacy === undefined ? {} : { legacy }), creatorName: `크리에이터 ${id}`, creatorEmailMasked: "c***@example.test",
      subject: `문의 ${id}`, lastInboundAtIso: "2026-10-01T01:00:00.000Z", mailAccountLabel: "scp@example.test",
    });
    await routeInboxSnapshot(page, (result) => {
      applyInboxFixture(result, {
        counts: { requirements_question: 40 },
        unclassified: { total: 287, byReason: { never_classified: 200, unknown_case: 50, stale_stamp: 37 }, neverClassifiedBeforeStampLaunch: 150 },
      });
    });
    await page.route(/listChatAutoCasebookUnclassified/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const data = route.request().postDataJSON().data ?? {};
      listRequests.push(data);
      // The first scan is slow in production (30-40s); hold it briefly so its loading text is observable.
      if (listRequests.length === 1) await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (failNext) {
        failNext = false;
        return route.fulfill({ status: 500, ...INBOX_JSON, body: JSON.stringify({ error: { status: "INTERNAL", message: "e2e failure" } }) });
      }
      let result: Record<string, unknown>;
      if (data.reason === "unknown_case") result = { rows: [], nextCursor: null, exhausted: true };
      else if (data.cursor === "cursor-2") result = { rows: [mk("conv-3", "never_classified")], nextCursor: null, exhausted: true };
      else result = { rows: [mk("conv-1", "never_classified", true), mk("conv-2", "stale_stamp")], nextCursor: "cursor-2", exhausted: false };
      await route.fulfill({ status: 200, ...INBOX_JSON, body: JSON.stringify({ result: { ok: true, ...result, scannedAtIso: new Date().toISOString(), behaviorLog: {} } }) });
    });
    await loginAsAdmin(page, "/chat/auto");

    // 미분류 (287) outranks every case; its cached reason breakdown is on the card.
    await expect(page.getByTestId("casebook-unclassified")).toBeVisible();
    expect((await inboxOrder(page))[0]).toBe("__unclassified__");
    await expect(page.getByTestId("casebook-unclassified-count")).toHaveText("287건");
    await expect(page.getByTestId("casebook-unclassified-reasons")).toHaveText("분류 기록 없음 200건 (이 중 150건은 9/28 분류 도입 전 메일) · 알 수 없는 케이스 50건 · 최신 메일 미분류 37건");
    // Never fetched on mount.
    expect(listRequests).toHaveLength(0);

    await page.getByTestId("casebook-unclassified-toggle").click();
    await expect(page.getByTestId("casebook-unclassified-loading")).toHaveText("대기 대화를 처음부터 훑고 있어 최대 1분 걸릴 수 있습니다.");
    await expect(page.getByTestId("casebook-unclassified-list")).toBeVisible();
    await expect(page.getByTestId("casebook-unclassified-loading")).toHaveCount(0);
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0]).toMatchObject({ reason: "all", limit: 25 });
    expect(listRequests[0]).not.toHaveProperty("cursor");
    await expect(page.getByTestId("casebook-unclassified-basis")).toContainText("현재 기준");
    await expect(page.getByTestId("casebook-unclassified-row-conv-1")).toContainText("크리에이터 conv-1");
    await expect(page.getByTestId("casebook-unclassified-row-conv-1")).toContainText("도입 전");
    await expect(page.getByTestId("casebook-unclassified-row-conv-2")).toContainText("최신 메일 미분류");
    await expect(page.getByTestId("casebook-unclassified-row-conv-2")).not.toContainText("도입 전");
    await expect(page.getByTestId("casebook-unclassified-link-conv-1")).toHaveAttribute("href", "/chat?conversationId=conv-1");

    // Paging with the server cursor appends; the button disappears when exhausted.
    await page.getByTestId("casebook-unclassified-more").click();
    await expect(page.getByTestId("casebook-unclassified-row-conv-3")).toBeVisible();
    expect(listRequests[1]).toMatchObject({ reason: "all", cursor: "cursor-2" });
    await expect(page.getByTestId("casebook-unclassified-row-conv-1")).toBeVisible();
    await expect(page.getByTestId("casebook-unclassified-more")).toHaveCount(0);

    // Reason chip → a fresh list for that reason (empty state), old rows gone.
    await page.getByTestId("casebook-unclassified-reason-tabs").getByRole("tab", { name: /^알 수 없는 케이스/ }).click();
    await expect(page.getByTestId("casebook-unclassified-empty")).toBeVisible();
    expect(listRequests[2]).toMatchObject({ reason: "unknown_case" });
    await expect(page.getByTestId("casebook-unclassified-row-conv-1")).toHaveCount(0);

    // Error state with retry.
    failNext = true;
    await page.getByTestId("casebook-unclassified-reason-tabs").getByRole("tab", { name: /^분류 기록 없음/ }).click();
    await expect(page.getByTestId("casebook-unclassified-error")).toContainText("불러오지 못했습니다");
    await page.getByTestId("casebook-unclassified-error").getByRole("button", { name: "다시 시도" }).click();
    await expect(page.getByTestId("casebook-unclassified-row-conv-1")).toBeVisible();
    await expect(page.getByTestId("casebook-unclassified-error")).toHaveCount(0);
  });

  test("editor shows the ready precomputed suggestion without a model call, inserts links at the cursor, previews read-only, and keeps unsaved text across refresh and re-sort", async ({ page }) => {
    test.setTimeout(120_000);
    let phase = 1;
    let editable: string[] = [];
    const originalHash: Record<string, string> = {};
    const modelCalls: string[] = [];
    const saves: Array<Record<string, any>> = [];
    const previews: Array<Record<string, any>> = [];
    const READY_TEXT = "Hi,\n\nPlease read our guide: {{GUIDE_LINK}}\n\nBest regards,\nSupercent";
    await routeInboxSnapshot(page, (result) => {
      const rows = result.rows as any[];
      if (editable.length === 0) editable = rows.filter((row) => row.replyText?.editable === true).slice(0, 4).map((row) => row.caseId);
      expect(editable.length, "needs four server-editable emulator cases").toBe(4);
      for (const row of rows) if (!originalHash[row.caseId]) originalHash[row.caseId] = row.replyText.revisionHash;
      const [a, b, c, d] = editable;
      applyInboxFixture(result, {
        // c/d have waiting conversations too, so the default 사람 처리 필요 view keeps them listed.
        counts: phase === 1 ? { [a]: 1, [b]: 5, [c]: 2, [d]: 2 } : { [a]: 9, [b]: 5, [c]: 2, [d]: 2 },
        attention: phase === 1 ? {} : { [a]: { autoReply: "healthy", needsHuman: false, reasons: [] } },
        suggestions: {
          [a]: { status: "ready", text: READY_TEXT, generatedAtIso: "2026-10-01T00:30:00.000Z", modelId: "e2e-model" },
          [b]: { status: "stale", text: "OLD STALE TEXT", generatedAtIso: "2026-09-29T00:00:00.000Z", modelId: "e2e-model" },
          [c]: { status: "pending", text: null, generatedAtIso: null, modelId: null },
          [d]: { status: "failed", text: null, generatedAtIso: null, modelId: null },
        },
      });
      if (phase === 2) {
        const rowA = rows.find((row) => row.caseId === a);
        rowA.replyText.revision += 1;
        rowA.replyText.revisionHash = "e2e-server-moved-on";
      }
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && /suggestChatAutoCaseReply/.test(request.url())) modelCalls.push(request.url());
    });
    await page.route(/previewChatAutoCaseReply/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const data = route.request().postDataJSON().data;
      previews.push(data);
      const invalid = String(data.text).includes("{{SUBMIT_LINK}}");
      await route.fulfill({ status: 200, ...INBOX_JSON, body: JSON.stringify({ result: invalid
        ? { ok: true, caseId: data.caseId, valid: false, errorMessage: "이 케이스에서는 쓸 수 없는 링크입니다: SUBMIT_LINK", resolvedText: null, links: [] }
        : { ok: true, caseId: data.caseId, valid: true, errorMessage: null, resolvedText: "Hello <b>bold</b> https://example.test/guide world", links: [{ token: "GUIDE_LINK", label: "Guide", url: "https://example.test/guide" }] } }) });
    });
    await page.route(/saveChatAutoCaseReply/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      saves.push(route.request().postDataJSON().data);
      await route.fulfill({ status: 500, ...INBOX_JSON, body: JSON.stringify({ error: { status: "INTERNAL", message: "e2e capture only" } }) });
    });

    await loginAsAdmin(page, "/chat/auto");
    await expect(page.getByTestId("pending-headline-count")).toBeVisible();
    const [a, b, c, d] = editable;
    const rowA = page.getByTestId(`permit-case-${a}`);
    const rowB = page.getByTestId(`permit-case-${b}`);
    const textA = rowA.getByTestId(`case-reply-text-${a}`);
    const textB = rowB.getByTestId(`case-reply-text-${b}`);

    // Ready: shown immediately on open (no model call), editor text untouched until the explicit click.
    await rowA.getByTestId(`case-reply-toggle-${a}`).click();
    const defaultBlock = rowA.getByTestId(`case-reply-default-suggestion-${a}`);
    await expect(defaultBlock).toContainText("이렇게 답장할까요?");
    await expect(defaultBlock).toContainText("미리 준비된 제안");
    await expect(defaultBlock).toContainText("Please read our guide: {{GUIDE_LINK}}");
    expect(modelCalls).toEqual([]);
    expect(await textA.inputValue()).not.toBe(READY_TEXT);
    const applyDefaultA = rowA.getByTestId(`case-reply-apply-default-${a}`);
    await applyDefaultA.click();
    await expect(textA).toHaveValue(READY_TEXT);
    await expect(applyDefaultA).toHaveText("편집창에 반영됨");
    // Editing away from the applied suggestion resets the "applied" state (it is no longer in the editor).
    await textA.fill(`${READY_TEXT} — edited`);
    await expect(applyDefaultA).toHaveText("제안 문구를 편집창에 넣기");
    await applyDefaultA.click();
    await expect(textA).toHaveValue(READY_TEXT);
    await expect(applyDefaultA).toHaveText("편집창에 반영됨");
    expect(saves).toEqual([]);

    // Stale / pending / failed never show old text as current; failed keeps the manual button.
    await rowB.getByTestId(`case-reply-toggle-${b}`).click();
    await expect(rowB.getByTestId(`case-reply-default-status-${b}`)).toContainText("갱신 필요 · 곧 다시 만듭니다");
    await expect(rowB).not.toContainText("OLD STALE TEXT");
    await page.getByTestId(`permit-case-${c}`).getByTestId(`case-reply-toggle-${c}`).click();
    await expect(page.getByTestId(`case-reply-default-status-${c}`)).toContainText("준비 중");
    await page.getByTestId(`permit-case-${d}`).getByTestId(`case-reply-toggle-${d}`).click();
    await expect(page.getByTestId(`case-reply-default-status-${d}`)).toContainText("생성 실패");
    await expect(page.getByTestId(`case-reply-suggest-${d}`)).toBeVisible();
    expect(modelCalls).toEqual([]);

    // 링크 넣기: at the cursor, caret placed after the token, not-allowed links disabled with a reason.
    await textA.fill("Hello world");
    await textA.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(5, 5); });
    await rowA.getByTestId(`case-reply-link-GUIDE_LINK-${a}`).click();
    await expect(textA).toHaveValue("Hello{{GUIDE_LINK}} world");
    expect(await textA.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe("Hello{{GUIDE_LINK}}".length);
    const blockedLink = rowA.getByTestId(`case-reply-link-SUBMIT_LINK-${a}`);
    await expect(blockedLink).toBeDisabled();
    await expect(blockedLink).toHaveAttribute("title", /쓸 수 없는 링크/);

    // 미리보기: read-only, plain text (no HTML interpretation), links shown as label + url.
    await rowA.getByTestId(`case-reply-preview-button-${a}`).click();
    const preview = rowA.getByTestId(`case-reply-preview-${a}`);
    await expect(preview.getByTestId(`case-reply-preview-text-${a}`)).toContainText("Hello <b>bold</b> https://example.test/guide world");
    await expect(preview.locator("b")).toHaveCount(0);
    await expect(preview.getByTestId(`case-reply-preview-links-${a}`)).toContainText("Guide — https://example.test/guide");
    expect(previews[0]).toEqual({ caseId: a, text: "Hello{{GUIDE_LINK}} world" });
    await textA.fill("Hello{{SUBMIT_LINK}}");
    await expect(preview).toContainText("다시 미리보기");
    await rowA.getByTestId(`case-reply-preview-button-${a}`).click();
    await expect(rowA.getByTestId(`case-reply-preview-error-${a}`)).toContainText("쓸 수 없는 링크");
    expect(saves).toEqual([]);

    // Unsaved text survives a background refresh that re-sorts the list and changes the server revision.
    await textA.fill("DIRTY-EDIT-A");
    await textB.fill("DIRTY-EDIT-B");
    const before = await inboxOrder(page);
    expect(before.indexOf(b)).toBeLessThan(before.indexOf(a));
    phase = 2;
    const refresh = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("getChatAutoCasebookSnapshot"));
    await page.getByTestId(`permit-case-${c}`).getByRole("button", { name: "최근 발송 보기" }).click();
    await refresh;
    await expect.poll(async () => { const order = await inboxOrder(page); return order.indexOf(a) < order.indexOf(b); }).toBe(true);
    // Each row still owns its own text; A stays visible although it is now healthy (filter would hide it).
    await expect(textA).toHaveValue("DIRTY-EDIT-A");
    await expect(textB).toHaveValue("DIRTY-EDIT-B");
    await expect(rowA).toBeVisible();

    // The CAS base is the one the human started from, not the refreshed server revision.
    await rowA.getByTestId(`case-reply-save-${a}`).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ caseId: a, text: "DIRTY-EDIT-A", expectedRevisionHash: originalHash[a] });
    expect(saves[0].expectedRevisionHash).not.toBe("e2e-server-moved-on");
    expect(modelCalls).toEqual([]);
  });
});
