# Flu chat backend migration slice

Source snapshot: `supercent-io/Flu` at `be5915aeb455b3ce378e022125dcc09d514b8d8d` (`release/flu-0-6-116`).

This directory is a local, reproducible copy of Flu's Firebase Functions backend closure for the Mixmaxclone chat migration. It is not a new production backend. Production Mixmaxclone should keep using the existing live Flu Firebase project and callable names so Flu and Mixmaxclone see the same Firestore/Auth data continuously.

Do not deploy this functions directory to production. Deploying it as a second backend would duplicate scheduler/ingest/send workers. The copied `functions/index.ts` is retained for regression compatibility with upstream Flu tests, but local emulator work should use `functions/chat-entry.ts` when a chat-only surface is needed.

## Copied scope

Copied tracked files only:

- `functions/**`
- `firestore.rules`
- `firestore.indexes.json`

Explicitly excluded:

- `functions/.env*`
- `functions/.secret*`
- `functions/node_modules/`
- `functions/lib/`
- any source-repo build output or credential material

## Emulator entry

`functions/package.json` selects `lib/chat-entry.js`. The shim imports the unchanged upstream index and re-exports all 321 callable endpoints plus `assignGuestClaims`. This preserves the original wrapper/auth behavior, including the data providers and admin support APIs used by the chat screens.

The shim omits all scheduled workers, public HTTP handlers and Firestore triggers. It removes callable Secret Manager metadata so local tests do not fetch production credentials. `npm run verify:migration` checks callable identity/parity and the absence of worker exports.

## Live-data integration contract

The frontend migration should point to the existing Flu live Firebase project/config and call the existing deployed callable names. No Mixmaxclone backend deployment is required for live use.

For refresh behavior, the Flu client already has a live refresh path around `flu:data-refresh`, `LiveProvider.refresh`, and `listConversations`; keep that contract when wiring Mixmaxclone chat so send/receive/mutation flows re-read the shared live backend state instead of maintaining a forked cache.

## Local verification commands

Use Node 22 for Functions dependency resolution:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm ci --prefix functions
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm --prefix functions run build
```

These commands are local-only. They must not be followed by `firebase deploy` from this repository.
