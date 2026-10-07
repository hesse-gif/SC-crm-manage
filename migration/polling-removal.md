# Polling Removal

The old Flu-style foreground refresh loop is removed from the Mixmax independent app. Mixmax should not use a 30-second client timer to fetch conversation data, and it should not use a 5-second selected-thread polling loop for draft state.

## Current Model

The browser subscribes to target Firestore collections with `onSnapshot`:

- `mixmax_threads`
- `mixmax_messages`
- `mixmax_drafts`
- `mixmax_templates`
- `mixmax_contacts`
- `mixmax_cases`
- `mixmax_sequences`
- `mixmax_sends`
- `mixmax_connections`

Incoming Gmail changes flow through the server:

```text
Gmail watch
  -> Pub/Sub message on mixmax-gmail
  -> mixmaxGmailPush queues mixmax_sync_jobs/{connectionId}
  -> mixmaxSyncJob reads Gmail history changes
  -> target Firestore projection updates
  -> browser onSnapshot receives the change
```

Manual refresh still exists as an explicit user action through `mixmaxSyncMailbox`.

## Why Timers Stay Out

- Client intervals create repeated reads even when no mailbox changed.
- Polling does not make Gmail ingestion faster; Gmail watch/history determines when new mail is available.
- Timers increase idle cost across every open browser tab.
- Timers risk overwriting active composer state if the UI treats refresh as a full reload.

The latest Mixmax E2E suite in `artifacts/verification/mixmax-e2e-draft-context.log` verified that a new target Firestore message appears through realtime subscription and that no callable POSTs are made during a 35-second idle window.

## Allowed Refresh Paths

- Initial page load and authenticated workspace bootstrap.
- Firestore realtime updates from target collections.
- Explicit user actions such as save draft, save template, mark read, archive, send, generate AI draft, and manual mailbox refresh.
- Server-side Gmail watch renewal, sync retry, and full-sync fallback.

## Do Not Reintroduce

Do not add browser intervals for:

- conversation list refresh
- selected thread refresh
- draft status refresh
- mailbox sync polling
- AI draft polling

If a future feature needs progress updates, write a server-owned status document in the `mixmax` database and let the browser subscribe to that document.
