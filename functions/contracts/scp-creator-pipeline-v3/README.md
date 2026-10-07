# SCP Creator Pipeline v3

This contract is a separate semantic family. It does not modify the frozen `scp.integration-event.v2` schema or fixtures.

- `application.intake.recorded` contains stable identifiers (including optional `channelId`), attribution classification, revisions, and an exact private-material hash. An attributed intake additionally carries a verifiable signed-attribution evidence block: exact program/campaign/outreach/trace identity, key ID, signed expiry, verification time, token/signature fingerprints, exact expected-email-HMAC candidate result, and a versioned checked-not-revoked reference. It never contains raw answers or contact data.
- Flu obtains raw application answers only from the separately signed, bounded, no-store application-material route after Portal records delivered intake evidence.
- `application.management.acknowledged` is a signed Flu event that binds the exact application revision and material hash to stable Portal/Flu/program/campaign/enrollment identity mappings.
- Only a materialized active management acknowledgement can issue a Portal onboarding/content grant. Portal does not send email.
- Event identity is deterministic from canonical JSON excluding `schemaVersion`, `eventId`, and `occurredAt`. Same event ID with different identity is a conflict.

## Artifact Hashing

- Schema SHA-256: `e9b0c96e5d857cbe13e8fc227b7abb74b96e99d6d7b7c6366e7686c02b7efd87`
- Positive fixture aggregate SHA-256: `ca230ac49ed733c1e1c6a662a299fd6d61832857461c79583c1aa8b92383eae5`
- Positive fixture aggregate algorithm: `sha256(sorted fixture filename + NUL + exact fixture file bytes + LF)`
- Negative fixture aggregate algorithm: `sha256(sorted negative fixture filename + NUL + exact negative fixture file bytes + LF)`
- Manifest records individual file hashes for schema, types, README, every positive fixture, and every negative fixture file.

The positive aggregate covers only `fixtures/*.json`; adding negative fixtures must not change the positive aggregate. The negative aggregate covers only `negative-fixtures/*.json` and is distributed so Flu can reproduce both accepted and rejected examples independently.

## Negative Fixture Coverage

The negative fixture package covers these regression surfaces:

- raw email, UID-like values, OAuth token fields, and bearer grant fields in integration events;
- same event ID with different canonical payload bytes;
- non-canonical JSON bytes and invalid deterministic event IDs;
- missing or extra keys;
- invalid RFC3339 or impossible verification clocks;
- ambiguous/unclassified/conflict attribution carrying signed evidence;
- signed outreach evidence without a checked revocation reference;
- management acknowledgement state mismatches for material event, application revision, trace, binding, and assignment mode;
- inactive enrollment states that must block new grant issuance.

Event-shape cases execute through Portal runtime validators. State-helper cases document the exact state assertions enforced by Portal management/material/onboarding helpers and are backed by the Firestore management route tests.

## Ownership

- Portal owns application intake, private material snapshots, the v3 outbox, signed material/status routes, exact-match signed-attribution evidence, and Portal grant creation after active Flu management acknowledgement.
- Flu owns campaign assignment authority, management materialization, onboarding email provider/template/retry behavior, and the signed `application.management.acknowledged` callback.
- Portal must not emit raw answers, raw email, UID values, OAuth tokens, bearer grants, or customer-visible onboarding delivery records in v3 integration events.

Video revision, invalidation, review, and downstream-projection definitions will ship as a separate schema package under the v3 major namespace in P4/P5; they must not mutate this application-event manifest. Operational key IDs and endpoint deployment values remain `[확인 필요]` until paired Flu acceptance.
