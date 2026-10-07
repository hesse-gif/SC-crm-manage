# Mixmaxclone

Mixmaxclone is a Mixmax-style communication workspace for the migrated Flu chat and mail workflow. It now targets its own Firebase project, its own named Firestore database, and its own Gmail sync pipeline instead of reading the Flu runtime at request time.

Current status: the independent Mixmax runtime is deployed to production and verified locally with emulators. The target Gmail OAuth callback and `gmail.readonly` / `gmail.send` scopes are saved in Google Cloud, and `MIXMAX_GOOGLE_OAUTH_READY=true` is deployed. The captured Flu source inventory from 2026-10-07 06:34:28-06:34:49 UTC is covered in the target `mixmax` database with `missingAfter=0` for all 12 source collections. Live mailbox consent, live Gmail send, and live Gemini draft generation have not been exercised yet.

## Runtime Boundary

- Target Firebase project: `influencer-crm-296ca`
- Target Firestore database: `mixmax`
- Functions region: `asia-northeast3`
- Owner bootstrap: the verified Google account configured in server parameter `MIXMAX_OWNER_EMAIL`
- App route: `/mail`
- Google OAuth callback: `https://influencer-crm-296ca.web.app/mixmaxGoogleCallback`

Flu remains read-only for this migration. Mixmax imports allowed business data once, stores new state in `influencer-crm-296ca/(mixmax)`, and never writes back to Flu.

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

## What Is Implemented

- Google sign-in for the Mixmax workspace, with first-owner bootstrap gated by `MIXMAX_OWNER_EMAIL`.
- Workspace membership checks through `mixmax_members/{uid}`.
- Firestore client reads for workspace-scoped collections only; all writes go through callables.
- Realtime UI subscriptions with `onSnapshot` for threads, messages, drafts, templates, contacts, cases, sequences, outbox, and connected accounts.
- Gmail OAuth runtime for `gmail.readonly` and `gmail.send`, with credential storage only after Gmail watch succeeds.
- Gmail push/history sync with durable cursors, leases, retry behavior, full-sync fallback on expired history, and daily watch renewal.
- Manual AI draft creation through Gemini, with human review before send.
- Explicit Gmail sending through a user-owned connected account, with idempotent request IDs and an ambiguous-send state that requires human confirmation.
- One-time Flu data import into Mixmax collections, with secret redaction and deterministic `flu_` IDs.
- Full-body message reconciliation for imported `message_sources`, with backups before legacy short-ID duplicate removal.
- Casebook import for 21 Flu chat casebook cases.
- Sequence records as draft plans only. There is no automatic sequence sender.

## What Is Not Proven Yet

- Live Google mailbox consent.
- Live Gmail send.
- Live Gemini draft generation.
- Independent nested association audit for imported conversation/message joins.
- Historical rows that lack mailbox metadata still need the assigned-sender feature currently in progress.

## Local Development

Use Node.js 22. The team-local Node path used for verification is `/opt/homebrew/opt/node@22/bin`.

Install dependencies:

```sh
npm ci
npm --prefix functions ci
```

Run the independent Mixmax app against local emulators:

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

- `mixmax-unit.log`: 26 Mixmax import/runtime tests passed.
- `mixmax-e2e-draft-context.log`: 4 independent Mixmax emulator E2E tests passed.
- `mixmax-sync.log`: Gmail sync fault-recovery integration passed with all Gmail HTTP responses mocked.
- `mixmax-deploy-runtime-retry.log`: 17 Mixmax Functions plus `mixmax` Firestore rules/indexes deployed successfully.
- `mixmax-deploy-oauth-ready.log`: OAuth-ready runtime redeploy succeeded.
- `mixmax-deploy-hosting.log`: Hosting deploy succeeded.
- `mixmax-oauth-scopes.log`: `gmail.readonly` and `gmail.send` were saved and visible after reload.
- `mixmax-finalize.log`: captured source inventory finalized with `missingAfter=0` for all 12 source collections.

Live browser verification loaded the app with Google sign-in and opened the feed, templates, contacts, outbox, and settings connect control without permission or index errors. The observed loaded-page counts were feed 200, templates 47, contacts 200, and outbox 200; these are page counts, not total collection counts.

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
- [migration/polling-removal.md](migration/polling-removal.md): why the old timer refresh model is gone.
- [migration/verification.md](migration/verification.md): current test evidence and remaining rollout checks.
