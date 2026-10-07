# Handle Migration Verification

This document records what has been verified for the independent Handle runtime and what still needs live Gmail proof.

## Verified Locally

Evidence files:

- `artifacts/verification/mixmax-unit.log`
- `artifacts/verification/automation-unit.log`
- `artifacts/verification/automation-e2e.log`
- `artifacts/verification/automation-integration.log`
- `artifacts/verification/automation-send-guard.log`
- `artifacts/verification/mixmax-sync.log`

Results:

| Check | Evidence | Result |
| --- | --- | --- |
| Import/runtime unit tests | `mixmax-unit.log` | 26 passed, 0 failed |
| Import/runtime/automation unit tests | `automation-unit.log` | 35 passed, 0 failed |
| Independent Handle E2E | `automation-e2e.log` | 6 passed, 0 failed |
| Automation backend integration | `automation-integration.log` | Passed with real Firestore emulator and mocked Gemini/OAuth/Gmail |
| Gmail transport guard integration | `automation-send-guard.log` | Passed with mocked Gmail HTTP |
| Typecheck and Hosting build | `automation-typecheck.log`, `automation-build-hosting.log` | Passed |
| Gmail sync fault recovery | `mixmax-sync.log` and E2E preflight | Passed with mocked Gmail HTTP responses |
| Firestore rules | Unit and E2E checks | Owner workspace reads allowed; outsider reads, private collections, and client writes denied |
| Realtime UI refresh | E2E | Admin-inserted target Firestore message appeared without manual reload |
| Idle callable polling removal | E2E | No callable POSTs during a 35-second idle window |
| Draft preservation during realtime update | E2E | Composer body survived incoming Firestore updates |
| Imported draft reply context | E2E | Imported AI drafts open as replies with original mailbox context |
| Template write path | E2E | `mixmaxSaveTemplate` callable saved data and reload read it from Firestore |

## Verified In Production

| Check | Evidence | Result |
| --- | --- | --- |
| Handle automation runtime deploy | `automation-deploy-runtime.log` | 23 Mixmax Functions deployed in `asia-northeast3`; `mixmax` rules and indexes released |
| Handle Hosting deploy | `automation-deploy-hosting.log` | Hosting released 119 files to `https://influencer-crm-296ca.web.app` |
| Latest live smoke | `automation-live-smoke.json` | `/mail` returned HTTP 200 with title `Handle`; 23 Mixmax Functions and five preserved default Functions were ACTIVE; four new automation callables returned unauthenticated 401 |
| Latest public browser smoke | `automation-live-browser.log` | Login screen rendered Handle branding, "Routine replies. Already handled.", and separate mail-connect notice |
| OAuth-ready redeploy | `mixmax-deploy-oauth-ready.log` | Runtime redeployed with OAuth ready |
| OAuth scopes saved | `mixmax-oauth-scopes.log` | `gmail.readonly` and `gmail.send` visible after reload |
| Import finalize | `mixmax-finalize.log` | Captured source inventory from 2026-10-07 06:34:28-06:34:49 UTC reports `missingAfter=0` for all 12 source collections |
| Live browser smoke | Browser observation | App Google login passed; feed 200, templates 47, contacts 200, and outbox 200 loaded-page counts rendered; settings connect control was visible; no permission or index errors were observed |

The OAuth app remains External and In Production. Google Cloud showed an app verification warning and a 100-user limit. Google documents a personal-use exception where apps for fewer than 100 users can continue without verification, while users may see the unverified-app warning and the app remains subject to policy requirements: <https://support.google.com/cloud/answer/13464323?hl=en>. This is not a claim that the app is verified.

## Runtime Contract Checked

- Client uses Firebase project `influencer-crm-296ca` in independent live mode.
- Client Firestore uses named database `mixmax`.
- Client Functions region is `asia-northeast3`.
- Mixmax callables are exported from `functions/mixmax/index.ts`.
- Runtime inventory shows 23 Mixmax Functions active and five pre-existing default Functions preserved.
- The four new automation callables checked in live smoke reject unauthenticated calls with HTTP 401.
- Workspace writes are callable-owned; Firestore client writes are denied.
- Private runtime collections are not client-readable: `mixmax_credentials`, `mixmax_oauth_states`, `mixmax_sync_jobs`, `mixmax_sync_leases`.
- Import backup documents are private: `mixmax_import_backups`.
- Gmail sync uses watch/Pub/Sub/history deltas and only advances the cursor after projected messages are durable.
- Manual send uses explicit user action, connected-account ownership, request idempotency, and `needs_confirmation` for ambiguous outcomes.
- AI draft generation creates reviewable drafts; it does not send mail.
- Automatic responses are event-driven from new inbound Gmail thread updates, future-only after account enablement, and gated by per-connection case approval.
- Unknown or low-confidence automation classifications create review cases and drafts; no-reply classifications create review cases without drafts.
- Approved automation sends the operator's saved case body verbatim only, with model/classifier/policy digest pins.
- Automation uses UTC-day defaults of 100 classifications and 20 automatic sends per connected account; caps are not UI-editable.
- Uncertain provider outcomes require operator confirmation and are not automatically retried.
- Sequences are saved as draft plans only.
- Production deployment preserved the target default Firestore database and the pre-existing non-Mixmax Functions.

## Production Checks Still Pending

These items are not verified and must stay out of completion claims:

- Run a live mailbox OAuth consent and confirm Gmail watch creation. Current target mailbox connections: 0.
- Confirm a live Gmail push updates `mixmax_threads` and `mixmax_messages`.
- Confirm a live automatic Gmail send with a connected mailbox. No real mail was sent during verification.
- Confirm live Gemini draft/classification generation against real mailbox content. Synthetic `gemini-3.8-flash` JSON smoke passed with no real mailbox data.

## Repeatable Local Verification

Build the Mixmax Functions bundle and run unit tests:

```sh
npm run test:mixmax
```

Run the independent emulator E2E suite:

```sh
firebase emulators:exec --config firebase.mixmax.json --project demo-mixmax --only auth,functions,firestore,pubsub --non-interactive 'node scripts/verify-mixmax-e2e.mjs'
```

The E2E and integration harnesses seed synthetic data only. They do not send live email. Automation integration mocks Gemini/OAuth/Gmail transport; the separate Gemini smoke uses synthetic prompt data only.

There is no ESLint/lint script or lint configuration in this repository. Available validation evidence is typecheck, diff check, tests, build, deploy logs, and live smoke logs.

## Current Production Risk Notes

- OAuth login to the app and OAuth consent for Gmail are separate. Google sign-in alone does not prove mailbox connection.
- Imported Flu messages are historical projections. Replying requires a newly connected Mixmax Gmail account whose email matches the imported thread mailbox.
- Imported outbound rows are receipts/history and are blocked from automatic retry.
- Captured source inventory coverage is validated, but later Flu source additions are not continuously mirrored.
- Loaded-page counts from live browser smoke are not total collection counts.

## Final Association and Sender Checks

- The independent read-only audit checked 51,207 nested conversation messages. Six missing associations were recovered in Mixmax only; targeted post-write verification reports `checked: 6, missingAfter: 0` in `mixmax-association-repair.log`. One related conversation created after the main inventory was also imported. Subsequent live Flu changes are outside this captured audit.
- `mixmaxAssignThreadMailbox` is deployed. Historical Flu threads without a sender require explicit assignment of an operator-owned connected account. A known sender cannot be silently rebound. Assignment sends no email.
- `mixmax-e2e-assign-mailbox.log`: four E2E tests pass, including assignment, draft context, matching-account selection, imported receipts, realtime updates, idle behavior and access rules.
- `mixmax-deploy-hosting-final.log` and `mixmax-deploy-mailbox-assignment.log`: final UI and sender-assignment releases succeeded.
- `automation-live-smoke.json`: all 23 Mixmax functions are active and all five pre-existing target functions remain.
