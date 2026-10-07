# Mixmax Flu Data Import Plan

This plan moves safe Flu business and chat data into Mixmax-owned projection collections in `influencer-crm-296ca`, named Firestore database `mixmax`.

Flu is the source of historical business data only. The importer must not write to Flu, must not copy Flu credentials, and must not make Mixmax depend on Flu runtime reads after import.

## Scope

Source:

- Firebase project: `influchat-77db6`
- Access mode: read-only
- Allowed source collections: `conversations`, `message_sources`, `creators`, `templates`, `scp_mail_templates`, `auto_reply_queue`, `chat_auto_casebook_proposal_outbox`, `auto_reply_case_intents`, `chat_auto_case_permits`, `programs`, `campaigns`, `mail_outbound_log`
- Special nested source: `conversations/{id}/messages`
- Special metadata-only source: `mail_accounts`, limited to `accountId` and `mailbox`

Target:

- Firebase project: `influencer-crm-296ca`
- Firestore database: `mixmax`
- Workspace: `primary`
- Target collections: `mixmax_threads`, `mixmax_messages`, `mixmax_contacts`, `mixmax_templates`, `mixmax_cases`, `mixmax_drafts`, `mixmax_sequences`, `mixmax_sends`

Out of scope:

- Flu OAuth credentials, refresh tokens, provider secrets, service account data, app settings, and role/config collections.
- Automatic sequence sending.
- Imported send rows becoming retryable send jobs.
- Any Flu writeback.

## Mapping

| Flu source | Mixmax target | Notes |
| --- | --- | --- |
| `conversations` | `mixmax_threads` | Conversation projection with mailbox metadata and participant emails. |
| `conversations/{id}/messages` | `mixmax_messages` | Nested messages, enriched from `message_sources` when `messageRef` is available. |
| `message_sources` | `mixmax_messages` | Canonical message body projection. |
| `creators` | `mixmax_contacts` | Contact/name/email/channel projection. |
| `templates`, `scp_mail_templates` | `mixmax_templates` | Safe template body and subject fields. |
| `auto_reply_queue`, `chat_auto_casebook_proposal_outbox` | `mixmax_drafts` | Imported as `needs_review`; `ownerUid` is empty until a Mixmax user owns or sends new work. |
| `auto_reply_case_intents`, `chat_auto_case_permits`, `programs`, `campaigns` | `mixmax_cases` | Imported as case/policy context with `automaticSendingEnabled: false`. |
| `mail_outbound_log` | `mixmax_sends` | Imported receipt/history only, with `automaticRetryBlocked: true`. |
| static Flu chat casebook | `mixmax_cases` | 21 casebook cases imported by `scripts/mixmax-import-casebook.mjs`. |

All imported IDs are deterministic `flu_` IDs based on a SHA-256 hash of source identity parts. Reruns create missing target documents and skip existing documents so native Mixmax edits are preserved.

## Safety Rules

- `assertProjectGuard` requires source `influchat-77db6`, target `influencer-crm-296ca`, and database `mixmax`.
- Import refuses inherited Firestore emulator configuration for production runs.
- Source collections not in the whitelist are rejected.
- Credential-shaped keys are redacted recursively by `sanitizeForImport`.
- `mail_accounts` is never imported as a collection; it is read only for non-secret mailbox labels.
- Existing target documents are skipped instead of overwritten.
- Existing imported Flu conversations can only be replied to after the operator connects a matching Google mailbox in Mixmax.

## Commands

Dry run:

```sh
npm run import:flu -- --dry-run
```

Apply:

```sh
npm run import:flu -- --apply
```

Limit to selected source collections:

```sh
npm run import:flu -- --dry-run --collections=conversations,creators,templates
```

Import the static chat casebook:

```sh
node scripts/mixmax-import-casebook.mjs --apply
```

Reconcile full message bodies and legacy short-ID duplicate rows:

```sh
node scripts/mixmax-reconcile-messages.mjs --dry-run
node scripts/mixmax-reconcile-messages.mjs --apply
```

Finalize a captured inventory:

```sh
node scripts/mixmax-finalize-import.mjs --dry-run --inventory=.mixmax-import/finalize-inventory-2026-10-07T06-34-28-861Z.json
node scripts/mixmax-finalize-import.mjs --apply --inventory=.mixmax-import/finalize-inventory-2026-10-07T06-34-28-861Z.json
```

These commands are intentionally production-side-effecting when `--apply` is used. They are guarded to source `influchat-77db6`, target `influencer-crm-296ca`, and target database `mixmax`, and they refuse inherited Firestore emulator configuration.

## Current Import State

- Casebook import succeeded for 21 cases.
- Main import completed in `artifacts/verification/mixmax-import-final.log`.
- Message reconciliation completed in `artifacts/verification/mixmax-reconcile.log`: 44,802 message sources read, 34 created, 44,778 patched, and 11,216 legacy short-ID duplicates removed after backup.
- Finalize apply completed in `artifacts/verification/mixmax-finalize.log` for `.mixmax-import/finalize-inventory-2026-10-07T06-34-28-861Z.json`, captured from 2026-10-07 06:34:28.861 UTC through 06:34:49.062 UTC. All 12 source collections report `missingAfter=0`.
- Captured source inventory: conversations 26,239; message sources 44,801; contacts 787; templates 47 total (`templates` 6 + `scp_mail_templates` 41); drafts 28 total (`auto_reply_queue` 25 + `chat_auto_casebook_proposal_outbox` 3); imported send receipts 41,778; case/policy rows 80 total (`auto_reply_case_intents` 21 + `chat_auto_case_permits` 8 + `programs` 11 + `campaigns` 40) plus 21 static casebook cases.
- Source Flu is live, so the captured inventory timestamp bounds what was finalized. Later source additions are not continuously mirrored.
- Independent nested association audit is still running, so do not claim every imported nested conversation/message join has been audited yet.

## Completion Criteria

The import can be called complete only when all of these are true:

- `scripts/mixmax-import-flu.mjs --apply` has exited with code 0 for the main import.
- `scripts/mixmax-reconcile-messages.mjs --apply` has exited with code 0 for full-body message reconciliation and duplicate cleanup.
- `scripts/mixmax-finalize-import.mjs --apply --inventory=<captured inventory>` has exited with code 0 and reports no missing captured source IDs.
- Target counts are reconciled against source counts for conversations, messages, contacts, templates, cases, drafts, sequences, and imported send receipts.
- A spot check confirms imported Flu threads render in `/mail` from the target `mixmax` database.
- No credential-shaped fields appear in imported target documents.
- Historical rows that still lack mailbox metadata either have assigned sender metadata or are documented as not sendable until assigned.

## Captured Association Recovery

The independent audit checked 51,207 nested conversation messages. Six missing associations (including one shared-reference alias and three messages without source references) were recovered with `scripts/mixmax-repair-associations.mjs --apply`; post-write missing count was zero. The tool requires the private, ignored `.mixmax-import/association-recovery.json` from the audit. It validates source paths and fixed project/database IDs, preserves existing records, and writes only to Mixmax. Its artifact is deliberately excluded from git because source identifiers are private.

Historical threads without a sender can now be explicitly assigned an owned, connected Google account in Mixmax. This does not change Flu and does not send mail.
