# Handle Automatic Response Pipeline

Status: deployed runtime on 2026-10-07. This document describes the automatic response code and verified behavior. Live mailbox consent, live Gmail push, and live automatic send remain unexercised.

Audience: engineers and operators maintaining Handle's Gmail response workflow.

## Scope

Handle adapts Flu's reviewed case workflow into the new mail workspace. The goal is to handle repeated inbound Gmail replies after an operator has explicitly approved a saved response for a case and connected account.

This is an adaptation, not a full clone of Flu's auto-reply internals. Handle does not copy Flu's full approval matrix, all historical evaluation infrastructure, or legacy scheduler behavior. Flu remains read-only. Imported Flu conversations and initial backfills can be analyzed for review, but they never become automatic sends by import alone.

## Pipeline

The automation path starts only after Gmail sync has stored a new inbound message and updated the thread's latest inbound marker.

```text
Gmail watch / Pub/Sub / history sync
  -> mixmax_messages stores the inbound message
  -> mixmax_threads records latestMessageId + latestMessageDirection=inbound
  -> mixmaxThreadAutomationEnqueue creates mixmax_automation_runs/{runId}
  -> mixmaxAutomationJob classifies the newest inbound message
  -> unknown case: create needs-review case and draft
  -> approved known case: send saved reply verbatim
```

There is no 30-second polling loop for automation. Firestore document events enqueue deterministic per-message runs, and duplicate delivery is handled by deterministic run IDs.

Automation is future-only. Reconnecting a mailbox resets automation off until the operator enables it again.

## Operator Workflow

1. Connect a Google mailbox in **My settings**.
2. Turn on **새 메일 자동 분류** for that connected account. This sets `automationEnabled=true` and records `automationEnabledAt`.
3. Open a conversation and click **케이스 찾기** when reviewing historical or imported mail. This calls `mixmaxAnalyzeThread` and is always review-only.
4. For a repeated case, fill in **케이스 이름**, **매칭 기준**, and **정확히 보낼 답장**.
5. Click **앞으로 자동응대** or **이 케이스 자동응대**. This approves the exact saved reply and criteria for the selected connected account.
6. New inbound Gmail messages after account activation are eligible to match the approved case. If they match with sufficient confidence, the automation job sends the saved reply exactly as written.

The account toggle pauses or resumes new automatic classification for that mailbox. The case-level **자동응대 끄기** button disables one case for one account without disconnecting the mailbox.

## Case Behavior

Unknown or low-confidence messages create a deterministic pending case using the source thread and message IDs. The case is stored with `status="needs_review"` and `automationStatus="pending_review"`. If the classifier proposes a reply, Handle creates a review draft, but it does not send it. If the classifier marks no reply needed, Handle creates the review case without a draft.

Known cases can auto-send only when all approval checks still hold:

- the connected account is still owned by the operator and is connected;
- account automation is enabled and the inbound message is newer than `automationEnabledAt`;
- the case has an enabled approval row for that connection;
- the approval owner matches the connection owner;
- the current case policy digest still matches the approved digest;
- the model and classifier version pins still match the approval row;
- the case is not marked `draftForbidden` or `noReplyNeeded`;
- the saved reply body is non-empty and has no unresolved `{{...}}` placeholders;
- the inbound message is direct, safe to reply to, and not an auto-submitted, list, bulk, spam, trash, draft, self, no-reply, or multi-party message.

Editing the case name, matching criteria, saved reply, or no-reply flags changes the policy digest. The UI then shows the case as needing review until the operator approves it again.

Handle sends at most once per approved case per thread. A manual send claims the current inbound message for the operator and suppresses automatic replacement, even if the manual provider attempt fails.

## Limits

Default limits are defined in `functions/mixmax/automation-core.ts` and `functions/mixmax/automation.ts`:

| Limit | Default |
| --- | ---: |
| Classifications per connected account per UTC day | 100 |
| Automatic sends per connected account per UTC day | 20 |
| Registry rows allowed before overflow hold | 500 |

The caps are not UI-editable. The classifier uses `MIXMAX_AI_MODEL`, which currently defaults to `gemini-3.8-flash`. Case approvals store the model version and classifier version. A later model or classifier change invalidates old auto-send approvals until the case is approved again.

Classifier context includes the full saved case criteria up to a 64k character guard; it does not silently truncate criteria. Program and campaign cases are excluded from automatic classification context unless explicitly approved for automation. The latest target audit found 101 total cases, 50 response cases, and 11,339 criteria characters.

## Recovery

If Gmail send returns an uncertain provider result, Handle marks the automation run as `needs_confirmation`. The UI shows **발송됨 확인** and **발송되지 않음 확인**. The operator should check Gmail Sent Mail and choose the observed result. Handle then records the confirmation and suppresses automatic retry for that inbound message.

If a run remains `sending` for more than 10 minutes, the UI treats it like a confirmation case. This prevents repeated automatic delivery when the provider outcome is unclear.

Manual sends also suppress automation for the current inbound message. Even if the manual provider attempt fails, automation does not substitute a different saved reply. The human composer remains the retry path.

## Verification Boundary

Verified evidence:

- `artifacts/verification/automation-unit.log`: 35 Mixmax import/runtime/automation unit tests passed.
- `artifacts/verification/automation-e2e.log`: six independent emulator E2E tests passed.
- `artifacts/verification/automation-integration.log`: automation backend integration passed with real Firestore emulator and mocked Gemini/OAuth/Gmail.
- `artifacts/verification/automation-send-guard.log`: Gmail transport guard integration passed with mocked Gmail HTTP.
- `artifacts/verification/automation-deploy-runtime.log`: 23 Mixmax Functions, rules, and indexes deployed.
- `artifacts/verification/automation-deploy-hosting.log`: Hosting released 119 files.
- `artifacts/verification/automation-live-smoke.json`: `/mail` returned HTTP 200 with title `Handle`; 23 Mixmax Functions and five preserved default Functions were ACTIVE; four new automation callables returned unauthenticated 401 without auth.
- `artifacts/verification/automation-live-browser.log`: public browser smoke rendered the Handle login screen and separate mail-connect notice.
- `artifacts/verification/automation-gemini-smoke.json`: synthetic Gemini JSON classification returned from `gemini-3.8-flash`.
- `artifacts/verification/automation-typecheck.log` and `artifacts/verification/automation-build-hosting.log`: typecheck and Hosting build passed.

Not yet exercised with live mailbox data:

- live Gmail mailbox consent against the automation path;
- live Gmail push to automation enqueue;
- live Gmail automatic send;
- live Gemini classification against real mailbox content.

Current target mailbox connections: 0. No real mail was sent during verification.

## Related Files

- `functions/mixmax/automation-core.ts`
- `functions/mixmax/automation.ts`
- `functions/mixmax/index.ts`
- `src/components/mixmax/Workspace.tsx`
- `migration/automation-plan.md`
- `migration/verification.md`
