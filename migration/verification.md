# Mixmax Migration Verification

This document records what has been verified for the independent Mixmax runtime and what still needs production proof.

## Verified Locally

Evidence files:

- `artifacts/verification/mixmax-unit.log`
- `artifacts/verification/mixmax-e2e-draft-context.log`
- `artifacts/verification/mixmax-sync.log`

Results:

| Check | Evidence | Result |
| --- | --- | --- |
| Import/runtime unit tests | `mixmax-unit.log` | 26 passed, 0 failed |
| Independent Mixmax E2E | `mixmax-e2e-assign-mailbox.log` | 4 passed, 0 failed |
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
| Mixmax runtime deploy | `mixmax-deploy-runtime-retry.log` | 17 Functions deployed in `asia-northeast3`; `mixmax` rules and indexes released |
| OAuth-ready redeploy | `mixmax-deploy-oauth-ready.log` | Runtime redeployed with OAuth ready |
| Hosting deploy | `mixmax-deploy-hosting.log` | Hosting released 119 files to `https://influencer-crm-296ca.web.app` |
| OAuth scopes saved | `mixmax-oauth-scopes.log` | `gmail.readonly` and `gmail.send` visible after reload |
| Import finalize | `mixmax-finalize.log` | Captured source inventory from 2026-10-07 06:34:28-06:34:49 UTC reports `missingAfter=0` for all 12 source collections |
| Live browser smoke | Browser observation | App Google login passed; feed 200, templates 47, contacts 200, and outbox 200 loaded-page counts rendered; settings connect control was visible; no permission or index errors were observed |

The OAuth app remains External and In Production. Google Cloud showed an app verification warning and a 100-user limit. Google documents a personal-use exception where apps for fewer than 100 users can continue without verification, while users may see the unverified-app warning and the app remains subject to policy requirements: <https://support.google.com/cloud/answer/13464323?hl=en>. This is not a claim that the app is verified.

## Runtime Contract Checked

- Client uses Firebase project `influencer-crm-296ca` in independent live mode.
- Client Firestore uses named database `mixmax`.
- Client Functions region is `asia-northeast3`.
- Mixmax callables are exported from `functions/mixmax/index.ts`.
- Workspace writes are callable-owned; Firestore client writes are denied.
- Private runtime collections are not client-readable: `mixmax_credentials`, `mixmax_oauth_states`, `mixmax_sync_jobs`, `mixmax_sync_leases`.
- Import backup documents are private: `mixmax_import_backups`.
- Gmail sync uses watch/Pub/Sub/history deltas and only advances the cursor after projected messages are durable.
- Send uses explicit user action, connected-account ownership, request idempotency, and `needs_confirmation` for ambiguous outcomes.
- AI draft generation creates reviewable drafts; it does not send mail.
- Sequences are saved as draft plans only.
- Production deployment preserved the target default Firestore database and the pre-existing non-Mixmax Functions.

## Production Checks Still Pending

These items are not verified and must stay out of completion claims:

- Run a live mailbox OAuth consent and confirm Gmail watch creation.
- Confirm a live Gmail push updates `mixmax_threads` and `mixmax_messages`.
- Confirm a live Gmail send with a connected mailbox.
- Confirm a live Gemini draft generation with the production secret.

## Repeatable Local Verification

Build the Mixmax Functions bundle and run unit tests:

```sh
npm run test:mixmax
```

Run the independent emulator E2E suite:

```sh
firebase emulators:exec --config firebase.mixmax.json --project demo-mixmax --only auth,functions,firestore,pubsub --non-interactive 'node scripts/verify-mixmax-e2e.mjs'
```

The E2E harness seeds synthetic data only. It does not send live email and does not call live Gemini.

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
- `mixmax-functions-inventory.json`: all 17 Mixmax functions exist and all five pre-existing target functions remain.
