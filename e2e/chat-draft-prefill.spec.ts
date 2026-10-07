import { test, expect } from "@playwright/test";
import { loginAsAdmin, readCollection } from "./helpers/emulator";

// S4/P4 (Q3/A11, RT-4/A4) + S1(d)/P1 — chat-open on-demand AI draft prefill.
//   Fixtures: scripts/seed-emulator.mjs appendAutoReplyFixtures()
//     - conv-autoreply-creator-reply : creator replied, no autoReplyDraftText/
//       autoReplyBlockedReason/humanDraftSuggestion set yet (the ingest-time gap this
//       feature fills). "좋아요, 진행하고 싶습니다!" carries no evidence signals beyond
//       followers, so under the default strict lowDataReviewMode gate it resolves to
//       needs_review — this spec asserts the ACTUAL default-config outcome, not a
//       fabricated auto_reply happy path.
//     - conv-autoreply-restricted : autoReplyStatus="blocked" + autoReplyBlockedReason
//       already recorded at ingest time (no on-demand call needed to show the banner).
//       Fixture id/name deliberately avoid the substring "blocked" — chat-ai.ts
//       runGatewayMock's seed folds conversationId/messageRef/trackingId/signal into one
//       string that mailHumanGate.decideHumanGate keyword-matches, and that matcher
//       treats any "blocked"/"bounce"/"rate-limit" substring as a real delivery-blocked
//       signal regardless of the actual reply content (mailHumanGate.ts:196).
// verify:e2e 체인에 이 spec 등록 필요(package.json 수정 권한 없음 — main에 보고).

test.describe("chat: on-demand AI draft prefill + reason banners", () => {
  test("creator-replied thread with no recorded draft/reason triggers exactly one on-demand prefill, and reopening serves it from cache", async ({ page }) => {
    await loginAsAdmin(page, "/chat?conversationId=conv-autoreply-creator-reply");
    await expect(page.getByText("Replied Creator", { exact: true })).toBeVisible({ timeout: 20_000 });

    // needs_review outcome (insufficient evidence under strict mode) -> humanDraftSuggestion
    // reference-only banner, NOT a silently-filled compose box.
    await expect(page.getByText("AI 참고용 — 발송 전 검토 필수")).toBeVisible({ timeout: 20_000 });
    const textarea = page.getByPlaceholder(/메시지 입력/);
    await expect(textarea).toHaveValue("");

    // Keyed by messageRef (stable, straight from the fixture) rather than conversationId —
    // the client payload's conversationId may be identity-canonicalized to a different
    // primary id than the raw Firestore doc id.
    await expect.poll(async () => {
      const rows = await readCollection("chat_draft_prefill_cache");
      return rows.filter((row) => row.messageRef === "msgref_fixture_replied_m2").length;
    }, { timeout: 20_000 }).toBe(1);

    // Reopen (fresh page load — client-side "1회" session dedup no longer applies) must be
    // served from the server-side cache: still exactly one cache doc, not a second one.
    await page.reload();
    await expect(page.getByText("AI 참고용 — 발송 전 검토 필수")).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => {
      const rows = await readCollection("chat_draft_prefill_cache");
      return rows.filter((row) => row.messageRef === "msgref_fixture_replied_m2").length;
    }, { timeout: 20_000 }).toBe(1);
  });

  test("using the reference-only draft requires an explicit confirmation before it reaches the composer", async ({ page }) => {
    await loginAsAdmin(page, "/chat?conversationId=conv-autoreply-creator-reply");
    await expect(page.getByText("AI 참고용 — 발송 전 검토 필수")).toBeVisible({ timeout: 20_000 });

    const textarea = page.getByPlaceholder(/메시지 입력/);
    await expect(textarea).toHaveValue("");

    await page.getByRole("button", { name: "이 초안 사용" }).click();
    await expect(page.getByText(/검토를 마쳤고 이 참고용 초안을 작성창에 채워/)).toBeVisible();
    await expect(textarea).toHaveValue("");

    // Cancel first — must not fill the composer.
    await page.getByRole("button", { name: "취소" }).click();
    await expect(textarea).toHaveValue("");

    // Confirm — now it fills the composer.
    await page.getByRole("button", { name: "이 초안 사용" }).click();
    await page.getByRole("button", { name: "사용 확정" }).click();
    await expect(textarea).not.toHaveValue("");
  });

  test("manual regeneration previews in a modal and preserves the composer until explicit apply", async ({ page }) => {
    await loginAsAdmin(page, "/chat");
    await page.getByRole("button").filter({ hasText: "@restricted_creator" }).click();
    await expect(page.getByText("Restricted Creator", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("AI 자동 초안 미생성")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/증거 부족.*사람 검수 필요/)).toBeVisible();

    // Server already recorded the reason at ingest time — no autoPrefill call needed on open.
    const cacheRows = await readCollection("chat_draft_prefill_cache");
    expect(cacheRows.some((row) => row.messageRef === "msgref_fixture_restricted_m2")).toBe(false);

    const composer = page.getByPlaceholder(/메시지 입력/);
    await composer.fill("운영자가 작성 중인 원문");

    await page.getByRole("button", { name: "AI 초안 다시 생성" }).click();
    const modal = page.getByRole("dialog", { name: "AI 초안 다시 생성" });
    await expect(modal).toBeVisible();
    await modal.getByLabel("이번 답장에 반영할 내용").fill("지원 통과 안내와 다음 단계 안내");
    await modal.getByRole("button", { name: "AI 초안 생성" }).click();
    await expect(modal.getByText("AI가 답장 초안을 만들고 있습니다")).toBeVisible();
    await expect(modal.getByRole("button", { name: "AI 초안 생성" })).toBeDisabled();

    // Retry recomputes fresh (bypasses the autoPrefill cache). The result stays in the
    // modal until the operator explicitly applies it, so the composer cannot be replaced
    // by an async response.
    await expect(modal.getByText("생성 결과 미리보기")).toBeVisible({ timeout: 20_000 });
    await expect(composer).toHaveValue("운영자가 작성 중인 원문");

    await modal.getByRole("button", { name: "초안 적용하기" }).click();
    await expect(modal).toBeHidden();
    await expect(composer).not.toHaveValue("운영자가 작성 중인 원문");
    await expect(page.getByRole("status").filter({ hasText: "이전 작성본" })).toBeVisible();
  });

  test("S1(d): a targeted conversation load that resolves to nothing renders an explicit missing banner, not a silent fallback", async ({ page }) => {
    await loginAsAdmin(page, "/chat?conversationId=totally-nonexistent-conversation-does-not-exist");
    await expect(page.getByRole("status").filter({ hasText: "요청한 대화를 찾을 수 없" })).toBeVisible({ timeout: 20_000 });
  });
});
