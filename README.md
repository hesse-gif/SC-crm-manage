# Handle

Handle is the temporary product name for the communication workspace being built from the migrated Flu chat and mail workflow. It targets its own Firebase project, its own named Firestore database, and its own Gmail sync pipeline instead of reading the Flu runtime at request time.

Current status: the independent runtime is deployed to production with 23 Mixmax Functions, the named `mixmax` Firestore rules/indexes, and Hosting released to `https://influencer-crm-296ca.web.app/mail`. The target Gmail OAuth callback and `gmail.readonly` / `gmail.send` scopes are saved in Google Cloud, and `MIXMAX_GOOGLE_OAUTH_READY=true` is deployed. The captured Flu source inventory from 2026-10-07 06:34:28-06:34:49 UTC is covered in the target `mixmax` database with `missingAfter=0` for all 12 source collections.

The automatic response pipeline is deployed and verified with unit, emulator E2E, and emulator-backed integration tests using mocked Gemini/OAuth/Gmail transport. It is an event-driven Gmail inbound classifier, not a 30-second polling loop. Live mailbox consent, Gmail push, and automatic send have not been exercised yet because the target currently has zero connected mailboxes. See [migration/automation.md](migration/automation.md) for the current contract, operator workflow, and verification boundary.

## Runtime Boundary

- Target Firebase project: `influencer-crm-296ca`
- Target Firestore database: `mixmax`
- Functions region: `asia-northeast3`
- Owner bootstrap: the verified Google account configured in server parameter `MIXMAX_OWNER_EMAIL`
- App route: `/mail`
- Google OAuth callback: `https://influencer-crm-296ca.web.app/mixmaxGoogleCallback`

Flu remains read-only for this migration. Handle imports allowed business data once, stores new state in `influencer-crm-296ca/(mixmax)`, and never writes back to Flu.

The runtime deployment is scoped to the Mixmax codebase, named `mixmax` database rules/indexes, and Hosting release. The target default Firestore database and pre-existing non-Mixmax Functions are preserved.

```text
Gmail watch
  -> Pub/Sub topic mixmax-gmail
  -> mixmaxGmailPush
  -> mixmax_sync_jobs/{connectionId}
  -> mixmaxSyncJob
  -> Gmail history delta / full fallback
  -> mixmax_threads + mixmax_messages
  -> browser onSnapshot listeners
```

Automatic response events extend this pipeline after a new Gmail inbound message is durable:

```text
Gmail inbound message
  -> mixmax_threads latest inbound update
  -> mixmaxThreadAutomationEnqueue
  -> mixmax_automation_runs/{runId}
  -> mixmaxAutomationJob
  -> classify against reviewed cases
  -> create needs-review case or send approved saved reply
```

## What Is Implemented

- Google sign-in for the Handle workspace, with first-owner bootstrap gated by `MIXMAX_OWNER_EMAIL`.
- Workspace membership checks through `mixmax_members/{uid}`.
- Firestore client reads for workspace-scoped collections only; all writes go through callables.
- Realtime UI subscriptions with `onSnapshot` for threads, messages, drafts, templates, contacts, cases, sequences, outbox, and connected accounts.
- Gmail OAuth runtime for `gmail.readonly` and `gmail.send`, with credential storage only after Gmail watch succeeds.
- Gmail push/history sync with durable cursors, leases, retry behavior, full-sync fallback on expired history, and daily watch renewal.
- Manual AI draft creation through Gemini, with human review before send.
- Explicit Gmail sending through a user-owned connected account, with idempotent request IDs and an ambiguous-send state that requires human confirmation.
- Event-driven automatic response pipeline for future inbound Gmail messages after explicit account and case approval.
- One-time Flu data import into Handle collections, with secret redaction and deterministic `flu_` IDs.
- Full-body message reconciliation for imported `message_sources`, with backups before legacy short-ID duplicate removal.
- Casebook import for 21 Flu chat casebook cases.
- Final nested association audit checked 51,207 source conversation-message links, repaired six missing target associations, and reports `missingAfter=0` for the repaired set.
- Explicit sender assignment for imported Flu threads that lack mailbox metadata. Assignment only binds an operator-owned connected account and does not send mail.
- Sequence records as draft plans only. There is no automatic sequence sender.

## Automatic Response Pipeline

The automation runtime includes:

- Account-level pause/enable through `mixmaxSetAutomationSettings`.
- Historical or imported conversation analysis through `mixmaxAnalyzeThread`; this is review-only and never auto-sends historical mail.
- Case-level "앞으로 자동응대" approval through `mixmaxConfigureCaseAutomation`, tied to one connected account and the current saved reply/policy digest.
- Event-driven enqueue on new Gmail inbound thread updates through `mixmaxThreadAutomationEnqueue`.
- Automatic run processing through `mixmaxAutomationJob`.
- Operator confirmation for uncertain provider outcomes through `mixmaxResolveAutomationRun`.

The send path is intentionally narrow. Unknown or low-confidence inquiries create a deterministic `needs_review` case and draft; no-reply classifications create the review case without a draft. Approved known cases send the operator's saved reply body verbatim. Editing the case policy or body changes the digest and requires re-approval before future automatic sends.

Default automation caps are 100 classifications and 20 automatic sends per connected account per UTC day. These caps are not UI-editable. Initial imports and historical rows never gain automatic send authority.

## What Is Not Proven Yet

- Live Google mailbox consent.
- Live Gmail send.
- Live Gmail push into the automation enqueue path.
- Live Gemini draft or automation classifier generation against real mailbox content, beyond a synthetic Gemini JSON smoke against `gemini-3.8-flash`.

## Local Development

Use Node.js 22. The team-local Node path used for verification is `/opt/homebrew/opt/node@22/bin`.

Install dependencies:

```sh
npm ci
npm --prefix functions ci
```

Run the independent Handle app against local emulators:

```sh
npm run build:runtime
firebase emulators:start --config firebase.mixmax.json --project demo-mixmax --only auth,functions,firestore,pubsub
npm run dev:mixmax -- --port 3210
```

Open `http://localhost:3210/mail`.

Run a live-config local build only after `configure:live` has written the target Firebase web config to the ignored `.env.live.local` file:

```sh
npm run configure:live
npm run dev:live -- --port 3210
```

Live mode is pinned to `influencer-crm-296ca`. It will not use `influchat-77db6`.

## Verification

The current evidence is recorded under `artifacts/verification/`:

- `automation-unit.log`: 35 Mixmax import/runtime/automation unit tests passed.
- `automation-e2e.log`: 6 independent Mixmax emulator E2E tests passed.
- `automation-integration.log`: automation backend integration passed with real Firestore emulator and mocked Gemini/OAuth/Gmail.
- `automation-send-guard.log`: Gmail transport guard integration passed with mocked Gmail HTTP.
- `mixmax-sync.log`: Gmail sync fault-recovery integration passed with all Gmail HTTP responses mocked.
- `automation-deploy-runtime.log`: 23 Mixmax Functions plus `mixmax` Firestore rules/indexes deployed successfully.
- `automation-deploy-hosting.log`: Hosting released 119 files to `https://influencer-crm-296ca.web.app`.
- `automation-live-smoke.json`: `/mail` returned HTTP 200 with title `Handle`; 23 Mixmax Functions and five preserved default Functions were ACTIVE; four new automation callables returned unauthenticated 401 without auth.
- `automation-live-browser.log`: public browser smoke rendered the Handle login screen and mail-connect notice.
- `automation-typecheck.log`: TypeScript typecheck passed.
- `automation-build-hosting.log`: production Hosting build passed.
- `mixmax-deploy-oauth-ready.log`: OAuth-ready runtime redeploy succeeded.
- `mixmax-oauth-scopes.log`: `gmail.readonly` and `gmail.send` were saved and visible after reload.
- `mixmax-finalize.log`: captured source inventory finalized with `missingAfter=0` for all 12 source collections.
- `mixmax-association-repair.log`: six missing nested associations from a 51,207-link source audit were repaired in the target database.
- `automation-gemini-smoke.json`: synthetic Gemini JSON classification returned from `gemini-3.8-flash`.

Latest public browser verification opened `/mail`, rendered the Handle login screen, and showed the separate notice that mail accounts are connected after login. Earlier authenticated browser verification loaded the app with Google sign-in and opened feed, templates, contacts, outbox, and settings without permission or index errors. The observed loaded-page counts were feed 200, templates 47, contacts 200, and outbox 200; these are page counts, not total collection counts.

Useful verification commands:

```sh
npm run test:mixmax
firebase emulators:exec --config firebase.mixmax.json --project demo-mixmax --only auth,functions,firestore,pubsub --non-interactive 'node scripts/verify-mixmax-e2e.mjs'
```

Production deploy commands:

```sh
npm run deploy:runtime
npm run build:hosting
npm run deploy:hosting
```

See [migration/verification.md](migration/verification.md) for verified behavior and open production checks.

## Import Docs

- [migration/import-plan.md](migration/import-plan.md): source/target mapping, safety rules, and commands.
- [migration/automation.md](migration/automation.md): automatic response pipeline contract, operator workflow, and recovery notes.
- [migration/polling-removal.md](migration/polling-removal.md): why the old timer refresh model is gone.
- [migration/verification.md](migration/verification.md): current test evidence and remaining rollout checks.
