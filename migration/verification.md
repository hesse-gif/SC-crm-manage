# Flu Chat migration verification

Source: `supercent-io/Flu@be5915aeb455b3ce378e022125dcc09d514b8d8d`, release `0.6.116`.
Deployment: <https://influencer-crm-296ca.web.app/chat>.

## Runtime contract

- Mixmaxclone is a separate Next.js application and Firebase Hosting release.
- Authentication, callable requests, mailbox permissions, and conversation records use the existing `influchat-77db6` backend. Both applications observe the same records; there is no copied production database to reconcile.
- The visible Chat app refreshes every 30 seconds, and selected-conversation updates retain the source polling behavior. Hidden tabs pause foreground refresh. This is polling, not a websocket or token stream. Upstream mail ingestion and server caches still determine when incoming mail becomes available.
- Conversation, composer, AI draft/preview, templates, receipts, casebook, auto-reply controls, review board, and supporting administration screens are preserved. Flu workflow links open the corresponding original Flu screen.
- The local backend shim preserves all 321 callable exports and authentication bootstrap. Scheduled jobs, public HTTP handlers, and Firestore triggers are excluded. Production backend deployment from this repository is blocked.

## Live verification boundary

The live browser completed Google sign-in at the new Hosting origin, loaded the Chat list, and made authenticated requests to `us-central1-influchat-77db6.cloudfunctions.net`. Checked endpoint metadata included organization context, mail accounts, conversations, and conversation messages. No mailbox content or credentials are stored as verification evidence in this repository.

The new Hosting domains were added to the existing Flu Firebase Auth authorized-domain list. The previous Hosting release was recorded locally before replacement. Existing `influencer-crm-296ca` Firestore documents and Auth users were not deleted. No Flu Functions release or duplicated mail ingestion/send worker was deployed.

Mail connection uses the existing Flu OAuth callback in a separate Google consent window. Mixmaxclone refreshes shared connection status when focus returns or that window closes. The current server requires `supercent.io` Workspace accounts. Personal Gmail and non-company app login are not enabled by this migration. Google app sign-in alone is not proof of a connected mailbox. A new real mailbox consent, production email delivery, and production AI generation were not exercised as migration tests; the account owner can connect mailboxes from the integrations screen.

## Repeatable checks

Use Node.js 22 and Java for the Firebase emulators:

```sh
npm ci
npm --prefix functions ci
npm test
npm run typecheck
npm run verify:e2e
npm run verify:migration
npm run configure:live
npm run build:hosting
```

Unit/backend tests run with the node-lane backend seal. Browser tests use the `demo-flu` Auth, Firestore, and Functions emulators and synthetic fixtures. Mail draft preview is exercised without real delivery. Build output and local test traces are ignored by Git.

## Release candidate results — 2026-10-07

| Check | Result |
| --- | --- |
| `npm test` | 156 passed, 0 failed, 0 skipped; Functions build included |
| `npm run verify:e2e` | 8 passed, 0 failed; emulator build and shutdown completed |
| `npm run typecheck` | Passed |
| `npm run deploy:hosting` | Static export passed; 113 files deployed successfully to `influencer-crm-296ca` Hosting only |
| `npm run verify:migration` | 853 source-derived files verified; 321 callable exports, 0 worker exports |
| `git diff --cached --check` | Passed |
| Live browser | New-domain Google sign-in, shared conversation reads, and sync status completing/restarting over a 35-second observation confirmed |
| Independent review | Shared-data/auth boundaries, guarded polling, companion OAuth, and secret exclusion accepted |

The eight browser scenarios cover authenticated conversation list/detail/read, server-rendered draft preview without send, receipt/template/casebook surfaces, positive and negative mailbox isolation, a new emulator conversation arriving without a manual reload while an unsent draft survives, safe OAuth popup, unsafe URL rejection, and popup-blocked fallback/status refresh. OAuth provider pages and begin/status responses are synthetic in that suite.

The imported source's entire historical E2E catalog was not re-certified. A separate inherited diagnostic run was stopped after shared test artifacts/emulators changed, and is excluded from the results above. Partial-read error reporting has a source contract check; provider outages and token revocation were not exercised live.
