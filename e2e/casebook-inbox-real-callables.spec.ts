import { expect, test, type Page, type Response } from "@playwright/test";
import { commitDocument, deleteDocument, loginAsAdmin } from "./helpers/emulator";

// Casebook inbox — REAL emulator callables, no route stubs (2026-10-01, integrator).
// e2e/permit-chat-auto.spec.ts's "casebook inbox UI" block layers the contract fields onto the live
// snapshot with route handlers so the UI could be built before the backend lanes merged. This spec
// is the post-merge counterpart: it seeds Firestore (pending precompute doc, default-suggestion doc,
// conversations) and asserts what the real functions emulator actually returns for
//   getChatAutoCasebookSnapshot · listChatAutoCasebookUnclassified · previewChatAutoCaseReply
// by observing the real HTTP responses (page.waitForResponse — never route.fulfill/route.fetch).

const stamp = Date.now();
const PENDING_DOC = "super_admin"; // the test admin is a super_admin => scope key "super_admin"
const SUGGESTION_CASE = "interest_next_steps"; // seeded with a deliberately stale suggestion doc
const UNSEEDED_CASE = "submission_support"; // applicable case with no suggestion doc yet
const BLOCKED_CASE = "opt_out_or_legal"; // blocked_suppression: never carries a suggestion

const CONV = {
  legacy: `casebook-e2e-legacy-${stamp}`,
  never: `casebook-e2e-never-${stamp}`,
  unknown: `casebook-e2e-unknown-${stamp}`,
  stale: `casebook-e2e-stale-${stamp}`,
  managed: `casebook-e2e-managed-${stamp}`,
};

// 2026-09-28T16:43:10Z is the stamp launch; the legacy row predates it, the others are after it.
const LEGACY_INBOUND = "2026-08-01T00:00:00.000Z";
const AFTER_LAUNCH_INBOUND = "2026-09-29T00:00:00.000Z";

function conversation(id: string, lastInboundAtIso: string, stampFields: Record<string, unknown>) {
  return {
    id,
    threadId: id,
    contextKey: `ctx-${id}`,
    creatorId: `creator-${id}`,
    creatorName: `Casebook E2E ${id.split("-")[2]}`,
    creatorEmail: `${id}@example.test`,
    lastMessage: `문의 ${id}`,
    lastMessageFrom: "creator",
    lastMessageAtIso: lastInboundAtIso,
    lastInboundAtIso,
    updatedAtIso: lastInboundAtIso,
    autoReplyStatus: "waiting_for_human",
    lastMessageRef: `ref-latest-${id}`,
    ...stampFields,
  };
}

const waitFor = (page: Page, callable: string, predicate: (response: Response) => boolean = () => true) =>
  page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().includes(callable) && predicate(response));

type SnapshotRow = {
  caseId: string;
  pendingCount: number;
  attention?: { autoReply: string; needsHuman: boolean; reasons: string[] };
  allowedLinkTokens?: string[];
  defaultSuggestion?: { status: string; text: string | null; generatedAtIso: string | null; modelId: string | null };
};

test.describe("casebook inbox against the real emulator callables", () => {
  test.beforeEach(async () => {
    const nowIso = new Date().toISOString();
    await commitDocument(`chat_auto_casebook_pending/${PENDING_DOC}`, {
      scopeKey: PENDING_DOC,
      // 7 managed (interest_next_steps 3 + reward_overview 2 + out_of_office 2) + 1 closed + 4 unclassified.
      pendingTotal: 12,
      truncated: false,
      byCaseId: { interest_next_steps: 3, reward_overview: 2, out_of_office: 2 },
      unclassifiedCount: 4,
      breakdown: {
        closedCaseCount: 1,
        unclassifiedByReason: { never_classified: 3, unknown_case: 0, stale_stamp: 1 },
        neverClassifiedBeforeStampLaunch: 2,
      },
      exact: true,
      countStatus: "exact",
      computedAtIso: nowIso,
      asOfIso: nowIso,
    });
    // A suggestion doc whose inputKey can never match the current inputs => the real reader reports "stale".
    await commitDocument(`chat_auto_case_reply_default_suggestions/${SUGGESTION_CASE}`, {
      status: "ready",
      inputKey: `e2e-obsolete-input-key-${stamp}`,
      text: "OBSOLETE SUGGESTION TEXT MUST NOT BE SHOWN",
      generatedAtIso: nowIso,
      expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
      modelId: "e2e-model",
      attempts: 1,
    });
    await commitDocument(`conversations/${CONV.legacy}`, conversation(CONV.legacy, LEGACY_INBOUND, {}));
    await commitDocument(`conversations/${CONV.never}`, conversation(CONV.never, AFTER_LAUNCH_INBOUND, {}));
    await commitDocument(`conversations/${CONV.unknown}`, conversation(CONV.unknown, LEGACY_INBOUND, {
      autoCaseId: "made_up_case", autoCaseMessageRef: `ref-latest-${CONV.unknown}`,
    }));
    await commitDocument(`conversations/${CONV.stale}`, conversation(CONV.stale, LEGACY_INBOUND, {
      autoCaseId: "interest_next_steps", autoCaseMessageRef: "ref-older-stamp",
    }));
    // Fresh stamp on a managed case => counted as a case row, never listed as unclassified.
    await commitDocument(`conversations/${CONV.managed}`, conversation(CONV.managed, LEGACY_INBOUND, {
      autoCaseId: "interest_next_steps", autoCaseMessageRef: `ref-latest-${CONV.managed}`,
    }));
  });

  test.afterEach(async () => {
    await deleteDocument("chat_auto_casebook_pending", PENDING_DOC);
    await deleteDocument("chat_auto_case_reply_default_suggestions", SUGGESTION_CASE);
    for (const id of Object.values(CONV)) await deleteDocument("conversations", id);
  });

  test("getChatAutoCasebookSnapshot returns pendingBreakdown, row attention, allowedLinkTokens, defaultSuggestion and replyLinkCatalog", async ({ page }) => {
    test.setTimeout(120_000);
    const snapshotResponse = waitFor(page, "getChatAutoCasebookSnapshot");
    await loginAsAdmin(page, "/chat/auto");
    const response = await snapshotResponse;
    expect(response.ok()).toBe(true);
    const result = (await response.json()).result;
    expect(result.ok).toBe(true);

    // pendingBreakdown reconciles the seeded precompute doc (read live from Firestore, not stubbed).
    expect(result.pendingTotal).toMatchObject({ count: 12, exact: true, status: "fresh" });
    expect(result.unclassifiedPendingCount).toBe(4);
    expect(result.pendingBreakdown).toEqual({
      status: "available",
      managedCaseTotal: 7,
      closedCaseCount: 1,
      unclassified: {
        total: 4,
        byReason: { never_classified: 3, unknown_case: 0, stale_stamp: 1 },
        neverClassifiedBeforeStampLaunch: 2,
      },
      // 0.6.105 답장 불필요 overlay: out_of_office pending + closed (종결 인사); the total is not reduced.
      noReplyNeeded: { total: 3, byCaseId: { out_of_office: 2, closing_acknowledgment: 1 } },
    });
    const { managedCaseTotal, closedCaseCount, unclassified } = result.pendingBreakdown;
    expect(result.pendingTotal.count).toBe(managedCaseTotal + closedCaseCount + unclassified.total);

    // Every displayed row carries the new per-row fields with the contract's shapes.
    const rows = result.rows as SnapshotRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["healthy", "armed_unhealthy", "off"], row.caseId).toContain(row.attention?.autoReply);
      expect(typeof row.attention?.needsHuman, row.caseId).toBe("boolean");
      expect(Array.isArray(row.attention?.reasons), row.caseId).toBe(true);
      expect(Array.isArray(row.allowedLinkTokens), row.caseId).toBe(true);
      expect(row.allowedLinkTokens, row.caseId).not.toContain("GUIDELINE_AMOUNT");
      expect(["ready", "stale", "pending", "failed", "not_applicable"], row.caseId).toContain(row.defaultSuggestion?.status);
    }
    expect(rows.reduce((sum, row) => sum + row.pendingCount, 0)).toBe(managedCaseTotal);

    const interest = rows.find((row) => row.caseId === SUGGESTION_CASE)!;
    expect(interest.pendingCount).toBe(3);
    expect(interest.attention).toMatchObject({ autoReply: "off", needsHuman: true });
    expect(interest.attention!.reasons).toContain("not_armed");
    expect(interest.allowedLinkTokens).toEqual(["APPLY_LINK", "GUIDE_LINK"]);
    // Seeded doc with a non-matching inputKey: stale, and its text is never surfaced as current.
    expect(interest.defaultSuggestion).toEqual({ status: "stale", text: null, generatedAtIso: null, modelId: null });
    expect(JSON.stringify(result)).not.toContain("OBSOLETE SUGGESTION TEXT");
    // No doc yet => pending (the snapshot never generates one); hard cases => not_applicable.
    expect(rows.find((row) => row.caseId === UNSEEDED_CASE)!.defaultSuggestion!.status).toBe("pending");
    const blocked = rows.find((row) => row.caseId === BLOCKED_CASE)!;
    expect(blocked.defaultSuggestion!.status).toBe("not_applicable");
    expect(blocked.attention!.reasons).toContain("blocked_case");
    // OFF with nothing pending is not a human task (0.6.104 live fix): hidden from 사람 처리 필요.
    expect(blocked.attention!.needsHuman).toBe(false);
    expect(rows.find((row) => row.caseId === UNSEEDED_CASE)!.attention).toMatchObject({ autoReply: "off", needsHuman: false });
    // 답장 불필요 (out_of_office, 2 pending): no human reply needed — display only, its count is kept.
    expect(rows.find((row) => row.caseId === "out_of_office")).toMatchObject({ pendingCount: 2, attention: { needsHuman: false, reasons: ["no_reply_needed"] } });
    for (const row of rows) {
      if (row.attention!.reasons.includes("no_reply_needed")) continue;
      expect(row.attention!.needsHuman, row.caseId).toBe(row.pendingCount > 0 || row.attention!.autoReply === "armed_unhealthy");
    }

    // The reviewed link catalog the editor offers.
    expect(result.replyLinkCatalog.map((entry: { token: string }) => entry.token)).toEqual(["APPLY_LINK", "GUIDE_LINK", "SUBMIT_LINK", "SAMPLE_LINK"]);
    for (const entry of result.replyLinkCatalog as Array<{ label: string; url: string }>) {
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.label.length).toBeGreaterThan(0);
    }

    // The console renders the real numbers: the explained total and the legacy note.
    await expect(page.getByTestId("casebook-unclassified-count")).toHaveText("4건", { timeout: 20_000 });
    await expect(page.getByTestId(`permit-case-${SUGGESTION_CASE}`)).toBeVisible();
    await expect(page.getByTestId(`permit-case-${BLOCKED_CASE}`)).toHaveCount(0);
    // 답장 필요 = 12 − 3; the out_of_office row lives under the 답장 불필요 tab, not 사람 처리 필요.
    await expect(page.getByTestId("pending-headline-reply-needed-count")).toHaveText("9");
    await expect(page.getByTestId("pending-no-reply-equation")).toContainText("전체 대기 12건 = 답장 필요 9건 + 답장 불필요 3건 (부재중 2 · 종결 인사 1)");
    await expect(page.getByTestId("permit-case-out_of_office")).toHaveCount(0);
    // One line, 0-count reasons (unknown_case) omitted, legacy subset folded into 분류 기록 없음.
    await expect(page.getByTestId("casebook-unclassified-reasons")).toHaveText("분류 기록 없음 3건 (이 중 2건은 9/28 분류 도입 전 메일) · 최신 메일 미분류 1건");
  });

  test("listChatAutoCasebookUnclassified lists the seeded unclassified conversations with reason, legacy flag and a /chat deeplink", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAsAdmin(page, "/chat/auto");
    await expect(page.getByTestId("casebook-unclassified-toggle")).toBeVisible({ timeout: 30_000 });
    const listResponse = waitFor(page, "listChatAutoCasebookUnclassified");
    await page.getByTestId("casebook-unclassified-toggle").click();
    const response = await listResponse;
    expect(response.ok()).toBe(true);
    const first = (await response.json()).result;
    expect(first.ok).toBe(true);
    expect(typeof first.scannedAtIso).toBe("string");

    // Collect every page of the live scan (other seeded conversations may precede ours).
    type Row = { conversationId: string; reason: string; legacy?: boolean; lastInboundAtIso: string | null; creatorEmailMasked: string | null };
    const rows: Row[] = [...first.rows];
    let nextCursor: string | null = first.exhausted ? null : first.nextCursor;
    for (let guard = 0; nextCursor && guard < 10 && !Object.values(CONV).every((id) => id === CONV.managed || rows.some((row) => row.conversationId === id)); guard += 1) {
      const more = waitFor(page, "listChatAutoCasebookUnclassified");
      await page.getByTestId("casebook-unclassified-more").click();
      const next = (await (await more).json()).result;
      rows.push(...next.rows);
      nextCursor = next.exhausted ? null : next.nextCursor;
    }
    const byId = new Map(rows.map((row) => [row.conversationId, row]));
    expect(byId.get(CONV.legacy)).toMatchObject({ reason: "never_classified", legacy: true });
    expect(byId.get(CONV.never)).toMatchObject({ reason: "never_classified", legacy: false });
    expect(byId.get(CONV.unknown)).toMatchObject({ reason: "unknown_case", legacy: false });
    expect(byId.get(CONV.stale)).toMatchObject({ reason: "stale_stamp", legacy: false });
    expect(byId.has(CONV.managed), "a fresh stamp on a managed case is never an unclassified row").toBe(false);
    // Minimal projection: the raw email never crosses the boundary.
    expect(byId.get(CONV.legacy)!.creatorEmailMasked).toMatch(/^c\*\*\*@example\.test$/);
    expect(JSON.stringify(rows)).not.toContain(`${CONV.legacy}@example.test`);

    // The UI shows each row with the /chat deeplink and the legacy badge only where it applies.
    await expect(page.getByTestId(`casebook-unclassified-row-${CONV.legacy}`)).toContainText("도입 전");
    await expect(page.getByTestId(`casebook-unclassified-link-${CONV.legacy}`)).toHaveAttribute("href", `/chat?conversationId=${CONV.legacy}`);
    await expect(page.getByTestId(`casebook-unclassified-row-${CONV.never}`)).not.toContainText("도입 전");
    await expect(page.getByTestId(`casebook-unclassified-row-${CONV.stale}`)).toContainText("최신 메일 미분류");
    // Conversations carry no subject, so the row shows no "(제목 없음)" placeholder.
    await expect(page.getByTestId(`casebook-unclassified-row-${CONV.legacy}`)).not.toContainText("제목 없음");
  });

  test("previewChatAutoCaseReply resolves {{GUIDE_LINK}} to the canonical anchor through the same resolver dispatch uses, with no write", async ({ page }) => {
    test.setTimeout(120_000);
    const snapshotResponse = waitFor(page, "getChatAutoCasebookSnapshot");
    await loginAsAdmin(page, "/chat/auto");
    const snapshot = (await (await snapshotResponse).json()).result;
    const guide = (snapshot.replyLinkCatalog as Array<{ token: string; url: string; label: string }>).find((entry) => entry.token === "GUIDE_LINK")!;

    const row = page.getByTestId(`permit-case-${SUGGESTION_CASE}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId(`case-reply-toggle-${SUGGESTION_CASE}`).click();
    const textarea = row.getByTestId(`case-reply-text-${SUGGESTION_CASE}`);
    await textarea.fill("Hello!\n\nPlease read the guide: ");
    await row.getByTestId(`case-reply-link-GUIDE_LINK-${SUGGESTION_CASE}`).click();
    await expect(textarea).toHaveValue(/\{\{GUIDE_LINK\}\}/);

    const previewResponse = waitFor(page, "previewChatAutoCaseReply");
    await row.getByTestId(`case-reply-preview-button-${SUGGESTION_CASE}`).click();
    const response = await previewResponse;
    expect(response.ok()).toBe(true);
    const preview = (await response.json()).result;
    expect(preview.ok).toBe(true);
    expect(preview.caseId).toBe(SUGGESTION_CASE);
    expect(preview.valid).toBe(true);
    expect(preview.errorMessage).toBeNull();
    // The token is replaced by the SAME anchor chat-ai's substituteCasebookLinks dispatches.
    expect(preview.resolvedText).not.toContain("{{GUIDE_LINK}}");
    expect(preview.resolvedText).toContain(`[${guide.label}](${guide.url})`);
    expect(preview.links).toEqual([{ token: "GUIDE_LINK", label: guide.label, url: guide.url }]);

    await expect(row.getByTestId(`case-reply-preview-text-${SUGGESTION_CASE}`)).toContainText(guide.url);
    // Read-only: previewing never saved a reply (the editor stays on the unsaved text).
    await expect(row.getByTestId(`case-reply-save-${SUGGESTION_CASE}`)).toBeEnabled();
  });
});
