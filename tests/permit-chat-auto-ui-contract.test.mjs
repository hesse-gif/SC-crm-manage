import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

const dataSource = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/app/(app)/chat/auto/page.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/app/(app)/chat/auto/PermitCasePanel.tsx", import.meta.url), "utf8");
const roleGateSource = readFileSync(new URL("../src/lib/permitRoleGate.ts", import.meta.url), "utf8");
const combinedUiSource = `${pageSource}\n${panelSource}`;

// F1: extracts the pure role-gate function (a .ts file the plain node test runner cannot
// import directly, since it uses the "@/lib/data" path alias) into a standalone compiled
// module, mirroring the compileCountryConfidenceGate() technique in
// tests/stage1a-browser-regressions.test.mjs.
//
// 0.6.63 빌드 수리: permitManageRoleGate 는 원래 page.tsx 안에 있었으나(Next 15가 page.tsx의
// default export 외 named export를 거부해 프로덕션 빌드가 깨졌다) src/lib/permitRoleGate.ts 로
// 옮겨졌다. 이 테스트는 이제 그 lib 파일에서 직접 추출한다.
function compilePermitManageRoleGate() {
  const source = roleGateSource;
  const start = source.indexOf("export function permitManageRoleGate");
  assert.notEqual(start, -1, "missing permitManageRoleGate export");

  const dir = mkdtempSync(join(tmpdir(), "permit-manage-role-gate-"));
  writeFileSync(
    join(dir, "permit-manage-role-gate.ts"),
    [
      'type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";',
      source.slice(start),
    ].join("\n"),
    "utf8",
  );
  execFileSync(
    process.execPath,
    [
      new URL("node_modules/typescript/bin/tsc", root).pathname,
      join(dir, "permit-manage-role-gate.ts"),
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--target",
      "es2022",
      "--skipLibCheck",
      "--types",
      "--outDir",
      join(dir, "out"),
    ],
    { stdio: "pipe" },
  );
  return createRequire(join(dir, "out", "package.json"))("./permit-manage-role-gate.js");
}

test("frontend data layer exposes exactly the five permit callable wrappers", () => {
  for (const name of [
    "getChatAutoCasePermitStatus",
    "setChatAutoCasePermitArming",
    "runChatAutoCasePermitEval",
    "listChatAutoCaseDecisionLedger",
    "getChatAutoCasebookSnapshot",
  ]) {
    assert.match(dataSource, new RegExp(`"${name}"`));
    assert.match(dataSource, new RegExp(`callFluCallable<[^>]+>\\(\\s*"${name}"`));
  }
  // Casebook snapshot (2026-09-28, "simplify in place" direction): the old P1/P2
  // getChatAutoCaseSendHistory / getChatAutoCaseUnhandledStats wrappers are gone — replaced by the
  // single snapshot callable above.
  assert.doesNotMatch(dataSource, /"getChatAutoCaseSendHistory"/);
  assert.doesNotMatch(dataSource, /"getChatAutoCaseUnhandledStats"/);
});

test("chat auto page consumes sanitized casebook snapshot types only", () => {
  assert.match(pageSource, /type ChatAutoCasebookSnapshotRow/);
  assert.match(pageSource, /type ChatAutoNeedsReviewCandidate/);
  assert.doesNotMatch(pageSource, /chat_auto_case_permits/);
  assert.doesNotMatch(pageSource, /evalEvidence/);
});

test("permit UI renders default-off status, approval floor, verification, and disarm evidence", () => {
  assert.match(panelSource, /기본 꺼짐/);
  assert.match(dataSource, /counterFloor:\s*20/);
  assert.match(panelSource, /row\.counterFloor/);
  assert.match(panelSource, /unavailableEvidenceCount/);
  assert.match(panelSource, /casebookMatchesCurrent/);
  assert.match(panelSource, /modelMatchesCurrent/);
  assert.match(panelSource, /estimatedCostUsd/);
  assert.match(panelSource, /lastDisarmReason/);
  assert.match(panelSource, /expiresAtIso/);
  assert.match(panelSource, /승인 발송/);
  assert.match(panelSource, /최신 검증/);
  // 141차: 케이스 카드마다 raw config 해시 + 모델명을 노출하던 "설정 버전" 필드는 삭제됐다.
  // 게이팅 로직(casebookMatchesCurrent/modelMatchesCurrent)은 자동발송 켜기 판정에 남아있지만
  // 화면에는 더 이상 해시/모델명을 렌더하지 않는다.
  assert.doesNotMatch(panelSource, /설정 버전/);
  assert.doesNotMatch(panelSource, /function shortHash/);
});

test("permit UI shows deterministic needs-review candidate cards capped at four", () => {
  assert.match(pageSource, /caseCandidates/);
  assert.match(pageSource, /clampReasonIds/);
  assert.match(pageSource, /\.slice\(0,\s*4\)/);
  assert.match(panelSource, /검토 후보/);
  assert.match(panelSource, /reasonCode/);
  assert.match(panelSource, /채팅에서 검토/);
  assert.match(panelSource, /대화와 메시지마다 최대 4개/);
});

test("permit UI does not render raw prompt, private intent, provider trace, or secret fields", () => {
  for (const forbidden of [
    /rawPrompt/i,
    /privateIntent/i,
    /providerTrace/i,
    /rawResponse/i,
    /secret/i,
    /apiKey/i,
    /token/i,
  ]) {
    assert.doesNotMatch(combinedUiSource, forbidden);
  }
});

test("viewer path is read-only while manager path calls exact guarded action wrappers", () => {
  assert.match(roleGateSource, /role === "super_admin" \|\| role === "admin" \|\| role === "manager"/);
  assert.match(pageSource, /import \{ permitManageRoleGate \} from "@\/lib\/permitRoleGate"/);
  assert.match(panelSource, /조회 전용/);
  assert.match(panelSource, /disabled=\{!canManage/);
  assert.match(panelSource, /자동발송 켜기/);
  assert.match(panelSource, /자동발송 끄기/);
  assert.match(panelSource, /최신 검증 실행/);
  assert.match(pageSource, /expectedCasebookHash:\s*row\.pins\.casebookHash/);
  assert.match(pageSource, /expectedModelVersion:\s*row\.pins\.modelVersion/);
  assert.match(pageSource, /expectedEvalRunId:\s*row\.eval\.runId/);
  assert.match(pageSource, /expectedCounterFloor:\s*20/);
  assert.match(pageSource, /confirm:\s*`RUN_CHAT_AUTO_CASE_PERMIT_EVAL:\$\{row\.caseId\}`/);
  assert.match(pageSource, /bypassGatewayCache:\s*true/);
});

test("super-admin operator override keeps fresh-eval pins and replaces only the counter floor", () => {
  assert.match(dataSource, /operatorOverride\?:\s*boolean/);
  assert.match(dataSource, /overrideReason\?:\s*string/);
  assert.match(pageSource, /data-testid="permit-operator-override"/);
  assert.match(pageSource, /role === "super_admin" && !isViewingAs/);
  assert.match(pageSource, /row\.counters\.consecutiveHumanUneditedApprovedSent < row\.counterFloor/);
  assert.match(pageSource, /row\.eval\.status === "passed"/);
  assert.match(pageSource, /row\.pins\.casebookMatchesCurrent/);
  assert.match(pageSource, /row\.pins\.modelMatchesCurrent/);
  assert.match(pageSource, /expectedCasebookHash:\s*row\.pins\.casebookHash/);
  assert.match(pageSource, /expectedModelVersion:\s*row\.pins\.modelVersion/);
  assert.match(pageSource, /expectedEvalRunId:\s*row\.eval\.runId/);
  assert.match(pageSource, /expectedCounterFloor:\s*20/);
  assert.match(pageSource, /operatorOverride:\s*true/);
  assert.match(pageSource, /overrideReason:\s*reason/);
  // Casebook snapshot (2026-09-28): the mutation reloads via reloadSnapshot() (a full
  // getChatAutoCasebookSnapshot refetch) — no generation/scope-guard argument needed anymore
  // since viewAs is blocked entirely for this console (see the round-4/5-obsolete test below).
  assert.match(pageSource, /const reloadSnapshot = async \(\) => \{/);
});

test("view-as disables auto-reply settings and blocks the entire casebook console", () => {
  assert.match(pageSource, /const isViewingAs = viewAsFlagActive;/);
  assert.match(pageSource, /const canManagePermits = permitManageRoleGate\(role\) && !isViewingAs/);
  assert.match(pageSource, /const canChangeSettings = permitManageRoleGate\(role\) && !isViewingAs && Boolean\(autoReply\)/);
  assert.match(pageSource, /if \(!autoReply \|\| !canChangeSettings \|\| settingsWriteRef\.current\) return/);
  assert.match(pageSource, /disabled=\{settingsControlsDisabled\}/);
  // Casebook direction (2026-09-28, "simplify in place", owner-approved): this console is
  // program-wide for scp-entitled operators, so viewAs can only ever preview the binary "is this
  // member entitled" fact — three of five prior review rounds were viewAs scope-state defects.
  // The console is now blocked outright during viewAs (client-side UI + server-side rejection in
  // functions/chatAutoCasePermitCallables.ts), not merely read with a previewed scope.
  assert.match(pageSource, /data-testid="casebook-view-as-blocked"/);
  assert.match(pageSource, /다른 사용자로 보기 중에는 사용할 수 없음/);
  assert.match(pageSource, /\{isViewingAs \? \(/);
  assert.match(pageSource, /<CasebookSection\b/);
  // CasebookSection and PermitCasePanel must never receive or thread viewAs identity — the whole
  // point of blocking is that this console has exactly one scope (the operator's own).
  assert.doesNotMatch(combinedUiSource, /viewAsParams/);
  assert.doesNotMatch(combinedUiSource, /viewAsUserId/);
  assert.doesNotMatch(combinedUiSource, /viewAsEmail/);
});

test("conversation projection fields needed by UI are narrow and sanitized", () => {
  for (const field of [
    "permitDenyReasons",
    "caseCandidates",
    "clampReasonIds",
    "autoRepliedCaseIds",
  ]) {
    assert.match(pageSource, new RegExp(field));
  }
  assert.doesNotMatch(pageSource, /promptText|traceId|providerRequest|providerResponse/);
});
test("F1: permitManageRoleGate matches the server's MUTATION_ROLES lower bound exactly", () => {
  const { permitManageRoleGate } = compilePermitManageRoleGate();
  const callablesSource = readFileSync(
    new URL("../functions/chatAutoCasePermitCallables.ts", import.meta.url),
    "utf8",
  );
  assert.match(callablesSource, /const MUTATION_ROLES = \["super_admin", "admin", "manager"\] as const;/);

  assert.equal(permitManageRoleGate("super_admin"), true);
  assert.equal(permitManageRoleGate("admin"), true);
  assert.equal(permitManageRoleGate("manager"), true);
  assert.equal(permitManageRoleGate("viewer"), false);
  assert.equal(permitManageRoleGate("guest"), false);
});

test("F1: arm/eval/disarm controls render a visible role-boundary label for lower roles, not just a disabled attribute", () => {
  assert.match(panelSource, /export const PERMIT_MANAGE_BOUNDARY_LABEL/);
  // 헤더 배지와 각 행 모두 같은 상수를 재사용한다 — 문구가 두 군데서 따로 갱신되며 갈리지 않게.
  const usageCount = (panelSource.match(/PERMIT_MANAGE_BOUNDARY_LABEL/g) ?? []).length;
  assert.ok(usageCount >= 5, `PERMIT_MANAGE_BOUNDARY_LABEL usages: ${usageCount} (expected header badge + 3 button titles + row label)`);
  assert.match(panelSource, /data-testid="permit-role-boundary"/);
  assert.match(panelSource, /!canManage \? \(/);
  // 버튼 자체는 여전히 disabled 로 남는다(서버가 최종 권한) — 라벨이 그 대체재가 아니다.
  assert.match(panelSource, /disabled=\{!canManage \|\| permitActionBusy\}/);
  assert.match(panelSource, /disabled=\{!canManage \|\| !supportsAutomaticReply \|\| permitActionBusy\}/);
  assert.match(panelSource, /title=\{canManage \? undefined : PERMIT_MANAGE_BOUNDARY_LABEL\}/);
});

test("permit status badge prioritizes stale or failed states over stored armed flag", () => {
  const dangerCheck = 'if (row.state === "stale_pin" || row.state === "eval_failed") return "danger";';
  const armedCheck = 'if (row.armed) return "ok";';
  assert.ok(panelSource.includes(dangerCheck));
  assert.ok(panelSource.includes(armedCheck));
  assert.ok(panelSource.indexOf(dangerCheck) < panelSource.indexOf(armedCheck));
  assert.match(panelSource, /row\.state === "eval_failed"\) return "검증 필요"/);
});

test("casebook snapshot direction (2026-09-28): the round 4/5 viewAs-scope keyed-remount machinery is gone", () => {
  // Blocking viewAs entirely for this console (see the test above) eliminates the whole failure
  // class rounds 4-5 patched around (stale-frame renders, stale-scope mutation writes) — the
  // scopeKey/PermitScopedSection/UnhandledScopedSection/generation-ref apparatus those rounds
  // built is now dead weight and has been removed rather than retained unused.
  for (const deadIdentifier of [
    /scopeKey/,
    /scopeGenerationRef/,
    /function PermitScopedSection\(/,
    /function UnhandledScopedSection\(/,
    /isFirstScopeRef/,
    /generationRef/,
  ]) {
    assert.doesNotMatch(combinedUiSource, deadIdentifier);
  }
});

test("pending headline shows only an exact cached count and retains the unclassified bucket", () => {
  assert.match(pageSource, /data-testid="pending-headline-card"/);
  assert.match(pageSource, /data-testid="pending-headline-count"/);
  // Casebook inbox (2026-10-01): the headline now switches on pendingDisplayKind — only "exact"
  // renders a bare integer; a capped scan renders "N건 이상"; missing/in-progress never look like 0.
  assert.match(pageSource, /kind === "exact"/);
  assert.match(pageSource, /kind === "missing" \|\| kind === "computing"/);
  assert.match(pageSource, /건 이상 대기 중/);
  assert.match(pageSource, /전체 건수를 집계하고 있습니다/);
  assert.doesNotMatch(pageSource, /\{truncated \? "\+" : ""\}/);
  assert.match(pageSource, /unclassifiedCount/);
  assert.match(pageSource, /pendingTotal/);
});

test("replyText renders the 3-state label (auto_ok+armed / auto_ok+unarmed / non_auto_ok) instead of a bare template string", () => {
  assert.match(panelSource, /row\.replyText\.label/);
  assert.match(panelSource, /row\.replyText\.text/);
  assert.doesNotMatch(panelSource, /row\.replyText \?\?/, "replyText is now an object {state,text,label}, not a bare string | null");
});

test("selecting a case shows its recent confirmed sends without pagination/cursor plumbing", () => {
  assert.match(pageSource, /selectedCaseId/);
  assert.match(pageSource, /getChatAutoCasebookSnapshot\(\{ selectedCaseId: next \}\)/);
  // [case-backlog-send, 2026-09-28] `nextCursor` was dropped from this negative check — it is now a
  // legitimate, DIFFERENT field: sendChatAutoCaseHeldBacklogNow's own resumable-page cursor for the
  // unrelated "보류 N건 지금 보내기" feature (see the dedicated case-backlog-send tests below), not a
  // resurrection of the removed executionCursor/committedCursor send-history pagination this test
  // still guards against.
  assert.doesNotMatch(combinedUiSource, /executionCursor|committedCursor|sources:/);
  assert.match(panelSource, /최근 발송 보기/);
});

test("codex round 7: a stale (superseded) case-selection response can never paint over the currently-selected case's sends, loading, or error state", () => {
  // selectedCaseIdRef is updated SYNCHRONOUSLY (same call, not a passive effect) so applySnapshot
  // always compares snapshot.selected.caseId against whatever the user is looking at right now —
  // rapidly selecting A then B must never let A's later-arriving response paint under B.
  assert.match(pageSource, /const selectedCaseIdRef = useRef<string \| null>\(null\);/);
  assert.match(pageSource, /selectedCaseIdRef\.current = next;/);
  assert.match(
    pageSource,
    /if \(snapshot\.selected && snapshot\.selected\.caseId === selectedCaseIdRef\.current\) \{/,
    "applySnapshot must reject a selected payload whose caseId no longer matches the current selection",
  );
  // A second, independent guard: a monotonic request id discards a stale selectCase() call's own
  // loading/error outcome too (not just its data), even before applySnapshot's own check runs.
  assert.match(pageSource, /const selectCaseRequestRef = useRef\(0\);/);
  assert.match(pageSource, /selectCaseRequestRef\.current \+= 1;/);
  const selectCaseBody = pageSource.slice(pageSource.indexOf("const selectCase = (caseId: string) => {"));
  const thenIndex = selectCaseBody.indexOf(".then(");
  const catchIndex = selectCaseBody.indexOf(".catch(");
  const finallyIndex = selectCaseBody.indexOf(".finally(");
  for (const [label, index] of [["then", thenIndex], ["catch", catchIndex], ["finally", finallyIndex]]) {
    assert.ok(index > 0, `selectCase's .${label}() must exist`);
    const clause = selectCaseBody.slice(index, index + 150);
    assert.match(clause, /if \(requestId !== selectCaseRequestRef\.current\) return;/, `.${label}() must discard a superseded request`);
  }
});

test("per-case pending counts cannot show a false exact zero from an incomplete cache", () => {
  // Casebook inbox (2026-10-01): the boolean pendingExact became a 4-way pendingKind
  // (exact / lower_bound / computing / missing) so a capped scan can read "N건 이상" while missing and
  // in-progress counts stay visibly different from a real 0.
  assert.match(pageSource, /const pendingKind = pendingDisplayKind\(pendingTotal\);/);
  assert.match(pageSource, /pendingKind=\{pendingKind\}/);
  assert.match(panelSource, /pendingKind: PendingDisplayKind;/);
  assert.match(panelSource, /value=\{rowPendingValue\(pendingKind, row\.pendingCount\)\}/);
  assert.match(
    panelSource,
    /tone=\{pendingKind === "exact" && row\.pendingCount === 0 \? "ok" : "warn"\}/,
    "only a completed full scan may show a 0-count case with the reassuring green/ok tone",
  );
  assert.match(
    panelSource,
    /pendingKind === "exact"\s*\n\s*\? row\.pendingCount > 0 \? "확인 필요" : "없음"/,
    "the certain-zero '없음' label is reserved for an exact scan",
  );
  assert.doesNotMatch(panelSource, /pendingExact/);
});

test("codex round 7: the pre-existing 검토 후보 (listConversations) read is a separate contract from getChatAutoCasebookSnapshot, and is now blocked during viewAs like the rest of the console", () => {
  // Previously this fetch effect lived directly in AutoReplyPage (always mounted), so it kept
  // firing even while the whole casebook console — including this panel's own visibility — was
  // blocked for viewAs. Moving it inside CasebookSection means it only mounts (and only fetches)
  // when the console itself is not blocked.
  const casebookSectionIndex = pageSource.indexOf("function CasebookSection(");
  assert.ok(casebookSectionIndex > 0, "CasebookSection must exist");
  const listConversationsCallIndex = pageSource.indexOf("void listConversations({ limit: CANDIDATE_SCAN_LIMIT })");
  assert.ok(listConversationsCallIndex > 0, "the 검토 후보 listConversations call must still exist (pre-existing panel, not removed)");
  assert.ok(
    listConversationsCallIndex > casebookSectionIndex,
    "the 검토 후보 fetch must live INSIDE CasebookSection (gated by the same isViewingAs block), not unconditionally in AutoReplyPage",
  );
  // AutoReplyPage's own body (everything before CasebookSection's declaration) must no longer
  // declare candidate state — confirms the fetch was moved, not merely duplicated.
  const autoReplyPageBody = pageSource.slice(0, casebookSectionIndex);
  assert.doesNotMatch(autoReplyPageBody, /useState<CandidateConversation\[\]>/);
  assert.match(autoReplyPageBody, /const isViewingAs = viewAsFlagActive;/,
    "stored ViewAs must gate reads before the caller role finishes loading");
  assert.match(autoReplyPageBody, /role === "guest" \? \([\s\S]*?casebook-permissions-pending[\s\S]*?\) : \([\s\S]*?<CasebookSection/,
    "unresolved guest permissions must not mount a self-scope casebook reader");
});

// ── "보류 N건 지금 보내기" (case-backlog-send, 2026-09-28) ─────────────────────────────────────────

test("case-backlog-send: data layer exposes the held-count and send-now callable wrappers", () => {
  for (const name of ["getChatAutoCaseHeldBacklogCount", "sendChatAutoCaseHeldBacklogNow"]) {
    assert.match(dataSource, new RegExp(`"${name}"`));
    assert.match(dataSource, new RegExp(`callFluCallable<[^>]+>\\(\\s*"${name}"`));
  }
});

test("case-backlog-send: the held-count is fetched lazily on expand for ONE case at a time, never for every armed row up front", () => {
  // Lazy: the count callable is only ever called from the toggle handler (on expand), never from an
  // unconditional effect/map over `rows` — CasebookSection has exactly one call site for it.
  const callSites = (pageSource.match(/getChatAutoCaseHeldBacklogCount\(/g) ?? []).length;
  assert.equal(callSites, 2, "expected exactly two call sites: the toggle handler's initial fetch and the post-send refresh");
  assert.match(pageSource, /const toggleBacklogSend = \(caseId: string\) => \{/);
  assert.match(pageSource, /const \[backlogSendCaseId, setBacklogSendCaseId\] = useState<string \| null>\(null\);/);
  // Non-null only for the currently-expanded case — PermitCasePanel narrows it to `null` for every
  // OTHER row (see backlogSend={backlogSendCaseId === row.caseId ? backlogSend : null} in the panel).
  assert.match(panelSource, /backlogSend\?\.caseId === row\.caseId \? backlogSend : null/);
});

test("case-backlog-send: the '지금 보내기' control (toggle + button) renders ONLY for an armed row", () => {
  const sendHistoryIndex = panelSource.indexOf("최근 발송 숨기기");
  assert.ok(sendHistoryIndex > 0, "the pre-existing send-history block must exist as the anchor");
  // The NEXT "row.armed ?" occurrence after the send-history block is this new control's own guard
  // (an earlier "row.armed ?" also gates the arm/disarm button switch above it — irrelevant here).
  const armedGuardIndex = panelSource.indexOf("row.armed ?", sendHistoryIndex);
  assert.ok(armedGuardIndex > sendHistoryIndex, "the control must be gated on row.armed, after the send-history block");
  const controlTestIdIndex = panelSource.indexOf("data-testid={`permit-case-backlog-send-", armedGuardIndex);
  assert.ok(
    controlTestIdIndex > armedGuardIndex && controlTestIdIndex - armedGuardIndex < 200,
    "the backlog-send control's own container must be the thing row.armed gates, not some unrelated later block",
  );
  assert.match(panelSource, /보류 확인/);
  assert.match(panelSource, /지금 보내기/);
});

test("case-backlog-send: the send button follows the SAME role gate as arm\\/disarm\\/eval (canManage), with the standard boundary label fallback for lower roles", () => {
  const heldCountBlockIndex = panelSource.indexOf("case-backlog-held-count-");
  const confirmBlockIndex = panelSource.indexOf("backlogSend?.confirming ? (");
  assert.ok(heldCountBlockIndex > 0 && confirmBlockIndex > heldCountBlockIndex, "the held-count/button block must precede the confirm block");
  const buttonBlock = panelSource.slice(heldCountBlockIndex, confirmBlockIndex);
  assert.match(buttonBlock, /canManage \? \(/);
  assert.match(buttonBlock, /PERMIT_MANAGE_BOUNDARY_LABEL/);
  assert.match(buttonBlock, /data-testid=\{`case-backlog-send-button-\$\{row\.caseId\}`\}/);
});

test("case-backlog-send: confirmation explains fresh judgment, bounded inspection, and queuing", () => {
  assert.match(panelSource, /data-testid=\{`case-backlog-send-confirm-\$\{row\.caseId\}`\}/);
  assert.match(panelSource, /보류 메일을 다시 판정하고, 발송 조건을 통과한 메일만 보냅니다/);
  assert.match(panelSource, /한 번에 최대 200건을 검사하고, 조건을 통과한 메일만 발송 대기열에 등록합니다/);
  assert.match(panelSource, /확인하고 보내기/);
  assert.match(pageSource, /const requestBacklogSend = \(caseId: string\) => \{/);
  assert.match(pageSource, /setBacklogSendConfirming\(true\)/);
  assert.match(pageSource, /const confirmBacklogSend = \(caseId: string\) => runBacklogSend\(caseId\);/);
});

test("case-backlog-send: renders the queued/skipped result with a per-reason breakdown, and offers '계속 보내기' only when a resumable cursor exists", () => {
  assert.match(panelSource, /대기열 등록 \{backlogSend\.result\.queued\}건 \/ 건너뜀 \{caseBacklogTotalSkipped\(backlogSend\.result\.skipped\)\}건/);
  assert.match(panelSource, /caseBacklogSkippedBreakdownLabel\(backlogSend\.result\.skipped\)/);
  assert.match(panelSource, /backlogSend\.result\.nextCursor \? \(/);
  assert.match(panelSource, /계속 보내기/);
  assert.match(pageSource, /const continueBacklogSend = \(caseId: string\) => runBacklogSend\(caseId, backlogSendResult\?\.nextCursor \?\? undefined\);/);
});

test("case-backlog-send: a deadline-stopped sweep is called out explicitly instead of looking like a normal completion", () => {
  assert.match(panelSource, /backlogSend\.result\.stoppedReason === "deadline"/);
  assert.match(panelSource, /처리 시간 제한에 도달해 이번 요청에서는 일부만 처리했습니다/);
});

test("case-backlog-send: the send action disables its own trigger buttons while in flight (double-click safe)", () => {
  // Each assertion pins the button's disabled attribute directly ADJACENT to its own onClick and
  // data-testid in source — proving the disabled prop belongs to THAT specific button, not just
  // present somewhere in the file.
  assert.match(
    panelSource,
    /disabled=\{backlogSend\.sendBusy\}\s*\n\s*onClick=\{\(\) => onRequestBacklogSend\(row\.caseId\)\}\s*\n\s*data-testid=\{`case-backlog-send-button-\$\{row\.caseId\}`\}/,
    "the '지금 보내기' trigger button must be disabled ONLY while sendBusy — heldCount is an estimate and must never gate it",
  );
  assert.match(
    panelSource,
    /onClick=\{\(\) => onConfirmBacklogSend\(row\.caseId\)\}\s*\n\s*disabled=\{backlogSend\.sendBusy\}\s*\n\s*data-testid=\{`case-backlog-send-confirm-button-\$\{row\.caseId\}`\}/,
    "the confirm-step '확인하고 보내기' button must be disabled while sendBusy",
  );
  assert.match(
    panelSource,
    /onClick=\{\(\) => onContinueBacklogSend\(row\.caseId\)\}\s*\n\s*disabled=\{backlogSend\.sendBusy\}\s*\n\s*data-testid=\{`case-backlog-send-continue-\$\{row\.caseId\}`\}/,
    "the '계속 보내기' continue button must be disabled while sendBusy",
  );
  // Server-side guard mirrored client-side: a request already in flight for the SAME case is a no-op.
  assert.match(pageSource, /backlogSendCaseId !== caseId \|\| backlogSendBusyByCase\[caseId\]\) return;/);
});

test("case-backlog-send: heldCount is only a display estimate and must NEVER disable '지금 보내기', including when it reads 0", () => {
  // [codex review round 2 followup, 2026-09-28] the count is a cheap, bounded, receive-time-
  // classification-based estimate — never authoritative in either direction. sendChatAutoCaseHeld
  // BacklogNow always runs its own live scan + JEV judgment regardless of what this label says, so
  // the button's disabled expression must reference ONLY sendBusy, never heldCount at all.
  assert.doesNotMatch(panelSource, /disabled=\{[^}]*heldCount[^}]*\}/, "no disabled={...} expression may reference backlogSend.heldCount");
  assert.match(
    panelSource,
    /backlogSend\.heldCount > 0\s*\n\s*\? `확인된 보류 \$\{backlogSend\.heldCount\}건`\s*\n\s*: "추정 0건 — 보내기를 누르면 다시 확인합니다"/,
    "the label distinguishes observed held rows from an authoritative full count",
  );
  assert.match(panelSource, /backlogSend\.scannedCapped[\s\S]*최근 \{backlogSend\.scanCap\}건만 검사했습니다/);
  assert.doesNotMatch(panelSource, /backlogSend\.scannedCapped \? "\+"/);
});

test("case-backlog-send: send-busy is tracked PER CASE, so a late response after collapsing/switching away never leaves a case stuck disabled", () => {
  // A single shared boolean would leave the button permanently disabled if its own in-flight
  // request's .finally() bailed out because the user had since collapsed or switched away from that
  // case (same class of bug the selectedCaseIdRef/selectCaseRequestRef machinery elsewhere on this
  // page exists to avoid, just for a disabled-forever button instead of a stale render).
  assert.match(pageSource, /const \[backlogSendBusyByCase, setBacklogSendBusyByCase\] = useState<Record<string, boolean>>\(\{\}\);/);
  assert.match(pageSource, /sendBusy: Boolean\(backlogSendBusyByCase\[backlogSendCaseId\]\)/);
  // The clearing .finally() must be UNCONDITIONAL — never gated on "is this still the expanded case"
  // (unlike the result/error appliers just above it, which correctly DO stay gated on that).
  const runBacklogSendIndex = pageSource.indexOf("const runBacklogSend = (caseId: string, cursor?: string) => {");
  assert.ok(runBacklogSendIndex > 0, "runBacklogSend must exist");
  const finallyIndex = pageSource.indexOf(".finally(() => {", runBacklogSendIndex);
  assert.ok(finallyIndex > runBacklogSendIndex, "runBacklogSend must have a .finally() clause");
  const finallyBody = pageSource.slice(finallyIndex, finallyIndex + 400);
  assert.doesNotMatch(
    finallyBody,
    /backlogSendCaseIdRef\.current !== caseId/,
    "clearing this case's own busy flag must never be gated on whether it is still the expanded case",
  );
  assert.match(finallyBody, /setBacklogSendBusyByCase/);
});

test("case-backlog-send: this whole control lives inside CasebookSection, so it is blocked during viewAs like the rest of the console", () => {
  const casebookSectionIndex = pageSource.indexOf("function CasebookSection(");
  const toggleIndex = pageSource.indexOf("const toggleBacklogSend = (caseId: string) => {");
  assert.ok(toggleIndex > casebookSectionIndex, "backlog-send state/handlers must live inside CasebookSection, not AutoReplyPage");
  // AutoReplyPage's own body (everything before CasebookSection's declaration, same slice the
  // pre-existing candidate-panel test above uses) must declare none of this feature's state —
  // confirms it is scoped to CasebookSection, which the isViewingAs block above it fully replaces
  // with the "다른 사용자로 보기 중에는 사용할 수 없음" panel during viewAs.
  const autoReplyPageBody = pageSource.slice(0, casebookSectionIndex);
  assert.doesNotMatch(autoReplyPageBody, /backlogSendCaseId|toggleBacklogSend|runBacklogSend/);
});

// 0.6.106 (헤세 결정 2026-10-02): operator-saved replies on auto_ok cases are verifiable and armable.
const replyEditorSource = readFileSync(new URL("../src/app/(app)/chat/auto/CaseReplyEditor.tsx", import.meta.url), "utf8");

test("0.6.106: a saved reply no longer disables 최신 검증 실행 / the auto-send controls; it is gated like a static reply", () => {
  assert.doesNotMatch(panelSource, /overrideRequiresHumanReview/);
  assert.match(panelSource, /const supportsAutomaticReply = row\.replyText\.state === "auto_ok";/);
  // eval is allowed for saved replies (same condition as static), and the page no longer bails on operator_override for eval.
  assert.match(pageSource, /if \(action !== "disarm" && row\.replyText\.state !== "auto_ok"\) return;/);
  assert.doesNotMatch(pageSource, /row\.replyText\.state !== "auto_ok" \|\| row\.replyText\.source === "operator_override"/);
});

test("0.6.106: arming a saved reply goes through the super_admin override card and states that the saved text is sent automatically", () => {
  // The inline arm button cannot satisfy the server (override path only) → it points at the card and the page never fires it.
  assert.match(panelSource, /const savedReplyArmsViaOverride = row\.replyText\.source === "operator_override";/);
  assert.match(panelSource, /canManage && supportsAutomaticReply && !savedReplyArmsViaOverride/);
  assert.match(pageSource, /if \(action === "arm" && row\.replyText\.source === "operator_override"\) return;/);
  // The override card now lists saved replies too (the source exclusion is gone) …
  const eligible = pageSource.slice(pageSource.indexOf("function isOperatorOverrideEligible"), pageSource.indexOf("function formatPermitExpiry"));
  // the only operator_override mention is the "stay eligible at any counter" clause (G), never an exclusion
  assert.doesNotMatch(eligible, /source !== "operator_override"/);
  assert.match(eligible, /row\.replyText\.source === "operator_override" \|\|/);
  assert.match(eligible, /row\.eval\.status === "passed"/);
  assert.match(eligible, /row\.pins\.casebookMatchesCurrent/);
  // … and its confirmation shows the exact saved text and says it will be sent automatically without review.
  assert.match(pageSource, /data-testid=\{`permit-operator-override-saved-text-\$\{row\.caseId\}`\}/);
  assert.match(pageSource, /승인하면 아래 최종 본문/);
  assert.match(pageSource, /저장 문구가 사람 검토 없이 그대로 자동발송됨을 확인했습니다/);
  assert.match(pageSource, /operatorOverride:\s*true/);
});

test("0.6.106: the editor describes an auto_ok saved reply as auto-sendable on approval (not human-review-only) and still says save disarms", () => {
  assert.match(replyEditorSource, /result\.replyText\.automaticStatus === "permit_gated"/);
  assert.match(replyEditorSource, /저장한 문구가 그대로 자동발송됩니다/);
  assert.match(replyEditorSource, /baseReply\.automaticStatus === "permit_gated"/);
  assert.match(replyEditorSource, /저장 후 자동발송 승인은 해제/);
  // non-auto_ok saved replies keep the human-review wording
  assert.match(replyEditorSource, /사람 검토가 필요한 저장본/);
});

test("0.6.106 review fixes: the confirmation shows the server-resolved body and is keyed by case + reply revision + eval run", () => {
  // final outgoing body comes from previewChatAutoCaseReply (the dispatch resolver), never raw tokens
  const previewSource = readFileSync(new URL("../src/app/(app)/chat/auto/savedReplyPreview.ts", import.meta.url), "utf8");
  assert.match(previewSource, /previewChatAutoCaseReply\(\{ caseId, text \}\)/);
  assert.match(pageSource, /fetchSavedReplyPreview\(row\.caseId, row\.replyText\.text \?\? ""\)/);
  assert.match(pageSource, /preview\?\.state === "ok" \? preview\.text/);
  assert.doesNotMatch(pageSource, /permit-operator-override-saved-text-[^\n]*\{row\.replyText\.text\}/);
  // confirmation key includes revisionHash + eval runId, so any change resets it
  assert.match(pageSource, /return `\$\{row\.caseId\}:\$\{row\.replyText\.revisionHash\}:\$\{row\.eval\.runId \?\? ""\}`;/);
  assert.doesNotMatch(pageSource, /overrideConfirmed\[row\.caseId\]/);
  // the arm request carries the confirmed revision hash, and is blocked until the preview resolved
  assert.match(pageSource, /expectedReplyRevisionHash: row\.replyText\.revisionHash/);
  assert.match(pageSource, /savedReplyPreviews\[confirmKey\]\?\.state !== "ok"/);
  assert.match(dataSource, /expectedReplyRevisionHash\?:\s*string/);
});
