# SCP Video Submission Review v3

This package freezes the Portal producer contract for canonical video submission revisions, SCP Automation review callbacks, and Flu downstream projection callbacks. It is intentionally separate from `contracts/scp-creator-pipeline-v3` and does not alter the application v3 schema or fixture aggregate SHA.

## Scope

- Portal emits `scp.video-submission-review.v3` events only from the canonical `VideoSubmission` append-only revision model.
- Portal delivery is durable through `scp_video_submission_review_outbox`; a `201` or duplicate `200` with a bounded `scp.video-submission-review.receipt.v1` body is required before review callbacks can be accepted.
- SCP Automation sends signed `scp.video-review-callback.v3` review observations to Portal.
- Flu sends signed `scp.video-downstream-callback.v3` projection observations only after it has materialized the currently approved revision.
- Rejected, changes-requested, human-review-required, pending, queued, delivered, withdrawn, stale, superseded, and policy/fingerprint-mismatched revisions are not Feed, Report, tracker, or settlement eligible.

## Identity And Privacy

Events carry stable non-contact identifiers only: `videoSubmissionId`, `videoRevision`, `applicationId`, `programId`, `portalCreatorId`, `fluCreatorId`, `partnerId`, `campaignId`, optional `outreachId`, `enrollmentId`, optional `settlementCreatorCode`, optional `channelId`, `contentFingerprint`, and `policyVersion`.

Never add raw email, UID values, OAuth/access/refresh tokens, creator-entered titles/descriptions, or `reportedViews` to these event payloads. `reportedViews` remains diagnostic evidence inside Portal only and is not a settlement authority.

## Event Identity

All event bodies are canonical JSON. `eventId` is deterministic from the runtime identity material and has the form `evt_<32 lowercase hex>`. The same `eventId` with a different payload, subject, trace, policy, or body hash is an idempotency conflict. `traceId` remains stable across Portal revision delivery, SCP Automation review observations, and Flu downstream observations.

Submitted revision events always include the normalized YouTube URL, YouTube video ID, published timestamp, and content type. Withdrawal events contain none of those mutable video fields. `invalidatesApprovedRevision`, when present, identifies an earlier revision and is never valid on an initial `upsert`.

## State Rules

Portal creator submission creates a canonical revision, audit evidence, idempotency receipt, and review outbox. The visible sequence is:

`submitted -> delivery_queued -> delivered_to_scp_automation -> queued -> in_review -> approved | changes_requested | human_review_required | rejected`

`delivered_to_scp_automation` is receipt only, not approval. Only a current `approved` revision can be projected downstream. If an approved URL/video/content type/published timestamp is replaced or withdrawn, the old downstream projection is invalidated and the new/current revision returns to SCP Automation review before any downstream eligibility can reappear.

## HMAC And Replay

Outbound Portal review events use `SCP_VIDEO_REVIEW_CURRENT_KEY_ID` and `SCP_VIDEO_REVIEW_CURRENT_KEY_SECRET`. The SCP Automation review callback route uses `SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_ID` and `SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_SECRET`. The Flu downstream callback route uses `SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_ID` and `SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_SECRET`.

Previous key slots exist for rotation only. Timestamp skew is bounded, content SHA must match exact bytes, signatures are replay-protected, and all callbacks reject browser transport metadata.

## Migration And Cutover

Retire the legacy direct-to-Flu video intake and legacy Portal review action paths before enabling this contract in staging. Historical reads may remain for audit, but active review, projection, tracker, and settlement eligibility must flow through the canonical revision/outbox/callback path in this package.

Flu must vendor/consume the exact `manifest.json` schema and fixture hashes, then acknowledge `FLU CONSUMER READY` before the authorized private-creator black-box acceptance scenario starts. The creator's contact identity is intentionally excluded from this distributable contract.
