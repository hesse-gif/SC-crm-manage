const DEMO_SEED_ID = "flu-demo-seed";

// seedTag 를 픽스처 증거로 인정하는 컬렉션. 파트너 목록과 검수 대기 목록만 시드 행 숨김을 요청했다.
const SEED_TAG_SCOPED_COLLECTIONS = new Set([
  "scp_partner_activations",
  "scp_video_review_state",
  // 정산 원장·KPI 도 시드 행을 실적으로 세면 안 된다(W3.1-C3).
  "video_performance_report_rows",
]);

// These are exact provenance values written only by bundled demo, emulator, or
// historical MVP fixture paths. Deliberately avoid substring matching: a migrated
// production source such as `mvp-live-test-migrated-production` must remain visible.
const KNOWN_OPERATIONAL_FIXTURE_SOURCES = new Set([
  "fixture",
  "mock",
  "mvp-live-test",
  "seed",
  "emulator_mock",
  "mock-youtube-discovery-worker",
  "mock-youtube-callable",
  "mock-email-finder-callable",
  "mock-campaign-auto-discovery",
  "mock-campaign-auto-discovery-fallback",
  "community-adapter-fallback",
  "community-emulator-fallback",
  "live-flu-campaign-stress",
]);

const KNOWN_OPERATIONAL_FIXTURE_GAME_IDS = new Set([
  "flu-live-campaign-stress",
]);

const KNOWN_OPERATIONAL_FIXTURE_ACTORS = new Set([
  "flu-persona-e2e",
]);

// Before fixture provenance was persisted, the bundled MVP seed wrote these
// creator documents with ordinary-looking rows. Production may still contain
// those unmarked records. Match the complete immutable tuple only: an id, name,
// or handle on its own is not enough to classify real operator data as a seed.
const LEGACY_CREATOR_FIXTURE_TUPLES = new Map<string, readonly [name: string, handle: string]>([
  ["c1", ["mrbeast gaming", "@mrbeastgaming"]],
  ["c2", ["total gaming", "@totalgaming093"]],
  ["c3", ["techno gamerz", "@technogamerzofficial"]],
  ["c4", ["dantdm", "@dantdm"]],
  ["c5", ["arab games network", "@arabgamesnetwork"]],
  ["c6", ["ali-a", "@alia"]],
  ["c7", ["ryan's world", "@ryansworld"]],
  ["c8", ["pokémon indonesia", "@pokemonindonesiaofficial"]],
  ["c9", ["windah basudara", "@windahbasudara"]],
  ["c10", ["gh's", "@gh.s"]],
  ["rc-hesse", ["supercent official", "@supercent_official"]],
]);

const LEGACY_CANDIDATE_FIXTURE_TUPLES = new Map<string, readonly [name: string, handle: string, channelRef: string]>([
  ["p1", ["bento plays", "@bentoplays", "yt_channel_bento_plays"]],
  ["p2", ["luna mobile", "@lunamobile", "yt_channel_luna_mobile"]],
  ["p3", ["pixelhan", "@pixelhan", "yt_channel_pixelhan"]],
  ["p4", ["sora games", "@soragames", "yt_channel_sora_games"]],
  ["p5", ["clip master", "@clipmaster", "yt_channel_clip_master"]],
  ["p6", ["indie vault", "@indievault", "yt_channel_indie_vault"]],
  ["p7", ["moaplay", "@moaplay", "yt_channel_moaplay"]],
  ["p8", ["arena kim", "@arenakim", "yt_channel_arena_kim"]],
  ["p9", ["tiny games", "@tinygames", "yt_channel_tiny_games"]],
  ["p10", ["puzzle yui", "@puzzleyui", "yt_channel_puzzle_yui"]],
]);

function normalizedMarker(value: unknown): string {
  return typeof value === "string" ? value.trim().normalize("NFKC").toLowerCase() : "";
}

function normalizedCollection(value: unknown): string {
  return typeof value === "string"
    ? value.trim().normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    : "";
}

function isLegacyCreatorFixture(row: Record<string, unknown>, collection = ""): boolean {
  if (collection && normalizedCollection(collection) !== "creators") return false;
  const expected = LEGACY_CREATOR_FIXTURE_TUPLES.get(normalizedMarker(row.id));
  if (!expected) return false;
  return normalizedMarker(row.name) === expected[0]
    && normalizedMarker(row.handle) === expected[1];
}

function isLegacyCandidateFixture(row: Record<string, unknown>, collection = ""): boolean {
  if (collection && normalizedCollection(collection) !== "candidate_pool") return false;
  const expected = LEGACY_CANDIDATE_FIXTURE_TUPLES.get(normalizedMarker(row.id));
  if (!expected) return false;
  return normalizedMarker(row.name) === expected[0]
    && normalizedMarker(row.handle) === expected[1]
    && normalizedMarker(row.channelRef) === expected[2];
}

type ExactLegacySignature = Readonly<Record<string, string | number | boolean>>;

const LEGACY_REVIEW_FIXTURES: readonly ExactLegacySignature[] = [
  { id: "r1", creatorId: "c4", submissionId: "s4", deliverable: "퍼즐 리뷰 영상 (4:32)", reasonCode: "missing_hashtag" },
  { id: "r2", creatorId: "c10", submissionId: "s5", deliverable: "Mid-core 플레이 영상 (8:10)", reasonCode: "approved" },
  { id: "r3", creatorId: "c6", submissionId: "s3", deliverable: "운영 영상 #2 (2:40)", reasonCode: "missing_link" },
];

const LEGACY_ESCALATION_FIXTURES: readonly ExactLegacySignature[] = [
  { id: "e1", creatorId: "c5", reason: "협의가 가이드 상한 초과", requestedKRW: 14_000_000, guideMaxKRW: 11_000_000 },
  { id: "e2", creatorId: "c9", reason: "제안가 상한 92% 근접", requestedKRW: 2_100_000, guideMaxKRW: 2_280_000 },
];

const LEGACY_CAMPAIGN_FIXTURES: readonly ExactLegacySignature[] = [
  { id: "cp1", name: "캐주얼 신작 글로벌 컨택", createdAtIso: "2026-06-15T00:00:00.000Z", counterSource: "syncCampaignFunnel" },
  { id: "cp2", name: "하이퍼캐주얼 UGC 대량", createdAtIso: "2026-06-12T00:00:00.000Z", counterSource: "syncCampaignFunnel" },
  { id: "cp3", name: "퍼즐 KR 마이크로", createdAtIso: "2026-06-18T00:00:00.000Z", counterSource: "syncCampaignFunnel" },
  { id: "cp4", name: "Mid-core 추천 배치", createdAtIso: "2026-06-10T00:00:00.000Z", counterSource: "syncCampaignFunnel" },
];

const LEGACY_SUBMISSION_FIXTURES: readonly ExactLegacySignature[] = [
  { id: "s1", creatorId: "c1", title: "신작 콜라보 티저", reviewReasonCode: "approved" },
  { id: "s2", creatorId: "c6", title: "신작 캐주얼 런 영상", reviewReasonCode: "approved" },
  { id: "s3", creatorId: "c6", title: "운영 영상 #2", reviewReasonCode: "missing_link" },
  { id: "s4", creatorId: "c4", title: "퍼즐 리뷰", reviewReasonCode: "missing_hashtag" },
  { id: "s5", creatorId: "c10", title: "Mid-core 플레이", reviewReasonCode: "approved" },
  { id: "s6", creatorId: "c10", title: "하이라이트 숏폼", reviewReasonCode: "approved" },
];

// A production QA regression harness briefly persisted programs with this exact
// machine-generated identity before fixture provenance was mandatory. Suppress
// only the complete immutable signature: a timestamp-suffixed QA id whose title
// is exactly the same value. Near matches and operator-renamed programs remain
// visible.
const LEGACY_PROD_QA_PROGRAM_ID = /^pg-prodqa-threadbreak-\d{10,}$/;

function isLegacyProdQaProgramFixture(row: Record<string, unknown>): boolean {
  const id = normalizedMarker(row.id);
  return LEGACY_PROD_QA_PROGRAM_ID.test(id) && normalizedMarker(row.title) === id;
}

// The AI-gateway persona harness writes creators with machine-generated ids under one reserved
// prefix, and the thread-break QA harness writes a timestamped creator alongside its QA program
// (production 2026-07-26: 19 persona rows + 1 thread-break row, all of them sitting in the managed
// creator list). Both prefixes are reserved by those harnesses — an operator-created creator never
// carries them — but keep the match anchored so a real id that merely contains "persona" survives.
const HARNESS_CREATOR_ID_PATTERNS: readonly RegExp[] = [
  /^creator-persona-[a-z0-9-]+$/,
  /^conv-prodqa-threadbreak-\d{10,}$/,
];

function isHarnessCreatorFixture(row: Record<string, unknown>): boolean {
  const id = normalizedMarker(row.id);
  return HARNESS_CREATOR_ID_PATTERNS.some((pattern) => pattern.test(id));
}

const LEGACY_CONVERSATION_MESSAGE_REFS = new Map<string, readonly [creatorId: string, unread: number, aiActive: boolean, firstRef: string, lastRef: string]>([
  ["v1", ["c1", 0, true, "msgref_v1_m1", "draftref_v1_m5"]],
  ["v2", ["c5", 2, false, "msgref_v2_m1", "gateref_v2_m3"]],
  ["v3", ["c3", 1, true, "draftref_v3_m1", "msgref_v3_m2"]],
  ["v4", ["c9", 0, true, "msgref_v4_m1", "gateref_v4_m3"]],
]);

function exactSignatureMatches(row: Record<string, unknown>, signature: ExactLegacySignature): boolean {
  return Object.entries(signature).every(([key, expected]) => typeof expected === "string"
    ? normalizedMarker(row[key]) === normalizedMarker(expected)
    : row[key] === expected);
}

function isLegacyConversationFixture(row: Record<string, unknown>): boolean {
  const expected = LEGACY_CONVERSATION_MESSAGE_REFS.get(normalizedMarker(row.id));
  if (!expected || normalizedMarker(row.creatorId) !== expected[0] || row.unread !== expected[1] || row.aiActive !== expected[2]) return false;
  const messages = Array.isArray(row.messages)
    ? row.messages.filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object" && !Array.isArray(message))
    : [];
  if (messages.length === 0) return true;
  if (messages.length < 2) return false;
  return normalizedMarker(messages[0].messageRef) === expected[3]
    && normalizedMarker(messages[messages.length - 1].messageRef) === expected[4];
}

function isCollectionAwareLegacyFixture(row: Record<string, unknown>, collection: string): boolean {
  switch (normalizedCollection(collection)) {
    case "creators":
      return isHarnessCreatorFixture(row);
    case "programs":
      return isLegacyProdQaProgramFixture(row);
    case "reviews":
      return LEGACY_REVIEW_FIXTURES.some((signature) => exactSignatureMatches(row, signature));
    case "escalations":
      return LEGACY_ESCALATION_FIXTURES.some((signature) => exactSignatureMatches(row, signature));
    case "campaigns":
      return LEGACY_CAMPAIGN_FIXTURES.some((signature) => exactSignatureMatches(row, signature));
    case "submissions":
      return LEGACY_SUBMISSION_FIXTURES.some((signature) => exactSignatureMatches(row, signature));
    case "conversations":
      return isLegacyConversationFixture(row);
    default:
      return false;
  }
}

export function isOperationalFixtureRecord(row: Record<string, unknown>, collection = ""): boolean {
  if (row.mock === true) return true;
  if (normalizedMarker(row.seedId) === DEMO_SEED_ID) return true;
  // `seedTag` 는 시드 스크립트만 붙이는 표식이다(운영 실측: scp_partner_activations/seed-0540-enrollment-1
  // 의 "flu-0540-pilot-seed-20260722"). 다만 같은 파일럿 시드가 7개 컬렉션에 태그를 남겨서, 스코프
  // 없이 판정하면 요청하지 않은 표면(scp_lifecycle_profiles 등)까지 조용히 사라진다 — 실제로 그랬다.
  // 그래서 이 표식은 시드 행을 숨기기로 합의된 컬렉션에서만 증거로 인정한다.
  if (normalizedMarker(row.seedTag) && SEED_TAG_SCOPED_COLLECTIONS.has(normalizedCollection(collection))) {
    return true;
  }
  if (KNOWN_OPERATIONAL_FIXTURE_SOURCES.has(normalizedMarker(row.source))) return true;
  if (KNOWN_OPERATIONAL_FIXTURE_SOURCES.has(normalizedMarker(row.discoverySource))) return true;
  if (KNOWN_OPERATIONAL_FIXTURE_GAME_IDS.has(normalizedMarker(row.gameId))) return true;
  if (KNOWN_OPERATIONAL_FIXTURE_ACTORS.has(normalizedMarker(row.createdBy))) return true;
  return isLegacyCreatorFixture(row, collection)
    || isLegacyCandidateFixture(row, collection)
    || (collection ? isCollectionAwareLegacyFixture(row, collection) : false);
}

export function isOperationalRecordVisible(
  row: Record<string, unknown>,
  collection = "",
  fixtureRowsVisible = false,
): boolean {
  return fixtureRowsVisible || !isOperationalFixtureRecord(row, collection);
}
