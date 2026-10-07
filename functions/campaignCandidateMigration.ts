// P0-1 [XP→Pororo 후보 이주] — 운영자 트리거형 캠페인 후보 이주 엔진.
//
// 목적: XP Hero 캠페인에서 이미 contacted 된 크리에이터(campaign_candidates, stage "contacted")
// 를 Pororo/Snake Clash 캠페인의 **후보 풀**에 `stage:"discovered"` 참여 문서로 복사한다.
// settings.automation.outreachDedupScope === "program" 이라 cross-program 재컨택은 발송 시점
// dedup 에서 이미 허용된다 — 이 엔진은 발송이 아니라 "후보 문서를 다른 프로그램 스코프에
// 적재" 하는 일만 한다.
//
// 하드 계약:
//   · 메일 발송/큐잉 0 — campaign_outreach·program_campaign_targets·conversations·
//     campaign_candidates 의 stage 전이 등 발송 경로 산출물은 절대 쓰지 않는다.
//   · Bouncer 절대 호출 금지 — 도달성은 mail_verification_judgments **캐시만** 읽는다
//     (readCachedMailDeliverabilityStatuses). 미판정 주소는 발송 시점 정격 검증이 그대로 받는다.
//   · 헤세 정책: 캐시 판정 "undeliverable" 만 제외. deliverable/risky/unknown/unjudged 포함.
//   · 억제: ACTIVE 인 **infly-overlap 이 아닌** 규칙만 제외(영구 불발송). infly-only 는
//     포함하되 리포트에서 따로 센다(allowInflyOverlap 플래그로 회복 가능한 계층).
//   · 멱등: 문서 id = campaignCandidateLinkId(program, campaign, candidateId) 라 재실행은
//     같은 문서에 merge 된다. 실행 내 이메일 dedup 은 첫 번째 행이 이긴다.
//   · 이미 진행된 타깃은 불가침: 타깃 문서가 이미 존재하고 이 이주와 무관한 경로(라이브
//     발송/회신 등)로 stage="discovered" 를 넘어 진행됐다면(isTargetAlreadyAdvanced) stage·
//     pipeline 필드를 절대 건드리지 않고 완전히 건너뛴다(skippedAlreadyAdvanced 로 집계).
//     2026-09-27 XP→Snake 프로드 사전점검(firebase-admin ADC 직접 조회, 읽기 전용)에서 발견 —
//     타깃(Snake Clash, cp-mu421htee9bn) campaign_candidates 11,897건 중 stage="contacted"
//     74건 + stage="discovered" 이지만 contactedAtIso 마커가 있는 5,081건(= 총 5,155건)이
//     이미 발송된 상태였다(참고: campaign_outreach 자체는 sent 6,191건 — campaign_candidates.
//     stage 는 캐시라 write-back 이 실패하는 경로가 있어 완전히 일치하진 않는다,
//     programOutreachDedup.ts recordProgramOutreachSend 의 T0-2 주석 참고). 이전엔
//     batch.set(merge:true) 가 무조건 stage 를 "discovered" 로 되돌려 재컨택/펀널 상태
//     오염 위험이 있었다.
//   · 재개 가능: ~11k+ 행처럼 한 호출의 내부 시간 예산(MIGRATION_TIME_BUDGET_MS, 540s 콜러블
//     타임아웃보다 여유를 둔다)을 넘길 수 있는 스캔은 documentId 오름차순 커서로 멈추고
//     `nextCursor` 를 돌려준다(rejudgeAiDramaCampaignCandidates 와 같은 house 패턴). 쓰기는
//     페이지(최대 SCAN_PAGE_SIZE 행) 단위로 즉시 커밋하므로, 이 호출이 이후 페이지에서 시간
//     예산/타임아웃에 걸려도 이미 커밋된 페이지의 이주 문서는 남는다 — 2026-09-27 프로드
//     실측: 전량 스캔 후 한 번에 쓰던 예전 방식은 504 시 진행분 전체가 유실됐다(0 migrated,
//     4 회 연속). 호출자는 `truncated:true` 인 동안 반환된 `nextCursor` 를 다음 호출의
//     `cursor` 로 그대로 왕복시켜 완주한다(스크립트 예: scratchpad/run-migrate-campaign-
//     candidates.mjs).
//
// provenance 결정: buildProgramScopedCandidateParticipationWrites 계약이
//   `sourceRunRef === discovery_runs/${sourceRunId}` 를 강제하므로, 실행 시 이주 런을
//   discovery_runs/{migrationRunId} provenance 문서로 쓴다. 이 문서가 repo 관례의
//   run/audit 레코드(mail_ingest_runs·sheet_sync_runs 등 최상위 ops 컬렉션) 역할을
//   겸한다 — 별도 감사 컬렉션을 만들지 않는다.
import { createHash, randomBytes } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import type { DocumentReference, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  buildProgramScopedCandidateParticipationWrites,
  candidateIdFromCandidate,
} from "./candidateScope";
import { evaluateProgramCampaignCandidateEligibility } from "./campaignControlCore";
import { cleanEmailCandidate, resolveProgramDiscoveryCriteria } from "./discovery";
import { eligibilityKeywordGateEnabled, validEmailField } from "./admin";
import {
  readCachedMailDeliverabilityStatuses,
  type MailDeliverabilityStatus,
} from "./mailDeliverabilityVerification";
import {
  INFLY_OVERLAP_RULE_ID,
  isActiveMailSuppressionDoc,
  normalizeSuppressionEmail,
} from "./mailSuppression";
import { resolveOutreachDedupScope } from "./programOutreachDedup";
import { resolveCanonicalProgramId } from "./programCanonical";
import { asRecord, asString, type CallableRequestShape } from "./shared";

// 실행 모드 게이트 — 이 이주(XP Hero → Pororo/Snake Clash) 전용 버전드 문구.
// 범용 문구보다 이주 1건에 묶인 문자열이 오발동 방지에 안전하고, 향후 다른 이주는 v2 를 쓴다.
export const CAMPAIGN_CANDIDATE_MIGRATION_CONFIRMATION = "migrate-xp-pororo-campaign-candidates-v1";

const CAMPAIGN_CANDIDATES_COLLECTION = "campaign_candidates";
const MAIL_SUPPRESSIONS_COLLECTION = "mail_suppressions";
const DISCOVERY_RUNS_COLLECTION = "discovery_runs";
const CAMPAIGNS_COLLECTION = "campaigns";
const PROGRAMS_COLLECTION = "programs";
const SETTINGS_DOC_PATH = "settings/default";

// admin.ts CAMPAIGN_CANDIDATE_FRESH_STAGE 와 동일 값 — 소비 경로(collectProgramCampaignTargets)
// 가 stage "discovered" + email > "" 만 읽으므로 이주 문서는 반드시 이 값이어야 한다.
const FRESH_STAGE = "discovered";
const MIGRATION_SOURCE = "campaign-candidate-migration";

// 이주가 소스 참여 문서에서 보존하는 **신원 필드 화이트리스트**. 소스 문서는 발송 경로가
// 스탬프한 상태(contactedAtIso·outreachRef·mailStatus·lastReplyAtIso·stage 이력 등)를
// 지닐 수 있는데, 그것은 소스 스코프의 이력이라 stage:"discovered" 인 타깃 문서에 싣지
// 않는다 — 소비 계약(campaignTargetFromCampaignCandidateDoc)·자격 평가
// (evaluateProgramCampaignCandidateEligibility)·발굴 provenance 가 읽는 필드만 옮긴다.
const MIGRATION_IDENTITY_FIELDS = [
  "name", "channelTitle", "handle", "email",
  "platform", "followers", "region", "country", "creatorCountry", "category",
  "publicDescription", "description", "bio",
  "matchedSearchTerms", "matchScore",
  "youtubeUrl", "channelUrl", "profileUrl",
  "avatar", "avatarUrl", "photoURL", "photoUrl", "picture", "imageUrl",
  "profileImageUrl", "profile_image_url", "thumbnailUrl", "thumbnail_url",
  "channelThumbnailUrl", "channel_thumbnail_url", "thumb",
  "channelId", "emailStatus", "engagementPct", "recentViews", "language",
  "discoverySource", "discoveryArm", "sourceFetchedAt", "discoveryProvenance",
] as const;
const DEFAULT_SOURCE_STAGES = ["contacted"] as const;
const SCAN_PAGE_SIZE = 500;
const WRITE_BATCH_LIMIT = 500; // Firestore batch hard cap
const SUPPRESSION_IN_CHUNK = 30; // Firestore `in` 연산 상한
const SUPPRESSION_QUERY_PARALLELISM = 8;
const DOC_READ_CHUNK = 300;
const MIGRATION_WRITE_ROLES = new Set(["super_admin", "admin"]);
// 2026-09-27 [XP→Snake 프로드 실측]: ~11k 소스 행을 단일 샷(no cursor)으로 처리하면 판정+억제
// 조인+배치 쓰기 총합이 540s 콜러블 타임아웃을 넘겨 504 로 끊기고, 쓰기가 전량 스캔 완료 후에야
// 한 번에 나갔으므로 진행분을 전혀 커밋하지 못한 채 0 migrated 로 4 회 연속 실패했다.
// rejudgeAiDramaCampaignCandidates(functions/aiDramaRelevance.ts)와 같은 처방: 내부 시간 예산
// 안에서 멈추고 재개 가능한 커서를 돌려준다 — 여유(120s)는 rejudge 의 60s 보다 넉넉하게 잡는다
// (이 경로가 페이지당 판정/억제 조인+배치 커밋까지 더 많은 Firestore 왕복을 하므로).
const MIGRATION_TIME_BUDGET_MS = 420_000;

export type CampaignCandidateMigrationInput = {
  sourceCampaignId: string;
  targetCampaignId: string;
  /** 기본 ["contacted"]. 소스 stage 화이트리스트(1~10개). */
  sourceStages?: string[];
  /** 기본 true. false + confirm 문구가 있어야 실제로 쓴다. */
  dryRun?: boolean;
  /** 쓰기 배치 크기(50~500). 기본 400. */
  batchSize?: number;
  /** 스캔 상한 — 부분 실행용. 미설정이면 전량(단, 내부 시간 예산 안에서). */
  limit?: number;
  /**
   * P0-1 [XP→Snake 후보 이주 · 2026-09-26]: 기본 false(기존 동작 100% 유지). true 면 이 실행 한 건의
   * 자격 판정에서만 키워드/카테고리 불일치를 통과시킨다 — 타깃 캠페인의
   * `targetingCriteria.eligibilityKeywordGate`(전역 스위치)는 건드리지 않으므로, 다른 발굴·이주
   * 실행의 키워드 타게팅은 무영향이다. 국가·exclude keyword·팔로워·suppression·도달성·전역 dedup 은
   * 이 플래그와 무관하게 그대로 전부 적용된다. 결과 문서에 candidate 단위로
   * `programScopeEvidence.keywordGateBypassed` 로 남아, 이후 라이브 리필의 같은 후보 재판정도
   * (그 후보에 한해서만) 키워드 게이트를 건너뛴다.
   */
  bypassKeywordGate?: boolean;
  /**
   * 2026-09-27 [커서 재개]: 이전 호출의 `nextCursor` 를 그대로 되돌려주면 그 지점부터 이어서
   * 스캔한다. 미설정/빈 문자열이면 처음부터. house convention(rejudgeAiDramaCampaignCandidates
   * 의 `afterCandidateId`)과 달리 이 이주는 여러 `sourceStages` 를 순회할 수 있어 opaque
   * JSON({stageIndex, afterDocId})으로 인코딩한다 — 호출자는 내용을 해석하지 말고 그대로
   * 왕복시켜야 한다.
   */
  cursor?: string;
};

export type CampaignCandidateMigrationActor = { uid: string; role: string };

export type CampaignCandidateMigrationDeps = {
  db?: FirebaseFirestore.Firestore;
  now?: () => Date;
  /**
   * 내부 시간 예산 체크 전용 시계(밀리초) — `now`(영속 타임스탬프용, Date 반환)와 분리해 뒀다:
   * 테스트가 시간 예산 초과를 시뮬레이션할 때 이걸 조작해도 기록되는 ISO 타임스탬프는 안
   * 흔들린다. 미설정이면 `now().getTime()`.
   */
  nowMs?: () => number;
  /** 테스트 전용: SCAN_PAGE_SIZE(500) 대신 쓸 페이지 크기. 프로드 경로에선 절대 안 쓴다 — 한
   * 호출 안에서 여러 페이지를 도는 동작(페이지별 즉시 커밋, 이후 페이지 실패 시 이전 페이지
   * 보존)을 500 행짜리 fixture 없이 작은 데이터로 재현하기 위한 것. */
  pageSizeOverride?: number;
};

type SuppressionClass = "clean" | "infly_only" | "other" | "both";

type PendingRow = {
  docId: string;
  refPath: string;
  stage: string;
  candidateId: string;
  email: string; // 정규화된 유효 이메일
  data: Record<string, unknown>;
};

type PlannedParticipationWrite = {
  candidateId: string;
  email: string;
  docId: string;
  ref: DocumentReference;
  data: Record<string, unknown>;
};

export type CampaignCandidateMigrationReport = {
  ok: true;
  dryRun: boolean;
  migrationRunId: string | null;
  runRef: string | null;
  sourceCampaignId: string;
  sourceStages: string[];
  targetCampaignId: string;
  sourceCanonicalProgramId: string;
  targetCanonicalProgramId: string;
  scannedRows: number;
  withEmail: number;
  uniqueEmails: number;
  skippedNoCandidateId: number;
  skippedNoEmail: number;
  duplicateEmailsInRun: number;
  judgmentDist: Record<string, number>;
  suppressionDist: Record<string, number>;
  eligibilityDist: Record<string, number>;
  /** P0-1: of eligibilityDist's "eligible" bucket, how many only passed because bypassKeywordGate
   * was set (would otherwise have been keyword_mismatch/category_mismatch). 0 when bypassKeywordGate
   * is false. */
  keywordGateBypassedCount: number;
  skippedUndeliverable: number;
  skippedSuppressedOther: number;
  alreadyExistingTargetDocs: number;
  /** 2026-09-27 [XP→Snake 프로드 사전점검 수리]: alreadyExistingTargetDocs 중, 타깃 문서가 이미
   * 이 이주와 무관한 경로(발송/회신 등)로 stage="discovered" 를 넘어 진행돼(또는 발송 마커를
   * 지녀) 이 실행이 stage/pipeline 필드를 건드리지 않고 완전히 건너뛴 건수. 아래
   * `isTargetAlreadyAdvanced` 참고. */
  skippedAlreadyAdvanced: number;
  wouldMigrate: number;
  written: number;
  createdDocs: number;
  mergedDocs: number;
  /** true when this call stopped before exhausting the matching source rows — either `limit` was
   * hit or the internal time budget was — and `nextCursor` is set to resume. */
  truncated: boolean;
  /** Pass back as `cursor` to continue past this call's stopping point when `truncated` is true. */
  nextCursor: string | null;
  excludedSampleRefs: string[];
};

function migrationError(code: string, message: string, errorCode?: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code, ...(errorCode ? { errorCode } : {}) });
}

function text(value: unknown, max = 180): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function canonicalMigrationEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  // Migration source emails come from discovery-populated campaign candidates. Apply the
  // same canonical cleanup before judgment/suppression/dedup/write so known bullet-residue
  // pollution like `-radha@...` shares the global email-intelligence key with `radha@...`.
  return validEmailField(cleanEmailCandidate(value));
}

/** adversarial review (2026-09-27 round 3): pre-existing bug found while reviewing this file for
 * an unrelated reason — `text(value, 120)` silently TRUNCATES an overlong id to 120 chars before
 * validating, so a 121+-char input could pass the regex as a truncated 120-char prefix and
 * silently address a completely different (real) campaign with this bulk-write migration. Reject
 * overlong input instead of truncating it — never accept a truncated id as "exact". */
function exactId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length > 120) {
    throw migrationError("invalid-argument", `${field} must be an exact document id`, `campaign_candidate_migration_${field}_invalid`);
  }
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) {
    throw migrationError("invalid-argument", `${field} must be an exact document id`, `campaign_candidate_migration_${field}_invalid`);
  }
  return id;
}

function boundedInteger(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw migrationError("invalid-argument", `${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function actorHash(uid: string): string {
  // sha256(uid).slice(0,24) — campaignControl.ts actorHash 와 같은 관례.
  return createHash("sha256").update(uid).digest("hex").slice(0, 24);
}

type MigrationCursorState = { stageIndex: number; afterDocId: string };

// 커서 JSON 상한 — Firestore 문서 id 는 최대 1,500 바이트(UTF-8)라 afterDocId 하나만으로도
// 커질 수 있고, JSON.stringify 의 이스케이프(`"`→`\"`, 제어문자→`\u00XX` 최대 6배)까지 겹치면
// 순수 텍스트 상한보다 훨씬 커질 수 있다(adversarial review 2026-09-27: round 2 는 500자 상한이
// 평범한 긴 id 도 못 왕복시킨다는 걸, round 3 는 2000자 상한도 이스케이프가 많은(예: 따옴표
// 위주) 1,200바이트짜리 유효한 id 앞에서 여전히 부족하다는 걸 각각 재현했다). 최악의 경우
// (문서 id 1,500바이트 전부가 6배로 불어나는 제어문자) 를 그대로 계산해 넉넉히 잡는다:
// 1,500 × 6 ≈ 9,000 + JSON 골격(stageIndex/afterDocId/scanKey 키+따옴표+콤마) 여유.
const CURSOR_MAX_CHARS = 12_000;

/**
 * 커서를 이 커서가 만들어진 "스캔 모양"(소스/타깃 캠페인 + 정확히 그 순서의 sourceStages +
 * dryRun 여부 + bypassKeywordGate)에 묶는 지문. 커서 자체는 opaque 라 호출자가 sourceStages 를
 * 바꾸거나(순서 변경 포함) 다른 캠페인 쌍에 재사용해 재개하면, stageIndex 가 가리키는 stage 가
 * 원래와 달라져 행을 건너뛰거나 중복 처리할 수 있다. dryRun 도 지문에 묶는다 — round 2
 * adversarial review 재현: dryRun 스캔이 돌려준 커서를 execute 호출에 재사용하면, dryRun 은
 * 아무것도 안 쓰므로 "이미 본 행"이 실제로는 "아직 안 옮겨진 행"인데도 그 행을 건너뛰고 이어서
 * 스캔해 조용히 누락된다. bypassKeywordGate 도 지문에 묶는다 — round 3 adversarial review 재현:
 * 이 값을 바꿔 재개하면 같은 재개 안에서도 앞 페이지는 옛 정책(예: human_gate)으로, 뒷 페이지는
 * 새 정책(예: pass)으로 평가돼 자격 판정이 갈라진다. 지문이 안 맞으면 거절한다.
 */
function migrationScanKey(
  sourceCampaignId: string,
  targetCampaignId: string,
  sourceStages: readonly string[],
  dryRun: boolean,
  bypassKeywordGate: boolean,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ sourceCampaignId, targetCampaignId, sourceStages, dryRun, bypassKeywordGate }))
    .digest("hex")
    .slice(0, 16);
}

/** opaque 커서 디코드 — 빈 문자열은 "처음부터"(null). 형식이 망가진 비-빈 문자열(필드 누락/타입
 * 불일치)이나 `expectedScanKey` 와 안 맞는 커서는 거절한다: 조용히 처음부터 다시 돌거나 엉뚱한
 * stage 를 이어 읽거나 dryRun/execute 사이에서 행이 새면 대량 재작업/누락(중복 판정·쓰기 비용,
 * 소리 없는 행 누락)이 나므로 실패를 명확히 알린다. */
function decodeMigrationCursor(raw: string, expectedScanKey: string): MigrationCursorState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw migrationError("invalid-argument", "cursor is malformed", "campaign_candidate_migration_cursor_invalid");
  }
  const record = asRecord(parsed);
  const stageIndex = record.stageIndex;
  if (typeof stageIndex !== "number" || !Number.isInteger(stageIndex) || stageIndex < 0) {
    throw migrationError("invalid-argument", "cursor is malformed", "campaign_candidate_migration_cursor_invalid");
  }
  if (typeof record.afterDocId !== "string") {
    throw migrationError("invalid-argument", "cursor is malformed", "campaign_candidate_migration_cursor_invalid");
  }
  if (record.scanKey !== expectedScanKey) {
    throw migrationError(
      "invalid-argument",
      "cursor does not match sourceCampaignId/targetCampaignId/sourceStages/dryRun of this call",
      "campaign_candidate_migration_cursor_scan_mismatch",
    );
  }
  return { stageIndex, afterDocId: record.afterDocId };
}

function encodeMigrationCursor(stageIndex: number, afterDocId: string, scanKey: string): string {
  return JSON.stringify({ stageIndex, afterDocId, scanKey });
}

/** cursor 입력 파싱 — `text()` 와 달리 **자르지 않는다**: 우리가 만든 nextCursor 를 조용히
 * 잘라내면 그 자체 왕복이 깨진다(위 CURSOR_MAX_CHARS 주석). 문자열이 아니거나 상한을 넘으면
 * 거절한다 — round 2 adversarial review: `cursor:123` 같은 비-문자열 최상위 값도 예전엔
 * `text()` 가 조용히 ""(처음부터) 로 접었다. */
function boundedCursorText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw migrationError("invalid-argument", "cursor must be a string", "campaign_candidate_migration_cursor_invalid");
  }
  const trimmed = value.trim();
  if (trimmed.length > CURSOR_MAX_CHARS) {
    throw migrationError("invalid-argument", "cursor is too long", "campaign_candidate_migration_cursor_invalid");
  }
  return trimmed;
}

export function parseCampaignCandidateMigrationInput(value: unknown): Required<CampaignCandidateMigrationInput> {
  const data = asRecord(value);
  const sourceCampaignId = exactId(data.sourceCampaignId, "sourceCampaignId");
  const targetCampaignId = exactId(data.targetCampaignId, "targetCampaignId");
  if (sourceCampaignId === targetCampaignId) {
    throw migrationError("invalid-argument", "sourceCampaignId and targetCampaignId must differ", "campaign_candidate_migration_same_campaign");
  }
  let sourceStages: string[] = [...DEFAULT_SOURCE_STAGES];
  if (data.sourceStages !== undefined) {
    if (!Array.isArray(data.sourceStages) || data.sourceStages.length < 1 || data.sourceStages.length > 10) {
      throw migrationError("invalid-argument", "sourceStages must contain 1-10 stage values");
    }
    sourceStages = Array.from(new Set(data.sourceStages.map((stage) => {
      const normalized = text(stage, 40).toLowerCase();
      if (!/^[a-z0-9_-]{1,40}$/.test(normalized)) {
        throw migrationError("invalid-argument", "sourceStages entries must be stage identifiers", "campaign_candidate_migration_source_stage_invalid");
      }
      return normalized;
    })));
  }
  // limit: 0/미설정 = 전량 스캔. 0 을 허용해야 정규화된 입력의 재파싱(execute 경로)이 안전하다.
  const limit = data.limit === undefined || data.limit === null
    ? 0
    : boundedInteger(data.limit, "limit", 0, 0, 100_000);
  if (data.bypassKeywordGate !== undefined && typeof data.bypassKeywordGate !== "boolean") {
    throw migrationError("invalid-argument", "bypassKeywordGate must be boolean", "campaign_candidate_migration_bypass_keyword_gate_invalid");
  }
  const dryRun = data.dryRun !== false;
  const bypassKeywordGate = data.bypassKeywordGate === true;
  const cursor = boundedCursorText(data.cursor);
  if (cursor) {
    const decoded = decodeMigrationCursor(
      cursor,
      migrationScanKey(sourceCampaignId, targetCampaignId, sourceStages, dryRun, bypassKeywordGate),
    );
    if (decoded && decoded.stageIndex >= sourceStages.length) {
      throw migrationError("invalid-argument", "cursor is out of range for sourceStages", "campaign_candidate_migration_cursor_invalid");
    }
  }
  return {
    sourceCampaignId,
    targetCampaignId,
    sourceStages,
    dryRun,
    batchSize: boundedInteger(data.batchSize, "batchSize", 400, 50, WRITE_BATCH_LIMIT),
    limit,
    bypassKeywordGate,
    cursor,
  };
}

function campaignCanonicalProgramId(campaign: Record<string, unknown>): string {
  return resolveCanonicalProgramId(campaign.canonicalProgramId)
    || resolveCanonicalProgramId(campaign.programId);
}

function stringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, maxItems);
}

function countryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const countries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const code = item.trim().toUpperCase().slice(0, 4);
    if (code && !countries.includes(code)) countries.push(code);
  }
  return countries.slice(0, 30);
}

/** db.getAll 을 chunk 로 나눠 **병렬** 호출한다(mailDeliverabilityVerification.ts 의
 * readCachedMailDeliverabilityStatuses 와 같은 기법) — 청크 간 의존이 없는 순수 배치 읽기라
 * 순차보다 지연시간을 줄인다. 구조적 fake 이 getAll 을 안 주면 ref.get 폴백. */
async function getAllDocs(
  db: FirebaseFirestore.Firestore,
  refs: DocumentReference[],
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  if (refs.length === 0) return [];
  const chunks: DocumentReference[][] = [];
  for (let offset = 0; offset < refs.length; offset += DOC_READ_CHUNK) {
    chunks.push(refs.slice(offset, offset + DOC_READ_CHUNK));
  }
  const chunkResults = await Promise.all(chunks.map((chunk) => (
    typeof db.getAll === "function"
      ? db.getAll(...chunk)
      : Promise.all(chunk.map((ref) => ref.get()))
  )));
  return chunkResults.flat();
}

/**
 * 억제 조인 — 이메일 축만(프로드 실측 조인과 같은 축). 문서 id 와 무관하게 `email` 필드로
 * `in` 배치 조회 후, status·ruleId 는 로컬 판정(정본 isActiveMailSuppressionDoc).
 * 비용: 이메일 30건당 쿼리 1회.
 */
async function classifySuppressionsByEmail(
  db: FirebaseFirestore.Firestore,
  emails: readonly string[],
): Promise<Map<string, SuppressionClass>> {
  const classes = new Map<string, SuppressionClass>();
  for (const email of emails) classes.set(email, "clean");
  const uniqueEmails = Array.from(new Set(emails.map((email) => normalizeSuppressionEmail(email)).filter(Boolean)));
  const chunks: string[][] = [];
  for (let offset = 0; offset < uniqueEmails.length; offset += SUPPRESSION_IN_CHUNK) {
    chunks.push(uniqueEmails.slice(offset, offset + SUPPRESSION_IN_CHUNK));
  }
  for (let offset = 0; offset < chunks.length; offset += SUPPRESSION_QUERY_PARALLELISM) {
    const group = chunks.slice(offset, offset + SUPPRESSION_QUERY_PARALLELISM);
    const snapshots = await Promise.all(group.map((chunk) =>
      db.collection(MAIL_SUPPRESSIONS_COLLECTION).where("email", "in", chunk).get()));
    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        const data = doc.data() ?? {};
        const email = normalizeSuppressionEmail(data.email);
        if (!email || !classes.has(email) || !isActiveMailSuppressionDoc(data)) continue;
        const ruleId = asString(data.ruleId, "mail-safety.suppressed-contact");
        const current = classes.get(email) ?? "clean";
        if (ruleId === INFLY_OVERLAP_RULE_ID) {
          classes.set(email, current === "other" || current === "both" ? "both" : "infly_only");
        } else {
          classes.set(email, current === "infly_only" || current === "both" ? "both" : "other");
        }
      }
    }
  }
  return classes;
}

// 2026-09-27 [XP→Snake 프로드 사전점검 수리]: recordProgramOutreachSend(programOutreachDedup.ts)
// 가 발송 시 campaign_candidates 문서에 실제로 스탬프하는 필드 — stage 가 어떤 이유로든(예:
// admin.ts:271~283 주석의 pre-122차 드리프트류) "discovered" 로 남아 있어도 이 필드들 중 하나가
// 비어있지 않으면 이미 발송/회신이 있었다는 뜻이라 stage 판정만으로는 못 잡는 진행 신호를 잡는다.
const TARGET_ADVANCEMENT_MARKER_FIELDS = [
  "contactedAtIso", "outreachRef", "mailStatus", "lastReplyAtIso", "sendCount",
] as const;

/**
 * 타깃 문서가 이미 **이 이주와 무관한 경로**(타깃 캠페인 자체의 라이브 발송/회신/파트너 전환
 * 등)로 stage="discovered" 를 넘어 진행됐는지 판정한다.
 *
 * 왜: 2026-09-27 XP→Snake 프로드 사전점검(firebase-admin ADC 직접 조회, 읽기 전용) — 소스
 * (campaign_candidates, XP Hero, stage=contacted) 11,007건, 타깃(Snake Clash, cp-mu421htee9bn)
 * campaign_candidates 11,897건 중 stage="contacted" 74건 + stage="discovered" 이지만
 * contactedAtIso 마커가 있는 5,081건(= 총 5,155건)이 이미 발송된 상태였다(campaign_outreach
 * 자체는 sent 6,191건 — stage 필드는 캐시라 완전히 일치하진 않는다, 아래 주석·
 * programOutreachDedup.ts T0-2 참고). 예전 동작은 `batch.set(..., {merge:true})` 로
 * participationData 전체(stage 포함)를 무조건 덮어써, 이미 contacted 인 타깃을 다시
 * "discovered" 로 되돌리고 재컨택/펀널 상태 오염 위험을 만들었다(아래 processCandidatePage
 * 호출부의 "⚠️ 알려진 한계" 주석이 이 문제를 문서화했었다 — 이 수리로 그 한계를 없앤다).
 *
 * stage 값 자체(FRESH_STAGE 아닌 값)가 1차 신호다. 방어적으로 TARGET_ADVANCEMENT_MARKER_FIELDS
 * 도 함께 본다 — stage 가 "discovered" 로 남아 있어도 발송 마커가 있으면 진행된 것으로 취급한다.
 * 빈 문자열/0/누락은 "아직 진행 안 됨"(false)으로 본다 — 기존 동작(새 문서 취급)과 동일.
 *
 * ⚠️ 이 판정은 **읽은 시점의 스냅샷**으로만 내려진다 — 이 판정과 실제 배치 커밋 사이(같은
 * 페이지 안, I/O 한 왕복) 라이브 발송/회신이 바로 그 문서를 전진시키면 판정은 낡아 있을 수
 * 있다(TOCTOU). 그래서 이 함수의 결과만으로 "stage 를 덮어써도 안전하다"고 결론 내리면 안
 * 된다 — 실제 안전장치는 호출부(아래 배치 write 루프)가 **이미 존재하던 문서에는 애초에
 * stage 필드를 페이로드에 담지 않는 것**이다(merge:true 는 페이로드에 없는 필드를 건드리지
 * 않는다). 이 함수는 그 구조적 안전장치와 별개로 "완전히 건드리지 않을지"(identity/provenance
 * 갱신조차 생략할지)와 skippedAlreadyAdvanced 집계만 결정한다 — adversarial review 2026-09-27
 * round 1 이 fake-firestore 인터리빙으로 이 판정만으로는 불충분함을 재현했다.
 */
function isTargetAlreadyAdvanced(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  const stage = text(data.stage, 40).toLowerCase();
  if (stage && stage !== FRESH_STAGE) return true;
  for (const field of TARGET_ADVANCEMENT_MARKER_FIELDS) {
    const value = data[field];
    if (typeof value === "string" && value.trim()) return true;
    if (typeof value === "number" && value > 0) return true;
  }
  return false;
}

/** 소스 한 페이지 조회 — documentId 오름차순, 결정적(house pagination convention —
 * rejudgeAiDramaCampaignCandidates/candidateScopeRepair.ts 와 같은 정렬축). `afterDocId` 는
 * 이 stage 안에서만 유효하다(등호 술어라 복합 인덱스 불필요). */
async function fetchSourceRowsPage(
  db: FirebaseFirestore.Firestore,
  sourceCampaignId: string,
  stage: string,
  afterDocId: string | null,
  pageSize: number,
): Promise<QueryDocumentSnapshot[]> {
  let query = db.collection(CAMPAIGN_CANDIDATES_COLLECTION)
    .where("campaignId", "==", sourceCampaignId)
    .where("stage", "==", stage)
    .orderBy(FieldPath.documentId())
    .limit(pageSize);
  if (afterDocId) query = query.startAfter(afterDocId);
  const snapshot = await query.get();
  return snapshot.docs;
}

type CandidatePageContext = {
  db: FirebaseFirestore.Firestore;
  now: () => Date;
  migratedAtIso: string;
  runId: string;
  targetCanonicalProgramId: string;
  sourceCanonicalProgramId: string;
  targetCampaignId: string;
  sourceCampaignId: string;
  eligibilityCriteria: {
    keywords: string[];
    excludeKeywords: string[];
    regions: string[];
    categories: string[];
    minFollowers: number;
    maxFollowers: number;
  };
  crossProgramCandidatesAllowed: boolean;
  bypassKeywordGate: boolean;
  actorEvidence: Record<string, unknown>;
};

type CandidatePageResult = {
  withEmail: number;
  uniqueEmails: number;
  skippedNoCandidateId: number;
  skippedNoEmail: number;
  duplicateEmailsInRun: number;
  judgmentDist: Record<string, number>;
  skippedUndeliverable: number;
  suppressionDist: Record<string, number>;
  skippedSuppressedOther: number;
  excludedSampleRefs: string[];
  eligibilityDist: Record<string, number>;
  keywordGateBypassedCount: number;
  planned: PlannedParticipationWrite[];
};

/**
 * 페이지 한 개(최대 SCAN_PAGE_SIZE 행) 처리 — 신원·이메일 게이트, 도달성 게이트, 억제 게이트,
 * 자격 평가 + 쓰기 계획까지(원래 runCampaignCandidateMigration 의 ①~⑤ 단계와 동일 로직, 페이지
 * 단위로 스코프만 좁혔다). `seenEmails` 는 이 **콜러블 호출 전체**(여러 페이지)에 걸쳐 공유되는
 * Set 이라 한 호출 안에서는 여전히 전역 이메일 dedup(첫 행 승리)이다. 커서로 재개된 **다른**
 * 콜러블 호출에 걸친 dedup 은 하지 않는다 — 알려진 한계: 서로 다른 candidateId 가 같은 이메일을
 * 쓰는 드문 경우, 재개된 이후 호출은 그 이메일을 이미 봤다는 걸 모른다. 타깃 문서 id 는
 * candidateId 로 결정되므로(이메일이 아니라) 중복 이주 문서가 생기지는 않는다 — 최악의 경우
 * 같은 이메일을 가리키는 서로 다른 타깃 문서 두 개가 생길 뿐이다.
 */
async function processCandidatePage(
  docs: readonly QueryDocumentSnapshot[],
  seenEmails: Set<string>,
  ctx: CandidatePageContext,
): Promise<CandidatePageResult> {
  // ① 신원·이메일 게이트 + ② 실행 내 이메일 dedup(첫 번째 행이 이긴다).
  const pending: PendingRow[] = [];
  let skippedNoCandidateId = 0;
  let skippedNoEmail = 0;
  let duplicateEmailsInRun = 0;
  for (const doc of docs) {
    const data = asRecord(doc.data());
    // campaign_candidates 문서의 `id` 필드는 링크 문서 id(ccl_*)라 후보 신원이 아니다 —
    // 신원은 candidateId 필드, 폴백은 candidateRef(candidate_pool/<id>)뿐이다.
    const candidateId = candidateIdFromCandidate({
      candidateId: data.candidateId,
      candidateRef: data.candidateRef,
    });
    if (!candidateId) {
      skippedNoCandidateId += 1;
      continue;
    }
    const email = canonicalMigrationEmail(data.email);
    if (!email) {
      skippedNoEmail += 1;
      continue;
    }
    if (seenEmails.has(email)) {
      duplicateEmailsInRun += 1;
      continue;
    }
    seenEmails.add(email);
    pending.push({
      docId: doc.id,
      refPath: doc.ref.path,
      stage: text(data.stage, 40).toLowerCase(),
      candidateId,
      email,
      data,
    });
  }

  // ③ 도달성 게이트 — 캐시 판정만(Bouncer 호출 없음). undeliverable 만 제외.
  const judgments = await readCachedMailDeliverabilityStatuses(pending.map((row) => row.email), { db: ctx.db, now: ctx.now });
  const judgmentDist: Record<string, number> = {
    deliverable: 0, risky: 0, unknown: 0, undeliverable: 0, unjudged: 0,
  };
  const judgmentByEmail = new Map<string, MailDeliverabilityStatus | null>();
  let skippedUndeliverable = 0;
  const judgmentSurvivors: PendingRow[] = [];
  for (const row of pending) {
    const status = judgments.get(row.email) ?? null;
    judgmentByEmail.set(row.email, status);
    judgmentDist[status ?? "unjudged"] += 1;
    if (status === "undeliverable") {
      skippedUndeliverable += 1;
      continue;
    }
    judgmentSurvivors.push(row);
  }

  // ④ 억제 게이트 — ACTIVE 비-infly 규칙만 제외. infly-only 는 포함하되 분리 집계.
  const suppressionByEmail = await classifySuppressionsByEmail(ctx.db, judgmentSurvivors.map((row) => row.email));
  const suppressionDist: Record<string, number> = { clean: 0, infly_only: 0, other: 0, both: 0 };
  let skippedSuppressedOther = 0;
  const migratable: PendingRow[] = [];
  const excludedSampleRefs: string[] = [];
  for (const row of judgmentSurvivors) {
    const cls = suppressionByEmail.get(row.email) ?? "clean";
    suppressionDist[cls] += 1;
    if (cls === "other" || cls === "both") {
      skippedSuppressedOther += 1;
      if (excludedSampleRefs.length < 20) excludedSampleRefs.push(`${row.refPath}#${cls}`);
      continue;
    }
    migratable.push(row);
  }

  // ⑤ 자격 증거 + 쓰기 계획. candidate 의 스코프 클레임을 **타깃 프로그램**으로 놓고
  // 평가한다 — 이주가 곧 재스코핑 행위라 claimedScopes=[target] → scoped_candidate_provenance.
  const eligibilityDist: Record<string, number> = {};
  let keywordGateBypassedCount = 0;
  const planned: PlannedParticipationWrite[] = [];
  for (const row of migratable) {
    // 신원 필드만 옮긴다 — row.data 통째 스프레드는 소스 스코프의 발송 경로 상태
    // (contactedAtIso·outreachRef·mailStatus 등)를 타깃 문서로 새게 한다(위 화이트리스트 주석).
    const identity: Record<string, unknown> = {};
    for (const field of MIGRATION_IDENTITY_FIELDS) {
      const value = row.data[field];
      if (value !== undefined) identity[field] = value;
    }
    const candidate = {
      ...identity,
      id: row.candidateId,
      candidateId: row.candidateId,
      candidateRef: `candidate_pool/${row.candidateId}`,
      email: row.email,
      canonicalProgramId: ctx.targetCanonicalProgramId,
      programId: ctx.targetCanonicalProgramId,
      programRef: `programs/${ctx.targetCanonicalProgramId}`,
      campaignId: ctx.targetCampaignId,
      campaignRef: `campaigns/${ctx.targetCampaignId}`,
      sourceCampaignId: ctx.sourceCampaignId,
      stage: FRESH_STAGE,
    };
    const evaluation = evaluateProgramCampaignCandidateEligibility({
      programId: ctx.targetCanonicalProgramId,
      candidate,
      criteria: ctx.eligibilityCriteria,
      crossProgramCandidatesAllowed: ctx.crossProgramCandidatesAllowed,
      keywordGateBypass: ctx.bypassKeywordGate,
    });
    eligibilityDist[evaluation.eligible ? "eligible" : evaluation.reason] = (eligibilityDist[evaluation.eligible ? "eligible" : evaluation.reason] ?? 0) + 1;
    if (evaluation.keywordGateBypassed) keywordGateBypassedCount += 1;
    const deliverabilityStatus = judgmentByEmail.get(row.email) ?? "unjudged";
    const suppressionClass = suppressionByEmail.get(row.email) ?? "clean";
    const plan = buildProgramScopedCandidateParticipationWrites({
      candidate: { ...candidate, criteriaHash: evaluation.criteriaHash },
      canonicalProgramId: ctx.targetCanonicalProgramId,
      campaignId: ctx.targetCampaignId,
      sourceRunId: ctx.runId,
      sourceRunRef: `${DISCOVERY_RUNS_COLLECTION}/${ctx.runId}`,
      stage: FRESH_STAGE,
      // 저장 계약(verdict+reasonCodes)은 유지하고 평가 결과를 evaluation 필드에 싣는다 —
      // creatorPromotion 등의 verdict 소비자가 깨지지 않는다.
      eligibility: {
        verdict: evaluation.eligible ? "pass" : "human_gate",
        reasonCodes: evaluation.eligible
          ? ["migration_precheck_pass"]
          : ["program_eligibility_pending", `precheck_${evaluation.reason}`],
        evaluation: {
          eligible: evaluation.eligible,
          reason: evaluation.reason,
          canonicalProgramId: evaluation.canonicalProgramId,
          evidenceMode: evaluation.evidenceMode,
          criteriaHash: evaluation.criteriaHash,
        },
        evaluatedAtIso: ctx.migratedAtIso,
      },
      programScopeEvidence: {
        kind: MIGRATION_SOURCE,
        migratedFromProgramId: ctx.sourceCanonicalProgramId || undefined,
        migratedFromCampaignId: ctx.sourceCampaignId,
        migrationRunId: ctx.runId,
        sourceCampaignCandidateRef: row.refPath,
        deliverabilityStatus,
        suppressionClass,
        eligibilityEvaluation: {
          eligible: evaluation.eligible,
          reason: evaluation.reason,
          evidenceMode: evaluation.evidenceMode,
          criteriaHash: evaluation.criteriaHash,
        },
        // P0-1: read directly by admin.ts's campaign_candidates/program_campaign_targets target
        // mappers so the live refill's fresh eligibility re-evaluation (and the independent
        // targetMatchesCampaignIncludes gate) skip the keyword/category check for *this candidate
        // only* — never for the campaign's organic/live discovery keyword targeting.
        // ⚠️ Known limitation (adversarial review 2026-09-26): once this candidate is promoted to
        // program_campaign_targets, that document's id is program-scoped, not campaign-scoped
        // (admin.ts programTargetDocId), so a *sibling* campaign in the *same* program would also
        // read this marker under its own keyword criteria. Verified inert for this migration
        // (pg-snake-clash-creator-program has exactly one campaign at write time) — a real fix
        // would need campaignId threaded through the two target mappers. Revisit before reusing
        // bypassKeywordGate on a multi-campaign program.
        keywordGateBypassed: evaluation.keywordGateBypassed,
        candidateCriteriaSnapshot: ctx.eligibilityCriteria,
      },
      candidateProvenance: {
        kind: MIGRATION_SOURCE,
        sourceCampaignId: ctx.sourceCampaignId,
        sourceCampaignRef: `${CAMPAIGNS_COLLECTION}/${ctx.sourceCampaignId}`,
        sourceCanonicalProgramId: ctx.sourceCanonicalProgramId || undefined,
        sourceStage: row.stage || undefined,
        sourceCampaignCandidateRef: row.refPath,
        migrationRunId: ctx.runId,
        migratedAtIso: ctx.migratedAtIso,
        ...ctx.actorEvidence,
      },
    });
    planned.push({
      candidateId: row.candidateId,
      email: row.email,
      docId: plan.participationRef.slice(`${CAMPAIGN_CANDIDATES_COLLECTION}/`.length),
      ref: ctx.db.collection(CAMPAIGN_CANDIDATES_COLLECTION)
        .doc(plan.participationRef.slice(`${CAMPAIGN_CANDIDATES_COLLECTION}/`.length)),
      data: plan.participationData,
    });
  }

  return {
    withEmail: pending.length + duplicateEmailsInRun,
    uniqueEmails: pending.length,
    skippedNoCandidateId,
    skippedNoEmail,
    duplicateEmailsInRun,
    judgmentDist,
    skippedUndeliverable,
    suppressionDist,
    skippedSuppressedOther,
    excludedSampleRefs,
    eligibilityDist,
    keywordGateBypassedCount,
    planned,
  };
}

/**
 * 이주 코어 — 콜러블·테스트가 공유하는 실행 경로. db 주입으로 노드 레인 가짜를 받는다.
 * dryRun 은 **쓰기 0** 을 보장한다(run 문서조차 쓰지 않는다). 내부적으로 documentId 커서
 * 페이지네이션(최대 SCAN_PAGE_SIZE 행/페이지)으로 돌며, 시간 예산(MIGRATION_TIME_BUDGET_MS)이나
 * `limit` 을 넘기면 멈추고 `truncated:true` + `nextCursor` 를 돌려준다 — 모듈 상단 주석 참고.
 */
export async function runCampaignCandidateMigration(
  rawInput: CampaignCandidateMigrationInput,
  actor: CampaignCandidateMigrationActor | null = null,
  deps: CampaignCandidateMigrationDeps = {},
): Promise<CampaignCandidateMigrationReport> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? (() => new Date());
  const nowMs = deps.nowMs ?? (() => now().getTime());
  const input = parseCampaignCandidateMigrationInput(rawInput);
  const scanKey = migrationScanKey(
    input.sourceCampaignId, input.targetCampaignId, input.sourceStages, input.dryRun, input.bypassKeywordGate,
  );
  const cursorState = decodeMigrationCursor(input.cursor, scanKey);
  const startedAtIso = now().toISOString();
  const runId = `cmig_${now().getTime().toString(36)}_${randomBytes(4).toString("hex")}`;
  const migratedAtIso = now().toISOString();

  const [sourceCampaignSnap, targetCampaignSnap, settingsSnap] = await getAllDocs(db, [
    db.collection(CAMPAIGNS_COLLECTION).doc(input.sourceCampaignId),
    db.collection(CAMPAIGNS_COLLECTION).doc(input.targetCampaignId),
    db.doc(SETTINGS_DOC_PATH),
  ]);
  if (!targetCampaignSnap?.exists) {
    throw migrationError("not-found", "target campaign not found", "campaign_candidate_migration_target_not_found");
  }
  const sourceCampaign = asRecord(sourceCampaignSnap?.data());
  const targetCampaign = asRecord(targetCampaignSnap.data());
  const targetCanonicalProgramId = campaignCanonicalProgramId(targetCampaign);
  if (!targetCanonicalProgramId) {
    throw migrationError("failed-precondition", "target campaign has no canonical program scope", "campaign_candidate_migration_target_program_unresolved");
  }
  const sourceCanonicalProgramId = campaignCanonicalProgramId(sourceCampaign);
  const programSnap = await db.collection(PROGRAMS_COLLECTION).doc(targetCanonicalProgramId).get();
  const targetProgram = asRecord(programSnap.data());
  const outreachDedupScope = resolveOutreachDedupScope(asRecord(settingsSnap?.data()));
  const crossProgramCandidatesAllowed = outreachDedupScope === "program";

  // 자격 기준 해소 — admin.ts prepareProgramCampaignTargetsCore(2997~3068) 와 같은 구성:
  // 캠페인/프로그램 해소 기준 + eligibilityKeywordGate 로 키워드·카테고리 요구 on/off.
  const programDiscoveryPolicy = resolveProgramDiscoveryCriteria(targetProgram, targetCampaign);
  const gateOn = eligibilityKeywordGateEnabled(targetCampaign.targetingCriteria);
  const eligibilityCriteria = {
    keywords: gateOn ? stringList(programDiscoveryPolicy.criteria.keywords, 40) : [],
    excludeKeywords: stringList(programDiscoveryPolicy.criteria.excludeKeywords, 40),
    regions: countryList(programDiscoveryPolicy.criteria.regions),
    categories: gateOn ? stringList(programDiscoveryPolicy.criteria.categories, 30) : [],
    minFollowers: Math.max(0, Math.round(programDiscoveryPolicy.criteria.minFollowers)),
    maxFollowers: Math.max(0, Math.round(programDiscoveryPolicy.criteria.maxFollowers)),
  };

  const actorEvidence = actor
    ? { actorUserIdHash: actorHash(actor.uid), actorRole: actor.role }
    : {};

  const pageCtx: CandidatePageContext = {
    db,
    now,
    migratedAtIso,
    runId,
    targetCanonicalProgramId,
    sourceCanonicalProgramId,
    targetCampaignId: input.targetCampaignId,
    sourceCampaignId: input.sourceCampaignId,
    eligibilityCriteria,
    crossProgramCandidatesAllowed,
    bypassKeywordGate: input.bypassKeywordGate,
    actorEvidence,
  };

  const report: CampaignCandidateMigrationReport = {
    ok: true,
    dryRun: input.dryRun,
    migrationRunId: input.dryRun ? null : runId,
    runRef: input.dryRun ? null : `${DISCOVERY_RUNS_COLLECTION}/${runId}`,
    sourceCampaignId: input.sourceCampaignId,
    sourceStages: input.sourceStages,
    targetCampaignId: input.targetCampaignId,
    sourceCanonicalProgramId,
    targetCanonicalProgramId,
    scannedRows: 0,
    withEmail: 0,
    uniqueEmails: 0,
    skippedNoCandidateId: 0,
    skippedNoEmail: 0,
    duplicateEmailsInRun: 0,
    judgmentDist: { deliverable: 0, risky: 0, unknown: 0, undeliverable: 0, unjudged: 0 },
    suppressionDist: { clean: 0, infly_only: 0, other: 0, both: 0 },
    eligibilityDist: {},
    keywordGateBypassedCount: 0,
    skippedUndeliverable: 0,
    skippedSuppressedOther: 0,
    alreadyExistingTargetDocs: 0,
    skippedAlreadyAdvanced: 0,
    wouldMigrate: 0,
    written: 0,
    createdDocs: 0,
    mergedDocs: 0,
    truncated: false,
    nextCursor: null,
    excludedSampleRefs: [],
  };

  const seenEmails = new Set<string>();
  const totalBudget = input.limit > 0 ? input.limit : Number.POSITIVE_INFINITY;
  const scanPageSize = deps.pageSizeOverride ?? SCAN_PAGE_SIZE;
  // 페이지 경계에서만 체크한다(행 단위가 아니다): 각 페이지가 끝날 때마다 이미 배치 커밋까지
  // 마치므로, 페이지 경계에서만 멈춰도 "진행분 유실 0" 이 보장된다.
  const deadlineMs = nowMs() + MIGRATION_TIME_BUDGET_MS;
  let hasMore = false;
  let resumeStageIndex = cursorState?.stageIndex ?? 0;
  let resumeAfterDocId = cursorState?.afterDocId ?? "";

  const runRef = db.collection(DISCOVERY_RUNS_COLLECTION).doc(runId);
  const runDocBase = {
    id: runId,
    engine: MIGRATION_SOURCE,
    kind: "campaign_candidate_migration",
    canonicalProgramId: targetCanonicalProgramId,
    programId: targetCanonicalProgramId,
    programRef: `${PROGRAMS_COLLECTION}/${targetCanonicalProgramId}`,
    campaignId: input.targetCampaignId,
    campaignRef: `${CAMPAIGNS_COLLECTION}/${input.targetCampaignId}`,
    migration: {
      sourceCampaignId: input.sourceCampaignId,
      sourceCampaignRef: `${CAMPAIGNS_COLLECTION}/${input.sourceCampaignId}`,
      sourceStages: input.sourceStages,
      sourceCanonicalProgramId: sourceCanonicalProgramId || null,
      targetCampaignId: input.targetCampaignId,
      targetCanonicalProgramId,
      batchSize: input.batchSize,
      limit: input.limit || null,
      outreachDedupScope,
      bypassKeywordGate: input.bypassKeywordGate,
      resumedFromCursor: input.cursor || null,
      ...actorEvidence,
    },
    startedAtIso,
    createdAtIso: startedAtIso,
    createdAt: FieldValue.serverTimestamp(),
  };
  let runDocInitialized = false;
  const batchSize = Math.min(input.batchSize, WRITE_BATCH_LIMIT);

  // 베스트에포트 — 이미 존재(하거나 존재할 예정인) 런 문서를 "failed" 로 남겨 영구 "running"
  // 트릿지를 피하고, 직전에 성공한 페이지의 끝 지점을 resumeCursor 로 남긴다(마킹 자체가
  // 실패해도 원래 에러를 덮으면 안 된다 — 삼킨다). resumeStageIndex/resumeAfterDocId 는
  // 클로저로 최신값을 그대로 읽는다 — 루프 중간이든 꼬리(최종 상태 쓰기)든 같은 함수를 쓴다.
  async function markRunFailed(error: unknown): Promise<void> {
    // adversarial review 2026-09-27 (round 3): 이전엔 report 를 안 실어서, 실패 문서가 첫 페이지
    // "running" 스냅샷의 오래된 집계(0 에 가까운 scannedRows 등)를 그대로 보여줬다 — 이후
    // 페이지들이 이미 누적한 최신 집계를 실어야 운영자가 "어디까지 스캔됐는지" 를 report 만
    // 보고도 알 수 있다. resumeCursor(최상위 필드)가 재개 authoritative 값이라 report.nextCursor
    // 도 항상 그 값으로 맞춰 둔다 — 이미 전량 스캔 후 꼬리 쓰기만 실패한 드문 경우엔 재개해도
    // "더 없음" 이 바로 나오니 해롭지 않다.
    const cursor = encodeMigrationCursor(resumeStageIndex, resumeAfterDocId, scanKey);
    report.truncated = true;
    report.nextCursor = cursor;
    try {
      await runRef.set({
        status: "failed",
        failedAtIso: now().toISOString(),
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        resumeCursor: cursor,
        report,
        updatedAtIso: now().toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch { /* 마킹 실패는 삼킨다 — 원래 에러가 운영자에게 돌아가야 한다. */ }
  }

  stageLoop:
  for (let stageIndex = cursorState?.stageIndex ?? 0; stageIndex < input.sourceStages.length; stageIndex += 1) {
    const stage = input.sourceStages[stageIndex];
    // 커서의 afterDocId 는 재개되는 **첫** stage 에만 적용한다 — 이후 stage 는 항상 처음부터.
    let afterDocId: string | null = stageIndex === (cursorState?.stageIndex ?? 0)
      ? (cursorState?.afterDocId || null)
      : null;

    for (;;) {
      if (report.scannedRows >= totalBudget) {
        hasMore = true;
        resumeStageIndex = stageIndex;
        resumeAfterDocId = afterDocId ?? "";
        break stageLoop;
      }
      if (nowMs() >= deadlineMs) {
        hasMore = true;
        resumeStageIndex = stageIndex;
        resumeAfterDocId = afterDocId ?? "";
        break stageLoop;
      }
      const pageSize = Math.min(scanPageSize, totalBudget - report.scannedRows);
      let docs: QueryDocumentSnapshot[];

      // adversarial review 2026-09-27 (round 2): 이 페이지의 **소스 스캔 조회 자체**(round 1
      // 수정에서 빠져 있었다)를 포함해 판정/억제 조회·기존 문서 조회·배치 커밋 중 무엇이든
      // 실패하면 이미 runDocInitialized 된 런 문서를 "failed" 로 남긴다 — 그렇지 않으면 앞선
      // 페이지들은 이미 커밋됐는데 런 문서만 영구 "running" 으로 남고, 재개할 위치를 기록할
      // 곳이 없어 운영자가 어디서부터 재시도해야 할지 알 수 없다.
      try {
        docs = await fetchSourceRowsPage(db, input.sourceCampaignId, stage, afterDocId, pageSize);
        if (docs.length === 0) break; // 이 stage 에 더 없음 — 다음 stage 로.

        const pageResult = await processCandidatePage(docs, seenEmails, pageCtx);
        report.scannedRows += docs.length;
        report.withEmail += pageResult.withEmail;
        report.uniqueEmails += pageResult.uniqueEmails;
        report.skippedNoCandidateId += pageResult.skippedNoCandidateId;
        report.skippedNoEmail += pageResult.skippedNoEmail;
        report.duplicateEmailsInRun += pageResult.duplicateEmailsInRun;
        for (const key of Object.keys(pageResult.judgmentDist)) {
          report.judgmentDist[key] = (report.judgmentDist[key] ?? 0) + pageResult.judgmentDist[key];
        }
        report.skippedUndeliverable += pageResult.skippedUndeliverable;
        for (const key of Object.keys(pageResult.suppressionDist)) {
          report.suppressionDist[key] = (report.suppressionDist[key] ?? 0) + pageResult.suppressionDist[key];
        }
        report.skippedSuppressedOther += pageResult.skippedSuppressedOther;
        for (const ref of pageResult.excludedSampleRefs) {
          if (report.excludedSampleRefs.length < 20) report.excludedSampleRefs.push(ref);
        }
        for (const key of Object.keys(pageResult.eligibilityDist)) {
          report.eligibilityDist[key] = (report.eligibilityDist[key] ?? 0) + pageResult.eligibilityDist[key];
        }
        report.keywordGateBypassedCount += pageResult.keywordGateBypassedCount;
        report.wouldMigrate += pageResult.planned.length;

        // ⑥ 타깃 기존 문서 — 결정적 link id 라 재실행은 같은 문서에 merge 된다. dryRun 에서도
        // 읽는다(리포트가 alreadyExistingTargetDocs 를 보여줘야 하므로) — 쓰지는 않는다.
        // 2026-09-27 [XP→Snake 프로드 사전점검 수리]: 기존 타깃 문서가 이미 이 마이그레이션과
        // 무관한 경로(타깃 캠페인 자체의 라이브 발굴/발송/회신)로 "discovered" 를 지나 진행된
        // 상태라면(isTargetAlreadyAdvanced), 이 실행은 그 문서를 **완전히 건드리지 않는다** —
        // stage 를 "discovered" 로 되돌리면 재컨택/펀널 상태 오염 위험이 있다. programScopeEvidence
        // 등 provenance-only 필드만 부분 병합하는 대안도 고려했으나, (a) 이 필드는 stage="discovered"
        // 문서만 스캔하는 라이브 리필 소비자에게만 의미가 있어 advanced 문서엔 소비자가 없고,
        // (b) Firestore merge:true 는 중첩 맵을 얕게(전체 치환) 병합해 별도 field-mask 없이는
        // 의도치 않게 기존 provenance 를 지울 위험이 있다 — 그래서 skip 이 더 안전하다. 건너뛴
        // 건수는 skippedAlreadyAdvanced 로 집계한다(alreadyExistingTargetDocs 의 부분집합).
        const existingSnaps = await getAllDocs(db, pageResult.planned.map((item) => item.ref));
        let pageAlreadyExisting = 0;
        let pageAlreadyAdvanced = 0;
        const writablePlanned: PlannedParticipationWrite[] = [];
        for (let index = 0; index < pageResult.planned.length; index += 1) {
          const snapshot = existingSnaps[index];
          const exists = snapshot?.exists === true;
          if (exists) pageAlreadyExisting += 1;
          if (exists && isTargetAlreadyAdvanced(snapshot?.data())) {
            pageAlreadyAdvanced += 1;
            continue;
          }
          writablePlanned.push(pageResult.planned[index]);
        }
        report.alreadyExistingTargetDocs += pageAlreadyExisting;
        report.skippedAlreadyAdvanced += pageAlreadyAdvanced;

        if (!input.dryRun && writablePlanned.length > 0) {
          if (!runDocInitialized) {
            // ⑦ 실행 — provenance 런 문서(discovery_runs/{runId}, 계약이 강제하는 경로)를
            // "running" 으로 먼저 쓴다: 참여 문서의 sourceRunRef 가 가리키는 런 레코드가 배치
            // 도중에도 존재하고, 이 호출이 중간에 죽어도 "completed" 로 거짓 도장되지 않는다.
            await runRef.set({
              ...runDocBase,
              status: "running",
              report,
              updatedAtIso: now().toISOString(),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            runDocInitialized = true;
          }
          const existsByPath = new Map(existingSnaps.map((snapshot) => [snapshot.ref.path, snapshot.exists]));
          const pageWriteAtIso = now().toISOString();
          // 페이지 단위로 즉시 커밋 — 이 호출이 이후 페이지 처리 중 시간 예산/타임아웃/에러에
          // 걸려도 이미 커밋된 페이지의 이주 문서는 남는다(프로드 실측: 전량 스캔 후 한 번에
          // 쓰던 예전 방식은 504 시 진행분 전체가 유실됐다).
          for (let offset = 0; offset < writablePlanned.length; offset += batchSize) {
            const chunk = writablePlanned.slice(offset, offset + batchSize);
            const batch = db.batch();
            for (const item of chunk) {
              const alreadyExisted = existsByPath.get(item.ref.path) === true;
              // 2026-09-27 [adversarial review round 1/2 — TOCTOU 레이스 수리]:
              // isTargetAlreadyAdvanced/existsByPath 는 existingSnaps 를 읽은 **시점**의
              // 스냅샷으로만 판정한다 — 그 읽기와 이 배치 커밋 사이(같은 페이지 안, I/O 한
              // 왕복)에 라이브 발송/회신/다른 링크 경로가 **바로 이 문서**를 건드리면 판정은
              // 이미 낡아 있다(codex 리뷰가 fake-firestore 인터리빙으로 두 방향 모두 재현):
              //   · 존재(round 1): 읽을 때 이미 있던 문서 → merge 페이로드에 stage 가 있으면
              //     그 사이의 진행을 조용히 "discovered" 로 되돌린다.
              //   · 부재(round 2): 읽을 때 없던 문서 → addCandidatesToCampaign(campaigns.ts,
              //     수동 연동 경로, stage:"contact") 등 **다른 정당한 writer**가 같은 결정적
              //     link id 로 그 사이 먼저 만들면, 무조건 set(merge:true) 이 그 문서를
              //     "discovered" 로 조용히 덮어쓴다.
              // 두 경우 다 "판정을 더 정교하게" 가 아니라 **쓰기 자체를 그 경합에 안전하게**
              // 만들어야 막힌다:
              //   · 존재했던 문서 → stage 를 페이로드에서 아예 뺀다(merge:true 는 페이로드에
              //     없는 필드를 절대 안 건드리므로 동시성 창의 폭과 무관하게 구조적으로 안전).
              //   · 없었던 문서 → set(merge:true) 대신 batch.create() 를 쓴다 — 커밋 시점에
              //     문서가 이미 있으면(그 사이 다른 writer 가 만들었으면) 조용히 덮어쓰지 않고
              //     이 배치 전체가 실패한다(fail-closed). 실패하면 기존 catch 블록이 런 문서를
              //     "failed"+resumeCursor 로 남기고(위 markRunFailed), 재개(cursor) 시 그
              //     문서는 이제 "존재" 갈래로 재분류돼 안전하게 처리된다 — 조용한 데이터 오염
              //     대신 명시적 재시도로 수렴한다.
              const { stage: _omitStageOnExistingDoc, ...dataWithoutStage } = item.data;
              const extraFields = {
                source: MIGRATION_SOURCE,
                migrationRunId: runId,
                migratedAtIso,
                updatedAtIso: pageWriteAtIso,
                updatedAt: FieldValue.serverTimestamp(),
              };
              if (alreadyExisted) {
                batch.set(item.ref, {
                  ...dataWithoutStage,
                  ...extraFields,
                  persistOutcome: "merged",
                }, { merge: true });
              } else {
                batch.create(item.ref, {
                  ...item.data,
                  ...extraFields,
                  persistOutcome: "created",
                });
              }
            }
            await batch.commit();
          }
          // pageAlreadyExisting 은 스킵된 advanced 문서도 포함하므로, writable 문서 중 기존
          // 문서였던 수(= merged)는 pageAlreadyExisting - pageAlreadyAdvanced 다.
          const pageMergedWritable = pageAlreadyExisting - pageAlreadyAdvanced;
          report.written += writablePlanned.length;
          report.createdDocs += writablePlanned.length - pageMergedWritable;
          report.mergedDocs += pageMergedWritable;
        }
      } catch (error) {
        // 이 페이지(스캔 조회 포함)가 실패했다 — 이미 커밋된 페이지들은 재실행 merge 로
        // 수습된다. runDocInitialized 가 아직 false 면(= 어떤 페이지도 쓴 적 없음) 런 문서
        // 자체가 없으니 마킹할 것도 없다 — 원래 동작(첫 실패 전엔 아무 것도 안 남는다)과 동일.
        if (runDocInitialized) await markRunFailed(error);
        throw error;
      }

      afterDocId = docs[docs.length - 1].id;
      resumeStageIndex = stageIndex;
      resumeAfterDocId = afterDocId;

      if (docs.length < pageSize) break; // 이 stage 소진 — 다음 stage 로.
    }
  }

  report.truncated = hasMore;
  report.nextCursor = hasMore ? encodeMigrationCursor(resumeStageIndex, resumeAfterDocId, scanKey) : null;

  if (input.dryRun) return report;

  // adversarial review 2026-09-27 (round 2): 이 꼬리 구간의 쓰기(초기 "running" 마킹이든 최종
  // 상태 전환이든)가 실패해도 markRunFailed 로 잡는다 — 안 그러면 이 두 쓰기 중 하나가 죽었을 때
  // 런 문서가 "running" 에 영구히 갇히고, 재개 위치도 안 남는다. 여기서는 루프와 달리
  // runDocInitialized 여부와 무관하게 항상 마킹한다 — 이 지점부턴 어차피 런 문서를 반드시
  // 남기려는 참(위 주석 "항상 런 문서를 쓴다")이라, 그 시도 자체가 실패한 경우도 실패로 남겨야
  // 운영자가 알 수 있다.
  try {
    if (!runDocInitialized) {
      // 이 호출에서 아무 것도 planned 되지 않았어도(모든 행이 게이트에 걸림) 런 문서는 남긴다 —
      // 원래 동작(항상 런 문서를 쓴다)과 동일.
      await runRef.set({
        ...runDocBase,
        status: "running",
        report,
        updatedAtIso: now().toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    const completedAtIso = now().toISOString();
    await runRef.set({
      // "partial": 이 호출은 정상 완료됐지만(에러 없음) 예산/limit 때문에 멈췄고 더 스캔할 게
      // 남아 있다 — 호출자가 nextCursor 로 이어가야 완주다. 전체 소스를 다 스캔했으면 "completed".
      status: hasMore ? "partial" : "completed",
      report,
      completedAtIso,
      updatedAtIso: completedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    await markRunFailed(error);
    throw error;
  }
  return report;
}

/**
 * 콜러블 진입점 — RBAC 는 repairLegacyCandidateScopes 와 같은 등급(admin+): 이주는
 * 수천 문서를 한 번에 쓰는 벌크 데이터 조작이라 routine campaign-control(manager+) 보다
 * 수리/이주 계열 콜러블의 기준을 따른다.
 */
export async function migrateCampaignCandidates(request: CallableRequestShape) {
  const uid = text(request.auth?.uid);
  const role = request.auth?.token?.role ?? "guest";
  if (!uid || !MIGRATION_WRITE_ROLES.has(role)) {
    throw Object.assign(new Error(!uid ? "unauthenticated" : "permission-denied: admin role required"), {
      code: !uid ? "unauthenticated" : "permission-denied",
      errorCode: "migrate_campaign_candidates_unauthorized",
    });
  }
  const input = parseCampaignCandidateMigrationInput(request.data);
  if (!input.dryRun && text(asRecord(request.data).confirm) !== CAMPAIGN_CANDIDATE_MIGRATION_CONFIRMATION) {
    throw migrationError(
      "failed-precondition",
      `execute mode requires confirm: "${CAMPAIGN_CANDIDATE_MIGRATION_CONFIRMATION}"`,
      "migrate_campaign_candidates_confirmation_required",
    );
  }
  return runCampaignCandidateMigration(input, { uid, role });
}
