import { createHash } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { adminDb } from "./firebaseAdmin";
import {
  makeYouTubeDataApiClient,
  resolveYouTubeChannelById,
  type YouTubeApiClient,
} from "./youtubeEnrichmentService";

const CREATORS_COLLECTION = "creators";

/**
 * Canonical YouTube channel id shape. The portal only ever emits a channel id that its own
 * `verifiedChannelId` gate produced (`audienceGeo.channel.id` and `youtubeOAuth.channelId` in
 * exact agreement, lifecycle `verified`), and both of those fields are written only by the
 * creator's own OAuth callback and the schedule that runs on that creator's token — no operator
 * on either side can write them. That is what makes this lane a legitimate authority root for
 * `creators.youtubeChannelId` rather than a circular one.
 */
const CANONICAL_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const PORTAL_CHANNEL_VERIFIED_AUTHORITY_VERSION =
  "flu.portal-channel-verified-identity.v1";
export const PORTAL_CHANNEL_VERIFIED_IDENTITY_SOURCE = "portal_channel_verified";

export type PortalChannelVerifiedSubject = Readonly<{
  applicationId: string;
  portalCreatorId: string;
  programId: string;
}>;

export type PortalChannelVerifiedPayload = Readonly<{
  verifiedChannelId: string;
  verifiedAt: string;
  oauthConnectedAt: string;
  audienceFetchedAt: string;
  policyVersion: string;
}>;

export type PortalChannelVerifiedDeps = Readonly<{
  db?: Firestore;
  youtubeApi?: Pick<YouTubeApiClient, "channelsList">;
}>;

export type PortalChannelVerifiedOutcome = Readonly<{
  /** `created` mints a new creator; `reused` binds to one that already carried this channel. */
  action: "created" | "reused" | "idempotent_noop";
  fluCreatorId: string;
  channelTitle: string | null;
}>;

export type PortalChannelVerifiedError = Error & { code: string };

/**
 * Whether a failure is worth retrying is decided by `integrationEventV2ErrorStatus`, which maps
 * these codes to the HTTP status the portal's delivery lane reads. Carrying a second `retryable`
 * boolean here would be a field nothing consumes — and one a future reader could mistake for the
 * thing that actually controls redelivery.
 */
function ingressError(code: string, message: string): PortalChannelVerifiedError {
  return Object.assign(new Error(message), { code });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Deterministic creator id derived from the verified channel. Redelivery and the portal's
 * backfill emitter both re-send the same event, so identity must land on the same document every
 * time for create-once to hold. The `portal-verified:` namespace keeps these ids disjoint from
 * the legacy sheet lane's `legacy-sheet:` suffixes, which hash the same channel values.
 */
export function portalVerifiedCreatorId(verifiedChannelId: string): string {
  const suffix = createHash("sha256")
    .update(`portal-verified:channel:${verifiedChannelId}`)
    .digest("hex")
    .slice(0, 24);
  return `CR_portal_youtube_${suffix}`;
}

export function parsePortalChannelVerifiedPayload(
  raw: unknown,
): PortalChannelVerifiedPayload {
  const record = (raw ?? {}) as Record<string, unknown>;
  const verifiedChannelId = asString(record.verifiedChannelId);
  if (!CANONICAL_CHANNEL_ID_RE.test(verifiedChannelId)) {
    throw ingressError(
      "invalid_verified_channel_id",
      "payload.verifiedChannelId is not a canonical YouTube channel id",
    );
  }
  const policyVersion = asString(record.policyVersion);
  if (!policyVersion) {
    throw ingressError("missing_policy_version", "payload.policyVersion is required");
  }
  const times = { verifiedAt: "", oauthConnectedAt: "", audienceFetchedAt: "" };
  for (const key of Object.keys(times) as Array<keyof typeof times>) {
    const value = asString(record[key]);
    if (!RFC3339_RE.test(value)) {
      throw ingressError("invalid_evidence_timestamp", `payload.${key} is not an RFC3339 instant`);
    }
    times[key] = value;
  }
  return { verifiedChannelId, policyVersion, ...times };
}

/**
 * Existing carriers of a channel, matched on `youtubeChannelId` ONLY.
 *
 * `creators.channelId` is deliberately not consulted: `upsertCreator` (crm.ts, WRITER_ROLES
 * includes manager/admin/super_admin) merge-writes caller-supplied `channelId` with no
 * validation, so an operator can plant any channel string on any creator document. Matching on
 * it would let a planted document capture a real creator's verification — the same forgeable
 * field that this workstream's adversarial review has already had to close twice on the binding
 * path. `youtubeChannelId` has no operator-reachable writer, which is the entire reason it is
 * the authority root.
 */
async function creatorIdsForChannel(db: Firestore, channelId: string): Promise<string[]> {
  const matches = await db
    .collection(CREATORS_COLLECTION)
    .where("youtubeChannelId", "==", channelId)
    .limit(3)
    .get();
  return [...new Set(matches.docs.map((document) => document.id))];
}

/**
 * Creators already minted by this lane for a portal creator, used to fail closed when the same
 * portal creator turns up carrying a different channel (re-connection to another channel).
 * Splitting one person across two unlinked `creators` documents is not something this lane may
 * decide on its own — an existing binding would keep pointing at the old channel.
 */
async function portalLaneCreatorsFor(db: Firestore, portalCreatorId: string): Promise<Array<{ id: string; channelId: string }>> {
  const matches = await db
    .collection(CREATORS_COLLECTION)
    .where("portalCreatorId", "==", portalCreatorId)
    .where("identitySource", "==", PORTAL_CHANNEL_VERIFIED_IDENTITY_SOURCE)
    .limit(3)
    .get();
  return matches.docs.map((document) => ({
    id: document.id,
    channelId: asString(document.data()?.youtubeChannelId),
  }));
}

/**
 * Materialise the Flu creator that a portal-verified channel identifies, creating one only when
 * the channel is not already carried by an existing creator.
 *
 * Fail-closed rules, in the order they are applied:
 *  - more than one existing creator already carries this channel -> never merge identities
 *    automatically, surface it for a human;
 *  - YouTube reports the channel does not exist -> the id is canonical-shaped but not real;
 *  - YouTube could not be reached -> 503, so redelivery retries rather than minting a creator
 *    whose display name we could not establish;
 *  - an existing document under the deterministic id carries a different channel -> conflict.
 */
export async function materializePortalVerifiedCreator(
  subject: PortalChannelVerifiedSubject,
  payload: PortalChannelVerifiedPayload,
  now: Date,
  deps: PortalChannelVerifiedDeps = {},
): Promise<PortalChannelVerifiedOutcome> {
  const db = deps.db ?? adminDb;
  const { verifiedChannelId } = payload;

  const existingIds = await creatorIdsForChannel(db, verifiedChannelId);
  if (existingIds.length > 1) {
    throw ingressError(
      "identity_ambiguous",
      `verified channel is carried by ${existingIds.length} creators; refusing to merge identities`,
    );
  }
  if (existingIds.length === 1) {
    return { action: "reused", fluCreatorId: existingIds[0], channelTitle: null };
  }

  // Re-verification against a different channel would silently split one person into two
  // unlinked creator documents (the id is derived from the channel, the event receipt from the
  // portal creator), leaving any existing binding pointed at the old channel. Deciding which
  // identity wins is not this lane's call.
  const laneCreators = await portalLaneCreatorsFor(db, subject.portalCreatorId);
  const divergent = laneCreators.filter((entry) => entry.channelId !== verifiedChannelId);
  if (divergent.length > 0) {
    throw ingressError(
      "channel_reverification_conflict",
      `portal creator already carries a different verified channel (${divergent.length} creator(s)); refusing to split identity`,
    );
  }

  // Only reached when the channel is genuinely new to Flu, so the YouTube call cost is bounded by
  // first-time verifications rather than by redelivery volume. Client construction is inside the
  // try because it throws when YOUTUBE_API_KEY is absent, and a missing-secret deployment must
  // surface as this lane's classified failure rather than as an unhandled crash.
  let lookup: Awaited<ReturnType<typeof resolveYouTubeChannelById>>;
  try {
    const api = deps.youtubeApi ?? makeYouTubeDataApiClient();
    lookup = await resolveYouTubeChannelById(api, verifiedChannelId);
  } catch (error) {
    throw ingressError(
      "channel_lookup_unavailable",
      `YouTube channel lookup failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  if (!lookup.exists) {
    throw ingressError(
      "channel_not_found",
      "YouTube does not report a channel for the portal-verified channel id",
    );
  }

  const fluCreatorId = portalVerifiedCreatorId(verifiedChannelId);
  const creatorRef = db.collection(CREATORS_COLLECTION).doc(fluCreatorId);
  const nowIso = now.toISOString();

  let created = false;
  await db.runTransaction(async (transaction) => {
    created = false;
    const snapshot = await transaction.get(creatorRef);
    if (snapshot.exists) {
      const existing = snapshot.data() ?? {};
      // Only `youtubeChannelId` counts, for the same reason creatorIdsForChannel ignores
      // `channelId`: the deterministic id is derived from public data by a published algorithm,
      // so an operator can pre-create a document at that exact id via upsertCreator. Accepting a
      // planted `channelId` — or treating a document with neither field as "already correct" —
      // would let that squat swallow the real verification and report success while
      // `youtubeChannelId` is never written.
      const existingChannel = asString(existing.youtubeChannelId);
      if (existingChannel !== verifiedChannelId) {
        throw ingressError(
          "identity_conflict",
          existingChannel
            ? "creator under the deterministic id carries a different channel"
            : "creator under the deterministic id predates this lane and carries no verified channel",
        );
      }
      return;
    }
    created = true;
    transaction.create(creatorRef, {
      channelId: verifiedChannelId,
      youtubeChannelId: verifiedChannelId,
      name: lookup.title ?? verifiedChannelId,
      portalCreatorId: subject.portalCreatorId,
      programId: subject.programId,
      sourceApplicationId: subject.applicationId,
      identitySource: PORTAL_CHANNEL_VERIFIED_IDENTITY_SOURCE,
      authorityVersion: PORTAL_CHANNEL_VERIFIED_AUTHORITY_VERSION,
      policyVersion: payload.policyVersion,
      channelVerifiedAtIso: payload.verifiedAt,
      oauthConnectedAtIso: payload.oauthConnectedAt,
      audienceFetchedAtIso: payload.audienceFetchedAt,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
      // Required, not cosmetic: the management dataset reads creators with orderBy("updatedAtIso")
      // and Firestore drops documents that lack the sort field entirely, so a creator minted
      // without it can never reach the screen. Prod hit exactly this with 15 legacy-lane records
      // on 2026-07-26; this lane does not repeat it.
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // The observability field must distinguish a real mint from an idempotent redelivery — the
  // portal's backfill emitter replays this event, and a receipt lane that counts every replay as
  // a creation cannot tell a genuine issuance from noise.
  return {
    action: created ? "created" : "idempotent_noop",
    fluCreatorId,
    channelTitle: lookup.title,
  };
}
