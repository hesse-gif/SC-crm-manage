# Event-driven automatic replies

User direction (2026-10-07): preserve the mail workspace layout, adapt Flu's case learning and “앞으로 자동응대” workflow, and create a case immediately for a new kind of inquiry. Flu is read-only. No recurring short-interval polling or new dependencies.

## Contract

- Gmail sync commits messages before the thread's `latestMessageId` / `latestMessageDirection`. A thread event enqueues a deterministic per-message automation run only for a connected, explicitly enabled account and mail newer than its activation time. Initial imports/history never acquire send authority.
- `mixmaxSetAutomationSettings({connectionId, enabled})`: owned account, explicit future-only activation, pause switch. Settings live on connection as `automationEnabled`, `automationEnabledAt`; daily classifier/send budgets bound cost and effects.
- `mixmaxAnalyzeThread({threadId, connectionId})`: explicit analysis of an existing/imported conversation, always review-only. Creates/links a case and review draft; never sends historical mail.
- `mixmaxConfigureCaseAutomation({caseId?, threadId?, connectionId, enabled, name?, description?, body?})`: owner selects exact reusable reply and matching criteria. Creates a case if needed; per-account approval is tied to a digest of current case policy. Disabling stops future sends. Generic case edits invalidate approval by digest mismatch.
- Unknown questions create deterministic pending cases plus a suggested draft, with source thread/message provenance. Known ambiguous/forbidden/no-reply cases stay held. Model output cannot grant send authority or invent a permitted case ID.
- Approved matching cases send the operator's saved reply verbatim. No AI-written unapproved reply is automatically sent. Recheck connection, membership, current policy digest, latest message, cutoff, sender and budgets at send claim. Persist outcome and case/rationale for the UI.
- Ignore outbound, auto-submitted/bulk/list/bounce/no-reply messages, self replies, drafts/spam/trash and ambiguous recipients. Send headers identify automatic replies. A deterministic send claim blocks duplicated delivery and unknown provider outcomes from automatic retry.
- An explicit manual send claims the current inbound for the operator, even when its provider attempt fails. Automation must not substitute a different saved reply after a failed manual attempt; the manual composer exposes retry. This suppression records human takeover, not successful delivery.
- Clients can read owner-scoped automation runs; cannot write runs, approval state or budgets. Gmail tokens remain private. Existing migrated Flu permissions never become active approvals.

## Ownership and verification

Backend executor owns new automation modules and tests. UI executor owns workspace UI/components/styles and frontend E2E additions. Leader owns Gmail projection/transport integration, exports/rules/indexes, build/test integration and final deployment. Read-only Flu audit and final adversarial review are separate lanes.

Tests must prove unknown-case creation, repeated-case linking, explicit enabling, future matching auto send, disabled/mutated/foreign policy rejection, no historical auto-send, duplicate/concurrent events, auto-mail loop suppression, stale thread/member/account guards, provider ambiguity, budget limits, and pause control. Use real Firestore emulator with mocked Gmail/AI HTTP; no real recipient sends in verification. UI E2E covers settings, review case creation, enable/disable and visible outcome. Run targeted tests, typecheck, build and existing independent runtime E2E before committing to the existing draft PR.

Official event contract: Firestore delivery can repeat and arrive out of order (https://firebase.google.com/docs/functions/firestore-events). Threaded replies require Gmail thread ID plus compliant References/In-Reply-To headers (https://developers.google.com/workspace/gmail/api/guides/threads).
