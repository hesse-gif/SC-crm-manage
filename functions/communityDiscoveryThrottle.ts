import type { FirestoreDb } from "./feedWorkerTypes";

export const COMMUNITY_DISCOVERY_STATE_COLLECTION = "feed_discovery_state";
export const COMMUNITY_DISCOVERY_STATE_DOC = "community";
export const DEFAULT_COMMUNITY_DISCOVERY_COOLDOWN_HOURS = 24;

export type CommunityDiscoveryCooldownDecision = {
  readonly allowed: boolean;
  readonly cooldownHours: number;
  readonly lastAutoRunIso: string | null;
  readonly nextEligibleIso: string | null;
  readonly remainingMs: number;
};

type CommunityDiscoveryCooldownInput = {
  readonly nowIso: string;
  readonly lastAutoRunIso?: string | null;
  readonly cooldownHours?: number;
};

type CommunityDiscoveryStateWrite = {
  readonly nowIso: string;
  readonly runId: string;
  readonly source: "callable" | "scheduled";
  readonly cooldownHours?: number;
};

function normalizedCooldownHours(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COMMUNITY_DISCOVERY_COOLDOWN_HOURS;
  return Math.max(1, Math.min(Math.trunc(value), 168));
}

function parseIsoMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

function addHoursIso(iso: string, hours: number): string {
  const baseMillis = parseIsoMillis(iso) ?? Date.now();
  return new Date(baseMillis + hours * 60 * 60 * 1000).toISOString();
}

function communityStateDoc(db: FirestoreDb) {
  return db.collection(COMMUNITY_DISCOVERY_STATE_COLLECTION).doc(COMMUNITY_DISCOVERY_STATE_DOC);
}

export function communityDiscoveryCooldownDecision(input: CommunityDiscoveryCooldownInput): CommunityDiscoveryCooldownDecision {
  const cooldownHours = normalizedCooldownHours(input.cooldownHours);
  const lastMillis = parseIsoMillis(input.lastAutoRunIso);
  if (lastMillis === null) {
    return {
      allowed: true,
      cooldownHours,
      lastAutoRunIso: null,
      nextEligibleIso: null,
      remainingMs: 0,
    };
  }

  const nowMillis = parseIsoMillis(input.nowIso) ?? Date.now();
  const nextEligibleMillis = lastMillis + cooldownHours * 60 * 60 * 1000;
  const remainingMs = Math.max(0, nextEligibleMillis - nowMillis);
  return {
    allowed: remainingMs === 0,
    cooldownHours,
    lastAutoRunIso: input.lastAutoRunIso ?? null,
    nextEligibleIso: new Date(nextEligibleMillis).toISOString(),
    remainingMs,
  };
}

export async function readCommunityDiscoveryState(
  db: FirestoreDb,
  nowIso: string,
  cooldownHours = DEFAULT_COMMUNITY_DISCOVERY_COOLDOWN_HOURS,
): Promise<CommunityDiscoveryCooldownDecision> {
  const snapshot = await communityStateDoc(db).get();
  const record = snapshot.data() ?? {};
  const lastAutoRunIso = typeof record.lastAutoRunIso === "string" ? record.lastAutoRunIso : null;
  return communityDiscoveryCooldownDecision({ nowIso, lastAutoRunIso, cooldownHours });
}

export async function writeCommunityDiscoveryState(db: FirestoreDb, state: CommunityDiscoveryStateWrite): Promise<void> {
  const cooldownHours = normalizedCooldownHours(state.cooldownHours);
  await communityStateDoc(db).set({
    id: COMMUNITY_DISCOVERY_STATE_DOC,
    lastAutoRunIso: state.nowIso,
    nextEligibleIso: addHoursIso(state.nowIso, cooldownHours),
    cooldownHours,
    lastRunId: state.runId,
    lastRunSource: state.source,
    updatedAtIso: state.nowIso,
  }, { merge: true });
}
