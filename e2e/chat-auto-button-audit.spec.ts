import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { commitDocument, deleteDocument, loginAsAdmin, readCollection } from "./helpers/emulator";

// 0.6.104 live fix: the default 사람 처리 필요 view hides OFF cases with nothing pending, and the
// emulator seed has no pending conversations — tests that drive specific case rows switch to 전체.
async function showAllCasebookEntries(page: Page) {
  const allTab = page.getByTestId("casebook-inbox-filter").getByRole("tab", { name: /^전체/ });
  await expect(allTab).toBeVisible({ timeout: 30_000 });
  await allTab.click();
  await expect(allTab).toHaveAttribute("aria-selected", "true");
}

const firestoreProject = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "demo-flu";
const firestoreHost = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").replace(/^https?:\/\//, "");
const firestoreDatabase = `http://${firestoreHost}/v1/projects/${firestoreProject}/databases/(default)`;

const CASE_IDS = [
  "interest_next_steps", "scp_application_received", "approval_status_inquiry", "submission_support",
  "requirements_question", "asset_request", "eligibility_question", "reward_overview",
  "pricing_guide_redirect", "counter_offer_guideline_reply", "fixed_terms_inquiry", "access_concern",
  "discontinue_notice", "out_of_office", "closing_acknowledgment", "call_request", "settlement_dispute",
  "out_of_scope_request", "opt_out_or_legal", "confusion_or_short",
  // 0.6.111 (111e): casebook_v9 adds the messenger contact-channel case.
  "contact_channel_request",
];
// The server intentionally omits the auto_close acknowledgment case from this management console.
const VISIBLE_CASE_IDS = CASE_IDS.filter((caseId) => caseId !== "closing_acknowledgment");

const waitForCallable = (page: Page, name: string) => page.waitForResponse((response) =>
  response.request().method() === "POST" && response.url().includes(name),
);

async function callableResult(response: import("@playwright/test").Response) {
  const body = await response.json().catch(() => null) as { result?: any; error?: { status?: string; message?: string } } | null;
  return { body, httpOk: response.ok() };
}

async function readRawFirestoreDocument(path: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${firestoreDatabase}/documents/${path}`, { headers: { Authorization: "Bearer owner" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to back up ${path}: ${response.status} ${await response.text()}`);
  const document = await response.json() as { name: string; fields?: Record<string, unknown> };
  return { name: document.name, fields: document.fields ?? {} };
}

async function restoreRawFirestoreDocument(path: string, previous: Record<string, unknown> | null): Promise<void> {
  if (!previous) {
    await deleteDocument(path.split("/").slice(0, -1).join("/"), path.split("/").at(-1)!);
    return;
  }
  const response = await fetch(`${firestoreDatabase}/documents:commit`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ writes: [{ update: previous }] }),
  });
  if (!response.ok) throw new Error(`Failed to restore ${path}: ${response.status} ${await response.text()}`);
}

async function seedStaleArmedCase(caseId: string) {
  const existing = (await readCollection("chat_auto_case_permits")).find((row) => row.id === caseId);
  if (existing) throw new Error(`Refusing to overwrite existing emulator permit fixture ${caseId}`);
  await commitDocument(`chat_auto_case_permits/${caseId}`, {
    schemaVersion: 1,
    caseId,
    state: "armed",
    armed: true,
    casebookHash: "stale-audit-fixture",
    casebookVersion: "casebook_v8",
    modelVersion: "stale-audit-fixture",
    counters: { consecutiveHumanUneditedApprovedSent: 0, totalHumanUneditedApprovedSent: 0, unavailableEvidenceCount: 0 },
    evalEvidence: null,
    updatedAtIso: "2026-09-29T00:00:00.000Z",
    updatedByHash: "audit-fixture",
    source: "functions.chatAutoCasePermit",
  });
}

async function seedAutoReplySettings(
  rules: Array<{ id: string; label: string; desc: string; enabled: boolean; scope: "ai" | "human" }> = [
    { id: "audit-rule", label: "감사 규칙", desc: "테스트 전용 설정", enabled: true, scope: "ai" },
  ],
): Promise<() => Promise<void>> {
  const previousAutoReply = await readRawFirestoreDocument("auto_reply/default");
  const previousSettings = await readRawFirestoreDocument("settings/default");
  await commitDocument("auto_reply/default", {
    enabled: false,
    model: "emulator-audit",
    tone: "정중·간결",
    workingHours: "에뮬레이터 전용",
    rules,
  });
  return async () => {
    await restoreRawFirestoreDocument("auto_reply/default", previousAutoReply);
    await restoreRawFirestoreDocument("settings/default", previousSettings);
  };
}

test.describe("/chat/auto adversarial button audit (emulator only)", () => {
  test("every managed case wires its detail, editor when eligible, and selected history to the server", async ({ page }) => {
    test.setTimeout(180_000);
    const snapshotResponsePromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const response = await snapshotResponsePromise;
    const { body, httpOk } = await callableResult(response);
    expect(httpOk, JSON.stringify(body)).toBe(true);
    expect(body?.result?.ok).toBe(true);
    expect(body?.result?.rows.map((row: { caseId: string }) => row.caseId).sort()).toEqual([...VISIBLE_CASE_IDS].sort());

    const rows = page.locator('[data-testid^="permit-case-"]');
    await expect(rows).toHaveCount(20);
    for (const caseId of VISIBLE_CASE_IDS) await expect(page.getByTestId(`permit-case-${caseId}`)).toBeVisible();
    await expect(page.getByTestId("permit-case-closing_acknowledgment")).toHaveCount(0);
    await expect(page.getByTestId("permit-case-interest_next_steps").getByRole("button", { name: "최신 검증 실행" })).toBeEnabled();
    await expect(page.getByTestId("permit-case-confusion_or_short").getByRole("button", { name: "최신 검증 실행" })).toBeDisabled();
    await expect(page.getByTestId("permit-case-opt_out_or_legal").getByRole("button", { name: "최신 검증 실행" })).toBeDisabled();

    for (const caseId of VISIBLE_CASE_IDS) {
      const row = page.getByTestId(`permit-case-${caseId}`);
      const identifierDetails = row.locator("details").first();
      await identifierDetails.locator("summary").click();
      await expect(identifierDetails).toHaveAttribute("open", "");
      await identifierDetails.locator("summary").click();
      await expect(identifierDetails).not.toHaveAttribute("open", "");

      const replyDetails = row.getByTestId(`permit-reply-text-${caseId}`);
      await replyDetails.locator("summary").click();
      await expect(replyDetails).toHaveAttribute("open", "");
      await replyDetails.locator("summary").click();
      await expect(replyDetails).not.toHaveAttribute("open", "");

      const editorToggle = row.getByTestId(`case-reply-toggle-${caseId}`);
      if (await editorToggle.count()) {
        await editorToggle.click();
        await expect(row.getByTestId(`case-reply-editor-panel-${caseId}`)).toBeVisible();
        await editorToggle.click();
        await expect(row.getByTestId(`case-reply-editor-panel-${caseId}`)).toHaveCount(0);
      }

      const historyResponsePromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
      await row.getByRole("button", { name: "최근 발송 보기" }).click();
      const historyResponse = await historyResponsePromise;
      const history = await callableResult(historyResponse);
      expect(history.httpOk, `${caseId}: ${JSON.stringify(history.body)}`).toBe(true);
      expect(history.body?.result?.ok, caseId).toBe(true);
      expect(historyResponse.request().postDataJSON().data, caseId).toMatchObject({ selectedCaseId: caseId });
      await expect(row.getByRole("button", { name: "최근 발송 숨기기" })).toBeVisible();
      await expect.poll(async () =>
        (await row.locator("table").count()) + (await row.getByText("확정 발송 기록이 없습니다.").count()),
      ).toBeGreaterThan(0);
      await row.getByRole("button", { name: "최근 발송 숨기기" }).click();
      await expect(row.getByRole("button", { name: "최근 발송 보기" })).toBeVisible();
    }
  });

  test("reply editor performs real save, detects a competing revision, reloads while preserving text, and resets", async ({ page }) => {
    test.setTimeout(120_000);
    const caseId = "confusion_or_short";
    const original = (await readCollection("chat_auto_case_replies")).find((row) => row.id === "config");
    if (original) throw new Error("Expected the seeded emulator to have no operator reply overrides");
    const secondPage = await page.context().newPage();
    try {
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      await loginAsAdmin(secondPage, "/chat/auto");
      await showAllCasebookEntries(secondPage);
      const editor = page.getByTestId(`permit-case-${caseId}`);
      const staleEditor = secondPage.getByTestId(`permit-case-${caseId}`);
      await expect(editor).toBeVisible();
      await editor.getByTestId(`case-reply-toggle-${caseId}`).click();
      await staleEditor.getByTestId(`case-reply-toggle-${caseId}`).click();
      await editor.getByTestId(`case-reply-text-${caseId}`).fill("Hello, could you clarify which part you would like help with?");
      const saveResponsePromise = waitForCallable(page, "saveChatAutoCaseReply");
      await editor.getByTestId(`case-reply-save-${caseId}`).click();
      const saveResponse = await saveResponsePromise;
      const saved = await callableResult(saveResponse);
      expect(saved.httpOk, JSON.stringify(saved.body)).toBe(true);
      expect(saved.body?.result).toMatchObject({ ok: true, caseId, replyText: { source: "operator_override", reviewRequired: true, automaticStatus: "human_review_only" } });
      expect(await readCollection("chat_auto_case_replies")).toContainEqual(expect.objectContaining({ id: "config" }));

      await staleEditor.getByTestId(`case-reply-text-${caseId}`).fill("Second operator's stale draft stays visible.");
      const conflictResponsePromise = waitForCallable(secondPage, "saveChatAutoCaseReply");
      await staleEditor.getByTestId(`case-reply-save-${caseId}`).click();
      const conflictResponse = await conflictResponsePromise;
      const conflict = await callableResult(conflictResponse);
      expect(conflict.httpOk, JSON.stringify(conflict.body)).toBe(false);
      await expect(staleEditor.getByTestId(`case-reply-conflict-${caseId}`)).toBeVisible();
      await expect(staleEditor.getByTestId(`case-reply-text-${caseId}`)).toHaveValue("Second operator's stale draft stays visible.");
      const reloadResponsePromise = waitForCallable(secondPage, "getChatAutoCasebookSnapshot");
      await staleEditor.getByRole("button", { name: "최신 상태 불러오기" }).click();
      const reloadResponse = await reloadResponsePromise;
      const reloaded = await callableResult(reloadResponse);
      expect(reloaded.httpOk, JSON.stringify(reloaded.body)).toBe(true);
      expect(reloaded.body?.result?.ok).toBe(true);
      await expect(staleEditor.getByTestId(`case-reply-text-${caseId}`)).toHaveValue("Second operator's stale draft stays visible.");

      const retrySavePromise = waitForCallable(secondPage, "saveChatAutoCaseReply");
      await staleEditor.getByTestId(`case-reply-save-${caseId}`).click();
      expect((await callableResult(await retrySavePromise)).body?.result?.ok).toBe(true);
      await expect(staleEditor.getByRole("button", { name: "기본 답신 문구로 되돌리기" })).toBeVisible();
      await staleEditor.getByRole("button", { name: "기본 답신 문구로 되돌리기" }).click();
      await expect(staleEditor.getByRole("button", { name: "취소" })).toBeVisible();
      await staleEditor.getByRole("button", { name: "취소" }).click();
      await expect(staleEditor.getByRole("button", { name: "기본 답신 문구로 되돌리기" })).toBeVisible();
      await staleEditor.getByRole("button", { name: "기본 답신 문구로 되돌리기" }).click();
      const resetResponsePromise = waitForCallable(secondPage, "resetChatAutoCaseReply");
      await staleEditor.getByTestId(`case-reply-reset-confirm-${caseId}`).click();
      const reset = await callableResult(await resetResponsePromise);
      expect(reset.httpOk, JSON.stringify(reset.body)).toBe(true);
      expect(reset.body?.result).toMatchObject({ ok: true, caseId });
      expect(reset.body?.result?.replyText?.source).not.toBe("operator_override");
      expect((await readCollection("chat_auto_case_replies")).find((row) => row.id === "config")).toMatchObject({
        schemaVersion: 1,
        cases: { [caseId]: { text: null, revision: expect.any(Number) } },
      });
    } finally {
      await deleteDocument("chat_auto_case_replies", "config");
      await secondPage.close();
    }
  });

  test("every server-editable case saves a reply (auto_ok: permit-gated, others: human-review) and resets without arming or sending", async ({ page }) => {
    test.setTimeout(240_000);
    const originalReplyConfig = await readRawFirestoreDocument("chat_auto_case_replies/config");
    if (originalReplyConfig) throw new Error("Refusing to overwrite an unexpected chat_auto_case_replies/config emulator fixture");

    const snapshotResponsePromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const snapshotResult = await callableResult(await snapshotResponsePromise);
    expect(snapshotResult.httpOk, JSON.stringify(snapshotResult.body)).toBe(true);
    expect(snapshotResult.body?.result?.ok).toBe(true);
    const editableRows = snapshotResult.body?.result?.rows?.filter((row: { replyText?: { editable?: boolean } }) => row.replyText?.editable === true) ?? [];
    const editableCaseIds = editableRows.map((row: { caseId: string }) => row.caseId);
    const expectedEditableCaseIds = VISIBLE_CASE_IDS.filter((caseId) => caseId !== "opt_out_or_legal").sort();
    expect([...editableCaseIds].sort()).toEqual(expectedEditableCaseIds);

    const originalPermitDocs = new Map<string, Record<string, unknown> | null>();
    for (const caseId of editableCaseIds) {
      originalPermitDocs.set(caseId, await readRawFirestoreDocument(`chat_auto_case_permits/${caseId}`));
    }
    const forbiddenRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /setChatAutoCasePermitArming|runChatAutoCasePermitEval|sendChatAutoCaseHeldBacklogNow/.test(request.url())) {
        forbiddenRequests.push(request.url());
      }
    });

    try {
      for (const serverRow of editableRows as Array<{ caseId: string; replyText: { text: string | null; editable: boolean; state: string } }>) {
        const { caseId } = serverRow;
        const row = page.getByTestId(`permit-case-${caseId}`);
        const draft = "안내를 확인했습니다. 담당자가 검토한 뒤 답변드리겠습니다.";
        await expect(row).toBeVisible();
        const toggle = row.getByTestId(`case-reply-toggle-${caseId}`);
        await expect(toggle).toBeEnabled();
        await toggle.click();
        const editorText = row.getByTestId(`case-reply-text-${caseId}`);
        await expect(editorText).toBeVisible();
        await editorText.fill(draft);
        const saveResponsePromise = waitForCallable(page, "saveChatAutoCaseReply");
        await row.getByTestId(`case-reply-save-${caseId}`).click();
        const saveResponse = await saveResponsePromise;
        const save = await callableResult(saveResponse);
        expect(save.httpOk, `${caseId}: ${JSON.stringify(save.body)}`).toBe(true);
        expect(save.body?.result).toMatchObject({
          ok: true,
          caseId,
          // 0.6.106: a saved reply on an auto_ok case is permit-gated (auto-sendable once a super_admin arms
          // that exact revision); only non-auto_ok cases stay human-review-only.
          replyText: serverRow.replyText.state === "auto_ok"
            ? { text: draft, source: "operator_override", editable: true, reviewRequired: false, automaticStatus: "permit_gated" }
            : { text: draft, source: "operator_override", editable: true, reviewRequired: true, automaticStatus: "human_review_only" },
        });
        await expect(editorText).toHaveValue(draft);
        await expect(row).toContainText(draft);
        const armButton = row.getByRole("button", { name: "자동발송 켜기" });
        if (await armButton.count()) await expect(armButton).toBeDisabled();

        await row.getByRole("button", { name: "기본 답신 문구로 되돌리기" }).click();
        await expect(row.getByTestId(`case-reply-reset-confirm-${caseId}`)).toBeVisible();
        const resetResponsePromise = waitForCallable(page, "resetChatAutoCaseReply");
        await row.getByTestId(`case-reply-reset-confirm-${caseId}`).click();
        const resetResponse = await resetResponsePromise;
        const reset = await callableResult(resetResponse);
        expect(reset.httpOk, `${caseId}: ${JSON.stringify(reset.body)}`).toBe(true);
        expect(reset.body?.result?.ok).toBe(true);
        expect(reset.body?.result?.caseId).toBe(caseId);
        expect(reset.body?.result?.replyText?.source).not.toBe("operator_override");
        await expect(editorText).toHaveValue(serverRow.replyText.text ?? "");
        await expect(row).not.toContainText(draft);
        if (await armButton.count()) await expect(armButton).toBeDisabled();
        await toggle.click();
        await expect(editorText).toHaveCount(0);
      }
      expect(forbiddenRequests).toEqual([]);
      for (const caseId of editableCaseIds) {
        const stored = (await readCollection("chat_auto_case_replies")).find((row) => row.id === "config");
        const cases = stored?.cases && typeof stored.cases === "object" && !Array.isArray(stored.cases)
          ? stored.cases as Record<string, { text?: unknown }>
          : {};
        expect(cases[caseId]?.text ?? null, caseId).toBeNull();
        const permit = await readRawFirestoreDocument(`chat_auto_case_permits/${caseId}`);
        const originalPermit = originalPermitDocs.get(caseId);
        if (originalPermit) {
          expect(permit?.fields, `${caseId} existing permit must be disarmed by reply mutation`).toMatchObject({
            state: { stringValue: "disarmed" },
            armed: { booleanValue: false },
            evalEvidence: { nullValue: "NULL_VALUE" },
          });
        } else {
          expect(permit, `${caseId} without prior permit must not create one`).toBeNull();
        }
      }
    } finally {
      for (const [caseId, document] of originalPermitDocs) {
        await restoreRawFirestoreDocument(`chat_auto_case_permits/${caseId}`, document);
      }
      await restoreRawFirestoreDocument("chat_auto_case_replies/config", originalReplyConfig);
    }
  });

  test("AI proposal is visibly UI-only until applied and saved separately", async ({ page }) => {
    const caseId = "confusion_or_short";
    const proposal = "Hello, could you clarify which part you would like help with?";
    const mutations: string[] = [];
    let suggestionPayload: Record<string, unknown> | null = null;
    // UI-only simulation: never invokes Vertex/Gateway; the save/reset tests above hit the emulator.
    await page.route(/suggestChatAutoCaseReply/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      suggestionPayload = route.request().postDataJSON().data;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: {
        ok: true, caseId, text: proposal, reason: "Audit-only UI proposal", provider: "vertex", modelId: "emulator-ui-only", transport: "vertex_direct", cacheHit: true,
      } }) });
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && /saveChatAutoCaseReply|resetChatAutoCaseReply/.test(request.url())) mutations.push(request.url());
    });
    const snapshotResponsePromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const snapshot = await callableResult(await snapshotResponsePromise);
    expect(snapshot.httpOk, JSON.stringify(snapshot.body)).toBe(true);
    const baseReply = snapshot.body?.result?.rows?.find((row: { caseId: string }) => row.caseId === caseId)?.replyText;
    expect(baseReply?.revisionHash).toBeTruthy();
    const row = page.getByTestId(`permit-case-${caseId}`);
    await row.getByTestId(`case-reply-toggle-${caseId}`).click();
    await row.getByTestId(`case-reply-instruction-${caseId}`).fill("짧은 문의를 정중하게 확인해 주세요.");
    const suggestResponsePromise = waitForCallable(page, "suggestChatAutoCaseReply");
    await row.getByTestId(`case-reply-suggest-${caseId}`).click();
    const suggestion = await callableResult(await suggestResponsePromise);
    expect(suggestion.httpOk, JSON.stringify(suggestion.body)).toBe(true);
    expect(suggestion.body?.result).toMatchObject({ ok: true, caseId, text: proposal });
    expect(suggestionPayload).toMatchObject({
      caseId,
      operatorInstruction: "짧은 문의를 정중하게 확인해 주세요.",
      expectedRevision: baseReply.revision,
      expectedRevisionHash: baseReply.revisionHash,
    });
    await expect(row.getByTestId(`case-reply-suggestion-${caseId}`)).toContainText(proposal);
    expect(mutations).toEqual([]);
    await row.getByTestId(`case-reply-apply-suggestion-${caseId}`).click();
    await expect(row.getByTestId(`case-reply-text-${caseId}`)).toHaveValue(proposal);
    expect(mutations).toEqual([]);
  });

  test("non-conflict Vertex precondition keeps the draft and allows a retry", async ({ page }) => {
    const caseId = "confusion_or_short";
    let suggestionCalls = 0;
    await page.route(/suggestChatAutoCaseReply/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      suggestionCalls += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: {
        status: "FAILED_PRECONDITION",
        message: "failed-precondition",
        details: { errorCode: "chat_auto_case_reply_failed_precondition" },
      } }) });
    });
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const row = page.getByTestId(`permit-case-${caseId}`);
    await row.getByTestId(`case-reply-toggle-${caseId}`).click();
    const draft = "Keep this operator draft while suggestion is unavailable.";
    await row.getByTestId(`case-reply-text-${caseId}`).fill(draft);
    const suggest = row.getByTestId(`case-reply-suggest-${caseId}`);
    const firstResponsePromise = waitForCallable(page, "suggestChatAutoCaseReply");
    await suggest.click();
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status()).toBe(200);
    expect((await firstResponse.json()).error?.status).toBe("FAILED_PRECONDITION");
    await expect(row.getByRole("alert")).toContainText("답신 기능의 실행 조건을 확인하지 못했습니다");
    await expect(row.getByTestId(`case-reply-conflict-${caseId}`)).toHaveCount(0);
    await expect(row.getByTestId(`case-reply-text-${caseId}`)).toHaveValue(draft);
    await expect(suggest).toBeEnabled();
    const retryResponsePromise = waitForCallable(page, "suggestChatAutoCaseReply");
    await suggest.click();
    expect((await retryResponsePromise).status()).toBe(200);
    expect(suggestionCalls).toBe(2);
    await expect(row.getByTestId(`case-reply-text-${caseId}`)).toHaveValue(draft);
    await expect(row.getByTestId(`case-reply-suggest-${caseId}`)).toBeEnabled();
  });

  test("latest-eval button reaches the emulator callable and shows its non-production rejection", async ({ page }) => {
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const row = page.getByTestId("permit-case-interest_next_steps");
    await expect(row).toBeVisible();
    const evalResponsePromise = waitForCallable(page, "runChatAutoCasePermitEval");
    await row.getByRole("button", { name: "최신 검증 실행" }).click();
    const response = await evalResponsePromise;
    const outcome = await callableResult(response);
    expect(outcome.httpOk).toBe(false);
    expect(outcome.body?.error?.status).toBe("FAILED_PRECONDITION");
    await expect(page.getByRole("alert").filter({ hasText: "케이스별 자동발송 작업이 실패했습니다." })).toBeVisible();
    expect((await readCollection("chat_auto_case_permits")).some((permit) => permit.id === "interest_next_steps")).toBe(false);
  });

  test("operator override stays absent unless a real eligible row exists", async ({ page }) => {
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    const section = page.getByTestId("permit-operator-override");
    await expect(section).toBeVisible();
    await expect(section).toContainText("super_admin 전용");
    await expect(section).toContainText("현재 예외 승인 조건을 모두 충족한 케이스가 없습니다.");
    await expect(section.locator("textarea")).toHaveCount(0);
    await expect(section.locator('input[type="checkbox"]')).toHaveCount(0);
  });

  test("cost-guide link navigates to the policy heading and returns to chat automation", async ({ page }) => {
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    await page.getByRole("link", { name: "비용 가이드", exact: true }).click();
    await expect(page).toHaveURL(/\/flu\/cost-guide(?:\?.*)?$/);
    await expect(page.getByRole("heading", { name: "협상 가이드라인 관리" })).toBeVisible();
    await page.goto("/chat/auto");
    await expect(page.getByRole("heading", { name: "AI 자동응답 설정" })).toBeVisible();
    await expect(page.getByTestId("permit-chat-auto-ui")).toBeVisible();
  });

  test("candidate and confirmed-history links open their seeded emulator conversation", async ({ page }, testInfo) => {
    const fixtureId = `chat-auto-audit-links-${Date.now()}`;
    const sendId = `chat-auto-audit-send-${Date.now()}`;
    const fixtureName = `채팅 자동응답 링크 감사 픽스처 ${Date.now()}`;
    const nowIso = new Date().toISOString();
    const diagnostics: Array<Record<string, unknown>> = [];
    let diagnosticError: string | null = null;
    const record = (event: string, details: Record<string, unknown>) => {
      diagnostics.push({ event, at: new Date().toISOString(), ...details });
    };
    page.on("request", (request) => {
      if (!request.url().includes("/us-central1/")) return;
      let data: unknown = undefined;
      try {
        const body = request.postDataJSON();
        data = request.url().includes("/listConversations") ? body?.data : undefined;
      } catch { /* Some requests have no JSON body. */ }
      record("request", { method: request.method(), endpoint: new URL(request.url()).pathname.split("/").at(-1), data });
    });
    page.on("response", (response) => {
      if (!response.url().includes("/us-central1/")) return;
      record("response", {
        method: response.request().method(),
        endpoint: new URL(response.url()).pathname.split("/").at(-1),
        status: response.status(),
      });
    });
    page.on("requestfinished", async (request) => {
      if (!request.url().includes("/us-central1/")) return;
      const response = await request.response().catch(() => null);
      record("requestfinished", {
        method: request.method(),
        endpoint: new URL(request.url()).pathname.split("/").at(-1),
        status: response?.status() ?? null,
        timing: request.timing(),
      });
    });
    page.on("requestfailed", (request) => {
      if (!request.url().includes("/us-central1/")) return;
      record("requestfailed", {
        method: request.method(),
        endpoint: new URL(request.url()).pathname.split("/").at(-1),
        error: request.failure()?.errorText ?? "unknown",
      });
    });
    page.on("console", (message) => {
      if (message.type() === "error") record("console-error", { text: message.text() });
    });
    page.on("pageerror", (error) => record("pageerror", { message: error.message }));
    await commitDocument(`conversations/${fixtureId}`, {
      id: fixtureId,
      threadId: fixtureId,
      creatorId: `creator-${fixtureId}`,
      creatorName: fixtureName,
      creatorHandle: `@audit_${Date.now()}`,
      creatorEmail: "audit-fixture@demo-flu.test",
      mailAccountId: "test-drama-personal",
      counterpartyRegistered: true,
      lastMessage: "Emulator-only candidate/history link fixture",
      lastMessageFrom: "creator",
      lastMessageAtIso: nowIso,
      lastInboundAtIso: nowIso,
      updatedAtIso: nowIso,
      hasCreatorReply: true,
      unread: 0,
      aiActive: false,
      messages: [],
      caseCandidates: [{
        caseId: "interest_next_steps",
        title: "링크 검증 후보",
        reasonCode: "permit_missing",
        clampReasonIds: ["unsupported_fact_token"],
      }],
      permitDenyReasons: ["permit_missing"],
      clampReasonIds: ["unsupported_fact_token"],
      autoRepliedCaseIds: [],
    });
    await commitDocument(`chat_auto_case_committed_sends/${sendId}`, {
      caseId: "interest_next_steps",
      conversationId: fixtureId,
      sender: "ai",
      approval: "approved",
      deliveryState: "sent",
      providerConfirmed: true,
      bounced: false,
      complained: false,
      optedOut: false,
      suppressed: false,
      sentAtIso: nowIso,
    });
    try {
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const candidate = page.getByText(fixtureName, { exact: true }).locator("..").locator("..");
      await expect(candidate.getByRole("link", { name: "채팅에서 검토" })).toHaveAttribute("href", `/chat?conversationId=${encodeURIComponent(fixtureId)}`);
      record("candidate-link-click-start", { url: page.url() });
      await candidate.getByRole("link", { name: "채팅에서 검토" }).click();
      record("candidate-link-navigation-complete", { url: page.url() });
      await expect(page).toHaveURL(new RegExp(`/chat\\?conversationId=${fixtureId}$`));
      await expect(page.getByText(fixtureName, { exact: true }).first()).toBeVisible();
      record("candidate-thread-visible", { url: page.url() });

      await page.goto("/chat/auto");
      await showAllCasebookEntries(page);
      const caseRow = page.getByTestId("permit-case-interest_next_steps");
      const historyResponsePromise = page.waitForResponse((response) => {
        if (response.request().method() !== "POST" || !response.url().includes("getChatAutoCasebookSnapshot")) return false;
        try { return response.request().postDataJSON().data?.selectedCaseId === "interest_next_steps"; } catch { return false; }
      });
      await caseRow.getByRole("button", { name: "최근 발송 보기" }).click();
      const historyResponse = await historyResponsePromise;
      const history = await callableResult(historyResponse);
      expect(history.httpOk, JSON.stringify(history.body)).toBe(true);
      expect(historyResponse.request().postDataJSON().data).toMatchObject({ selectedCaseId: "interest_next_steps" });
      const sendHistory = page.getByTestId("permit-send-history-interest_next_steps");
      const historyLink = sendHistory.getByRole("link", { name: "채팅에서 검토" });
      await expect(historyLink).toHaveAttribute("href", `/chat?conversationId=${encodeURIComponent(fixtureId)}`);
      await historyLink.click();
      await expect(page).toHaveURL(new RegExp(`/chat\\?conversationId=${fixtureId}$`));
      await expect(page.getByText(fixtureName, { exact: true }).first()).toBeVisible();
    } catch (error) {
      diagnosticError = error instanceof Error ? error.message : String(error);
      const screenshotPath = testInfo.outputPath("candidate-link-navigation-failure.png");
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await testInfo.attach("candidate-link-navigation-failure", { path: screenshotPath, contentType: "image/png" }).catch(() => undefined);
      throw error;
    } finally {
      const visibleText = await page.locator('[data-testid="app-main"]').innerText().catch(() => "");
      const artifact = {
        finalUrl: page.url(),
        fixtureId,
        fixtureName,
        visibleText: visibleText.slice(0, 5000),
        events: diagnostics,
        error: diagnosticError,
      };
      try {
        const diagnosticPath = testInfo.outputPath("candidate-link-navigation-diagnostics.json");
        const diagnosticJson = JSON.stringify(artifact, null, 2);
        await writeFile(diagnosticPath, diagnosticJson);
        await testInfo.attach("candidate-link-navigation-diagnostics", {
          path: diagnosticPath,
          contentType: "application/json",
        });
      } finally {
        await deleteDocument("chat_auto_case_committed_sends", sendId);
        await deleteDocument("conversations", fixtureId);
      }
    }
  });

  test("operator override inputs gate the UI action and bind the entered reason to the simulated request", async ({ page }) => {
    let simulatedArmed = false;
    let actionPayload: Record<string, unknown> | null = null;
    // UI-only: use the real sanitized snapshot as a base, then project one controlled eligible row.
    // The arming response is intercepted too; no permit/eval state is written to Firestore.
    await page.route(/getChatAutoCasebookSnapshot/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      const row = payload.result?.rows?.find((item: { caseId?: string }) => item.caseId === "interest_next_steps");
      expect(row).toBeTruthy();
      row.armed = simulatedArmed;
      row.state = simulatedArmed ? "armed" : "candidate";
      row.counters.consecutiveHumanUneditedApprovedSent = 0;
      row.pins.casebookMatchesCurrent = true;
      row.pins.modelMatchesCurrent = true;
      row.eval = {
        ...row.eval,
        status: "passed",
        runId: "ui-audit-override-eval",
        evaluatedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        heldoutTotal: 2,
        heldoutPassed: 2,
        rerollTotal: 2,
        rerollStable: 2,
        transports: ["vertex_direct"],
        estimatedCostUsd: 0,
      };
      row.replyText.state = "auto_ok";
      row.replyText.source = "static";
      await route.fulfill({ response, json: payload });
    });
    await page.route(/setChatAutoCasePermitArming/, async (route) => {
      actionPayload = route.request().postDataJSON().data;
      simulatedArmed = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true } }) });
    });

    try {
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      await expect(page.getByTestId("permit-operator-override-interest_next_steps")).toBeVisible();
      const section = page.getByTestId("permit-operator-override-interest_next_steps");
      const reason = section.locator("textarea");
      const confirmation = section.locator('input[type="checkbox"]');
      const approve = section.getByRole("button", { name: "수량 기준 예외로 자동발송 켜기" });
      await expect(approve).toBeDisabled();
      await reason.fill("too short");
      await confirmation.check();
      await expect(approve).toBeDisabled();
      await reason.fill("검증된 예외 사유를 입력합니다.");
      await confirmation.uncheck();
      await expect(approve).toBeDisabled();
      await confirmation.check();
      await expect(approve).toBeEnabled();
      const armingResponsePromise = waitForCallable(page, "setChatAutoCasePermitArming");
      const reloadSnapshotPromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
      await approve.click();
      const response = await armingResponsePromise;
      expect((await callableResult(response)).httpOk).toBe(true);
      expect(actionPayload).toMatchObject({
        caseId: "interest_next_steps",
        action: "arm",
        operatorOverride: true,
        overrideReason: "검증된 예외 사유를 입력합니다.",
        expectedEvalRunId: "ui-audit-override-eval",
        expectedCounterFloor: 20,
      });
      const reload = await callableResult(await reloadSnapshotPromise);
      expect(reload.httpOk, JSON.stringify(reload.body)).toBe(true);
      await expect(section).toHaveCount(0);
      await expect(page.getByTestId("permit-case-interest_next_steps").getByRole("button", { name: "자동발송 끄기" })).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("arm button binds fresh pins and the reloaded simulated armed status", async ({ page }) => {
    let simulatedArmed = false;
    let actionPayload: Record<string, unknown> | null = null;
    const expectedPins = { casebookHash: "", modelVersion: "" };
    // UI-only: a real sanitized snapshot is used, but eval/counter status is explicitly projected
    // for control wiring. The fake arming result is intercepted; this does not prove server arming.
    await page.route(/getChatAutoCasebookSnapshot/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      const row = payload.result?.rows?.find((item: { caseId?: string }) => item.caseId === "interest_next_steps");
      expect(row).toBeTruthy();
      expectedPins.casebookHash = row.pins.casebookHash;
      expectedPins.modelVersion = row.pins.modelVersion;
      row.armed = simulatedArmed;
      row.state = simulatedArmed ? "armed" : "candidate";
      row.counters.consecutiveHumanUneditedApprovedSent = 20;
      row.counters.totalHumanUneditedApprovedSent = 20;
      row.pins.casebookMatchesCurrent = true;
      row.pins.modelMatchesCurrent = true;
      row.eval = {
        ...row.eval,
        status: "passed",
        runId: "ui-audit-arm-eval",
        evaluatedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        heldoutTotal: 2,
        heldoutPassed: 2,
        rerollTotal: 2,
        rerollStable: 2,
        transports: ["vertex_direct"],
        estimatedCostUsd: 0,
      };
      row.replyText.state = "auto_ok";
      row.replyText.source = "static";
      await route.fulfill({ response, json: payload });
    });
    await page.route(/setChatAutoCasePermitArming/, async (route) => {
      actionPayload = route.request().postDataJSON().data;
      simulatedArmed = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true } }) });
    });

    try {
      const initialSnapshotPromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const initialSnapshot = await callableResult(await initialSnapshotPromise);
      expect(initialSnapshot.httpOk, JSON.stringify(initialSnapshot.body)).toBe(true);
      expect(expectedPins.casebookHash).toBeTruthy();
      expect(expectedPins.modelVersion).toBeTruthy();
      const row = page.getByTestId("permit-case-interest_next_steps");
      await expect(row).toBeVisible();
      const armResponsePromise = waitForCallable(page, "setChatAutoCasePermitArming");
      const reloadSnapshotPromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
      await row.getByRole("button", { name: "자동발송 켜기" }).click();
      const armResponse = await armResponsePromise;
      expect((await callableResult(armResponse)).httpOk).toBe(true);
      const reload = await callableResult(await reloadSnapshotPromise);
      expect(reload.httpOk, JSON.stringify(reload.body)).toBe(true);
      expect(actionPayload).toMatchObject({
        caseId: "interest_next_steps",
        action: "arm",
        expectedCasebookHash: expectedPins.casebookHash,
        expectedModelVersion: expectedPins.modelVersion,
        expectedEvalRunId: "ui-audit-arm-eval",
        expectedCounterFloor: 20,
      });
      await expect(row).toContainText("켜짐");
      await expect(row.getByRole("button", { name: "자동발송 끄기" })).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("backlog continuation forwards the returned cursor and disables while the simulated page is pending", async ({ page }) => {
    const caseId = "interest_next_steps";
    const cursor = "ui-audit-next-page-cursor";
    const sendPayloads: Array<Record<string, unknown>> = [];
    let releaseContinuation: (() => void) | undefined;
    let countCalls = 0;
    const zeroSkipped = {
      takenOver: 0, alreadyReplied: 0, laneLocked: 0, aiInactive: 0, denied: 0,
      stale: 0, recentlyDenied: 0, orgExcluded: 0, manualReplyDetected: 0,
      caseMismatch: 0, humanReviewHeld: 0,
    };
    // UI-only: project this case as armed, stub its count, and return two synthetic send pages.
    // No real conversation is released and no mail/send service is called.
    await page.route(/getChatAutoCasebookSnapshot/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      const row = payload.result?.rows?.find((item: { caseId?: string }) => item.caseId === caseId);
      expect(row).toBeTruthy();
      row.armed = true;
      row.state = "armed";
      row.pins.casebookMatchesCurrent = true;
      row.pins.modelMatchesCurrent = true;
      row.eval = { ...row.eval, status: "passed", runId: "ui-audit-backlog-eval", expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(), transports: ["vertex_direct"] };
      row.replyText.state = "auto_ok";
      row.replyText.source = "static";
      // The page may supersede/abort this in-flight snapshot (a newer request replaces it) before we
      // fulfill; Playwright then reports "Route is already handled" — only that race is tolerated.
      await route.fulfill({ response, json: payload }).catch((error: Error) => {
        if (!/already handled/i.test(error.message)) throw error;
      });
    });
    await page.route(/getChatAutoCaseHeldBacklogCount/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      countCalls += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true, caseId, heldCount: 2, scanCap: 50, scannedCapped: false } }) });
    });
    let sendPage = 0;
    await page.route(/sendChatAutoCaseHeldBacklogNow/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      sendPage += 1;
      sendPayloads.push(route.request().postDataJSON().data);
      if (sendPage === 2) await new Promise<void>((resolve) => { releaseContinuation = resolve; });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: {
        ok: true, caseId, planned: 1, queued: 1, scanned: 50, skipped: zeroSkipped,
        denyReasons: {}, pagesProcessed: 1, nextCursor: sendPage === 1 ? cursor : null,
        stoppedReason: null, behaviorLog: {},
      } }) });
    });

    try {
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const row = page.getByTestId(`permit-case-${caseId}`);
      await row.getByRole("button", { name: "보류 확인" }).click();
      await expect(row.getByTestId(`case-backlog-held-count-${caseId}`)).toBeVisible();
      expect(countCalls).toBe(1);
      await row.getByRole("button", { name: "보류 확인 숨기기" }).click();
      await expect(row.getByTestId(`case-backlog-held-count-${caseId}`)).toHaveCount(0);
      await row.getByRole("button", { name: "보류 확인" }).click();
      await expect(row.getByTestId(`case-backlog-held-count-${caseId}`)).toBeVisible();
      expect(countCalls).toBe(2);
      await row.getByTestId(`case-backlog-send-button-${caseId}`).click();
      const firstResponsePromise = waitForCallable(page, "sendChatAutoCaseHeldBacklogNow");
      await row.getByTestId(`case-backlog-send-confirm-button-${caseId}`).click();
      const firstResponse = await firstResponsePromise;
      expect((await callableResult(firstResponse)).httpOk).toBe(true);
      await expect(row.getByTestId(`case-backlog-send-continue-${caseId}`)).toBeVisible();
      expect(sendPayloads).toHaveLength(1);
      expect(sendPayloads[0]).toMatchObject({ caseId });
      expect(sendPayloads[0]).not.toHaveProperty("cursor");

      const nextResponsePromise = waitForCallable(page, "sendChatAutoCaseHeldBacklogNow");
      await row.getByTestId(`case-backlog-send-continue-${caseId}`).click();
      await expect.poll(() => sendPayloads.length).toBe(2);
      const continueButton = row.getByTestId(`case-backlog-send-continue-${caseId}`);
      await expect(continueButton).toBeDisabled();
      expect(sendPayloads[1]).toMatchObject({ caseId, cursor });
      expect(sendPayloads).toHaveLength(2);
      releaseContinuation?.();
      const nextResponse = await nextResponsePromise;
      expect((await callableResult(nextResponse)).httpOk).toBe(true);
      await expect(row.getByTestId(`case-backlog-send-continue-${caseId}`)).toHaveCount(0);
      expect(sendPayloads).toHaveLength(2);
    } finally {
      releaseContinuation?.();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("stale armed row exposes safe inspection but confirm cannot enqueue; disarm succeeds on the emulator", async ({ page }) => {
    const caseId = "interest_next_steps";
    await seedStaleArmedCase(caseId);
    try {
      const queueIdsBefore = (await readCollection("auto_reply_queue")).map((row) => row.id).sort();
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      let backlogSendRequests = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("sendChatAutoCaseHeldBacklogNow")) backlogSendRequests += 1;
      });
      const row = page.getByTestId(`permit-case-${caseId}`);
      await expect(row).toContainText("검증 필요");
      await expect(row.getByRole("button", { name: "자동발송 끄기" })).toBeVisible();
      await row.getByRole("button", { name: "보류 확인" }).click();
      const countResponsePromise = waitForCallable(page, "getChatAutoCaseHeldBacklogCount");
      const countLocator = row.getByTestId(`case-backlog-held-count-${caseId}`);
      await expect(countLocator).toBeVisible();
      const countResponse = await countResponsePromise;
      const count = await callableResult(countResponse);
      expect(count.httpOk, JSON.stringify(count.body)).toBe(true);
      expect(count.body?.result).toMatchObject({ ok: true, caseId });
      await row.getByTestId(`case-backlog-send-button-${caseId}`).click();
      const confirmation = row.getByTestId(`case-backlog-send-confirm-${caseId}`);
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "취소" }).click();
      await expect(confirmation).toHaveCount(0);
      expect(backlogSendRequests).toBe(0);
      await row.getByTestId(`case-backlog-send-button-${caseId}`).click();
      await expect(confirmation).toBeVisible();
      await row.getByTestId(`case-backlog-send-confirm-button-${caseId}`).click();
      const sendResponse = await waitForCallable(page, "sendChatAutoCaseHeldBacklogNow");
      const send = await callableResult(sendResponse);
      expect(backlogSendRequests).toBe(1);
      expect(send.httpOk).toBe(false);
      expect(send.body?.error?.status).toBe("FAILED_PRECONDITION");
      await expect(row.getByText("보류 발송 처리에 실패했습니다.")).toBeVisible();
      expect((await readCollection("auto_reply_queue")).map((item) => item.id).sort()).toEqual(queueIdsBefore);

      const disarmPromise = waitForCallable(page, "setChatAutoCasePermitArming");
      await row.getByRole("button", { name: "자동발송 끄기" }).click();
      const disarm = await callableResult(await disarmPromise);
      expect(disarm.httpOk, JSON.stringify(disarm.body)).toBe(true);
      expect(disarm.body?.result).toMatchObject({ ok: true, rows: [{ caseId, state: "disarmed", armed: false }] });
      expect((await readCollection("chat_auto_case_permits")).find((permit) => permit.id === caseId)).toMatchObject({ state: "disarmed", armed: false });
    } finally {
      await deleteDocument("chat_auto_case_permits", caseId);
    }
  });

  test("ViewAs blocks the whole casebook and disables settings without sending console requests", async ({ page }) => {
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    await expect(page.getByTestId("permit-chat-auto-ui")).toBeVisible();
    await page.evaluate(() => sessionStorage.setItem("flu.viewAs.target", JSON.stringify({
      userId: "flu-emulator-growth-manager", email: "test-growth-manager@demo-flu", name: "Growth QA",
    })));
    const forbiddenCalls: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /getChatAutoCasebookSnapshot|listChatAutoCasebookUnclassified|previewChatAutoCaseReply|setChatAutoCasePermitArming|runChatAutoCasePermitEval|sendChatAutoCaseHeldBacklogNow|saveChatAutoCaseReply|resetChatAutoCaseReply|suggestChatAutoCaseReply|updateAutoReply/.test(request.url())) forbiddenCalls.push(request.url());
    });
    await page.reload();
    await expect(page.getByTestId("casebook-view-as-blocked")).toBeVisible();
    await expect(page.getByTestId("permit-chat-auto-ui")).toHaveCount(0);
    await expect(page.getByRole("switch").first()).toBeDisabled();
    expect(forbiddenCalls).toEqual([]);
  });

  test("global master switch requires target-count confirmation, blocks duplicate writes, and rolls back on failure", async ({ page }) => {
    test.setTimeout(60_000);
    const restoreSettings = await seedAutoReplySettings();
    let releaseWrite: (() => void) | undefined;
    let updateCalls = 0;
    await page.route(/updateAutoReply/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      updateCalls += 1;
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { status: "INTERNAL", message: "Audit-only forced failure" } }) });
    });
    try {
      const initialSnapshotPromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const initialSnapshot = await callableResult(await initialSnapshotPromise);
      expect(initialSnapshot.httpOk, JSON.stringify(initialSnapshot.body)).toBe(true);
      expect(initialSnapshot.body?.result?.rows).toHaveLength(20);
      const master = page.getByRole("switch").first();
      await expect(page.getByText("감사 규칙", { exact: true })).toBeVisible();
      await expect(master).toBeEnabled();
      const targetCountPromise = page.waitForResponse((response) => {
        if (response.request().method() !== "POST" || !response.url().includes("listConversations")) return false;
        try { return response.request().postDataJSON().data?.limit === 200; } catch { return false; }
      });
      await master.click();
      const targetCountResponse = await targetCountPromise;
      const targetCount = await callableResult(targetCountResponse);
      expect(targetCount.httpOk, JSON.stringify(targetCount.body)).toBe(true);
      expect(targetCountResponse.request().postDataJSON().data).toMatchObject({ limit: 200 });
      await expect(page.getByTestId("auto-reply-arm-preflight")).toBeVisible();
      await expect(page.getByText(/전역 자동응답을 켜면 지금 대화별 자동응답이 켜진 대화/)).toBeVisible();
      await page.getByTestId("auto-reply-arm-preflight").getByRole("button", { name: "취소" }).click();
      await expect(page.getByTestId("auto-reply-arm-preflight")).toHaveCount(0);
      expect(updateCalls).toBe(0);
      await master.click();
      await expect(page.getByTestId("auto-reply-arm-preflight")).toBeVisible();
      const failedWritePromise = waitForCallable(page, "updateAutoReply");
      await page.getByRole("button", { name: "확인하고 켜기" }).click();
      await expect.poll(() => updateCalls).toBe(1);
      // The delayed callable response is intercepted locally; no settings document is changed.
      await expect(master).toBeDisabled();
      await expect.poll(() => updateCalls).toBe(1);
      releaseWrite?.();
      const failedWrite = await callableResult(await failedWritePromise);
      expect(failedWrite.httpOk).toBe(false);
      expect(failedWrite.body?.error?.status).toBe("INTERNAL");
      const errorMessage = page.getByTestId("auto-reply-settings-error");
      await expect(errorMessage).toBeVisible();
      await expect(errorMessage).toHaveText(/\S/);
      await expect(master).toHaveAttribute("aria-checked", "false");
      expect(updateCalls).toBe(1);
    } finally {
      releaseWrite?.();
      await page.unrouteAll({ behavior: "wait" });
      await restoreSettings();
    }
  });

  test("global master switch persists ON through the emulator with every synthetic rule off", async ({ page }) => {
    const restoreSettings = await seedAutoReplySettings([]);
    try {
      const initialSnapshotPromise = waitForCallable(page, "getChatAutoCasebookSnapshot");
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const snapshot = await callableResult(await initialSnapshotPromise);
      expect(snapshot.httpOk, JSON.stringify(snapshot.body)).toBe(true);
      const master = page.getByRole("switch").first();
      await expect(master).toBeEnabled();
      await expect(page.getByTestId("auto-reply-rules-unconfigured")).toContainText("등록된 추가 자동화 규칙이 없습니다");
      const countResponsePromise = page.waitForResponse((response) => {
        if (response.request().method() !== "POST" || !response.url().includes("listConversations")) return false;
        try { return response.request().postDataJSON().data?.limit === 200; } catch { return false; }
      });
      await master.click();
      const countResponse = await countResponsePromise;
      expect(countResponse.ok()).toBe(true);
      await expect(page.getByTestId("auto-reply-arm-preflight")).toBeVisible();
      const updateResponsePromise = waitForCallable(page, "updateAutoReply");
      await page.getByRole("button", { name: "확인하고 켜기" }).click();
      const update = await callableResult(await updateResponsePromise);
      expect(update.httpOk, JSON.stringify(update.body)).toBe(true);
      expect(update.body?.result?.ok).toBe(true);
      expect((await readCollection("auto_reply")).find((row) => row.id === "default")).toMatchObject({ enabled: true, rules: [] });
      await expect(master).toHaveAttribute("aria-checked", "true");
    } finally {
      await restoreSettings();
    }
  });

  test("rule switches preserve the last acknowledged setting after a later write fails", async ({ page }) => {
    const restoreSettings = await seedAutoReplySettings();
    let updateCalls = 0;
    await page.route(/updateAutoReply/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      updateCalls += 1;
      if (updateCalls === 1) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true } }) });
      } else {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { status: "INTERNAL", message: "Audit-only second-write failure" } }) });
      }
    });
    try {
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const switches = page.getByRole("switch");
      const ruleSwitch = switches.nth(1);
      const initial = await ruleSwitch.getAttribute("aria-checked");
      expect(initial).toMatch(/true|false/);
      await ruleSwitch.click();
      await expect.poll(() => updateCalls).toBe(1);
      await expect(ruleSwitch).toHaveAttribute("aria-checked", initial === "true" ? "false" : "true");
      const failedWritePromise = waitForCallable(page, "updateAutoReply");
      await ruleSwitch.click();
      await expect.poll(() => updateCalls).toBe(2);
      const failedWrite = await callableResult(await failedWritePromise);
      expect(failedWrite.httpOk).toBe(false);
      expect(failedWrite.body?.error?.status).toBe("INTERNAL");
      await expect(ruleSwitch).toHaveAttribute("aria-checked", initial === "true" ? "false" : "true");
      const errorMessage = page.getByTestId("auto-reply-settings-error");
      await expect(errorMessage).toBeVisible();
      await expect(errorMessage).toHaveText(/\S/);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await restoreSettings();
    }
  });

  test("all six rule switches persist through the emulator while the global engine stays off", async ({ page }) => {
    const rules = Array.from({ length: 6 }, (_, index) => ({
      id: `audit-rule-${index + 1}`,
      label: `감사 규칙 ${index + 1}`,
      desc: "에뮬레이터 전용 설정",
      enabled: false,
      scope: index % 2 === 0 ? "ai" as const : "human" as const,
    }));
    const restoreSettings = await seedAutoReplySettings(rules);
    try {
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const switches = page.getByRole("switch");
      await expect(switches).toHaveCount(7);
      for (let index = 0; index < rules.length; index += 1) {
        const ruleSwitch = switches.nth(index + 1);
        await expect(ruleSwitch).toBeEnabled();
        await expect(ruleSwitch).toHaveAttribute("aria-checked", "false");
        const updateResponsePromise = waitForCallable(page, "updateAutoReply");
        await ruleSwitch.click();
        const update = await callableResult(await updateResponsePromise);
        expect(update.httpOk, `${rules[index].id}: ${JSON.stringify(update.body)}`).toBe(true);
        expect(update.body?.result?.ok, rules[index].id).toBe(true);
        await expect(ruleSwitch).toHaveAttribute("aria-checked", "true");
        const saved = (await readCollection("auto_reply")).find((row) => row.id === "default");
        expect(saved?.enabled, rules[index].id).toBe(false);
        expect(saved?.rules, rules[index].id).toEqual(rules.map((rule, ruleIndex) => ({
          ...rule,
          enabled: ruleIndex <= index,
        })));
      }
      const saved = (await readCollection("auto_reply")).find((row) => row.id === "default");
      expect(saved).toMatchObject({ enabled: false, rules: rules.map((rule) => ({ ...rule, enabled: true })) });
    } finally {
      await restoreSettings();
    }
  });

  test("missing auto-reply settings remain disabled for the real super admin", async ({ page }) => {
    const original = await readRawFirestoreDocument("auto_reply/default");
    if (!original) throw new Error("Expected seed-emulator to provide auto_reply/default for backup/restore");
    try {
      await deleteDocument("auto_reply", "default");
      await loginAsAdmin(page, "/chat/auto");
      await showAllCasebookEntries(page);
      const master = page.getByRole("switch").first();
      await expect(master).toBeDisabled();
      await expect(page.getByTestId("auto-reply-rules-empty-state")).toContainText("자동응답 설정이 아직 없습니다");
    } finally {
      await restoreRawFirestoreDocument("auto_reply/default", original);
    }
  });

  test("viewer preview cannot mutate global settings or case permits", async ({ page }) => {
    await loginAsAdmin(page, "/chat/auto");
    await showAllCasebookEntries(page);
    await page.getByTestId("app-sidebar").getByRole("button").filter({ hasText: /Super Admin|Admin|Manager/ }).click();
    await page.getByRole("button", { name: "Viewer" }).click();
    const panel = page.getByTestId("permit-chat-auto-ui");
    await expect(panel).toContainText("조회 전용");
    await showAllCasebookEntries(page);
    const switches = page.getByRole("switch");
    await expect(switches.first()).toBeDisabled();
    const requestNames: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /updateAutoReply|setChatAutoCasePermitArming|runChatAutoCasePermitEval/.test(request.url())) requestNames.push(request.url());
    });
    await expect(panel.getByRole("button", { name: "최신 검증 실행" }).first()).toBeDisabled();
    await expect(panel.getByRole("button", { name: /자동발송 켜기|자동발송 끄기/ }).first()).toBeDisabled();
    await expect(page.getByTestId("permit-operator-override")).toHaveCount(0);
    await expect.poll(async () => panel.getByTestId("permit-role-boundary").count()).toBeGreaterThan(0);
    expect(requestNames).toEqual([]);
  });
});
