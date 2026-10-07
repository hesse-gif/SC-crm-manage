// 영상검수 "게임 필터" 신원 해석기 — 행(row) 수준의 **명시 증거만**으로 레지스트리 타이틀을 찍는다.
//
// 계약(행 증거 우선, 폴백 없음):
// - 인정하는 증거는 행에 적힌 값뿐이다: 정본 `gameId` 필드 + game/app/title 계열 별칭 필드.
//   별칭 값은 전부 `normalizeProgramTitleId`(functions/programTitles.ts)를 통과해야 증거가 된다.
// - 프로그램 기본 타이틀·소유자·"등록 안 된 프로그램은 SCP" 같은 폴백은 전부 금지다 —
//   `resolveSubmissionGameId`/`resolveProgramTitlesOrDefault` 의 기본값 착지는 인제스트 계약이고,
//   필터는 "모르면 unknown" 이 정답이다. 레지스트리도 `resolveProgramTitles`(빈 레지스트리
//   허용)만 쓴다.
// - 증거가 하나의 타이틀로만 수렴하면 resolved. 서로 다른 타이틀 주장이 공존(conflict)하거나,
//   값이 아예 없거나, 전용 필드의 주장이 레지스트리를 통과 못 하면 unknown — 필터는 그 행을
//   어떤 게임 버킷에도 넣지 않는다.
// - 입력 문서는 절대 변경하지 않는다(pure). 발견한 원문 값은 `evidence` 에 그대로 보존한다.
//
// 인제스트 스탬프 마커(`gameIdUnresolved` / `gameIdDefaulted`): `resolveSubmissionGameId` 는
// 선언을 레지스트리로 해석하지 못할 때 **거부하지 않고** 기본 타이틀로 착지시킨다 —
// 레지스트리에 없는 선언 값이면 `gameIdUnresolved: true`(사람 게이트 신호 — 포털이
// 레지스트리보다 먼저 새 타이틀을 보낼 수 있어 수신 자체를 막지 않는다), 선언 누락/빈 값을
// 포함한 모든 기본값 착지에는 `gameIdDefaulted: true`. 그래서 두 마커 중 하나라도 붙은 행의
// `gameId`/`subject.gameId` 는 행의 주장이 아니라 **기본값 스탬프**다.
// 필터는 그 필드를 claim 집합에서 제외한다(원문은 evidence 에 `defaulted: true` 로 보존) —
// 스탬프가 기본 타이틀 버킷에 조용히 들어가는 것을 막기 위해서다. 별칭 필드(game·app·title
// 계열)는 인제스트가 덮어쓰지 않으므로 그대로 증거다: 스탬프 행도 별칭이 한 타이틀로 수렴하면
// 그 타이틀로 해석된다. 마커의 의미는 갈린다 — `gameIdUnresolved` 는 "해석 못 한 주장이
// 있었다"는 증거라 다른 증거 없이 마커만 있으면 no-evidence 가 아니라 unresolved-evidence 로
// 돌려보내지만, `gameIdDefaulted`(선언 없음 포함)는 주장의 존재를 뜻하지 않으므로
// unresolved-evidence 판정에 기여하지 않는다.
//
// 전용/모호 구분: `gameId`·`game*` 필드는 게임 전용이라 미등록 값도 "다른 게임 주장"으로 센다
// (명시 id 와 충돌하면 conflict). `app*`·`title` 은 자유 텍스트(영상 제목 등)가 섞일 수 있어
// 레지스트리를 통과할 때만 증거로 인정한다 — 그래야 `gameId: "xp-hero"` + 영상 제목 행이
// 억울하게 unknown 으로 빠지지 않는다.

import { normalizeProgramTitleId, resolveProgramTitles } from "./programTitles";

/**
 * 정본 id 필드 — 인제스트가 확정해 박아 넣는 값. 검수 원장은 같은 키를 `subject.gameId` 로
 * 중첩해 들고 다니므로 둘 다 스캔한다 — **같은 claim 집합**이다. 최상위와 subject 가 다른
 * 타이틀을 가리켜도 덮어쓰지 않고 conflict 로 간다.
 */
const EXPLICIT_GAME_ID_FIELDS = ["gameId", "subject.gameId"] as const;

/** 게임 전용 별칭 — 값이 있으면 미등록이어도 게임 주장으로 센다. */
const GAME_ALIAS_FIELDS = ["game", "gameName", "game_name", "gameTitle", "game_title"] as const;

/** 모호 별칭 — 레지스트리 정규화를 통과하는 값만 증거가 된다. */
const AMBIGUOUS_ALIAS_FIELDS = ["app", "appName", "app_name", "title"] as const;

// B-2 하드닝: `subject` 아래 중첩된 같은 별칭들도 동급 증거다. `EXPLICIT_GAME_ID_FIELDS` 는
// 이미 `subject.gameId` 를 정본 필드와 같은 claim 집합으로 스캔하는데, 별칭(game/app/title
// 계열)은 최상위만 스캔했다 — judge(videoReviewAnalysisJudge.ts 의 resolveAnalysisGameIdentity)
// 는 subject 를 그 자체로 한 번 더 이 리졸버에 넘겨(row 취급) subject.game/subject.app 까지
// 증거로 인정하는데, 이 리졸버를 행에 직접 호출하는 다른 참조처(예:
// videoReviewStateCallables.ts 의 titleId 필터)는 subject.gameId 만 보고 subject.game/app 는
// 놓쳐 레인 간 판정이 갈렸다. 같은 우선순위(전용=game 계열, 모호=app/title 계열)를 중첩
// 경로에도 그대로 적용해 정본을 하나로 통일한다.
const NESTED_GAME_ALIAS_FIELDS = GAME_ALIAS_FIELDS.map((field) => `subject.${field}`);
const NESTED_AMBIGUOUS_ALIAS_FIELDS = AMBIGUOUS_ALIAS_FIELDS.map((field) => `subject.${field}`);

/** 스캔하는 증거 필드 전체(순서 = 우선순위 아님, 증거 나열 순서). */
export const VIDEO_REVIEW_GAME_FILTER_EVIDENCE_FIELDS: readonly string[] = [
  ...EXPLICIT_GAME_ID_FIELDS,
  ...GAME_ALIAS_FIELDS,
  ...NESTED_GAME_ALIAS_FIELDS,
  ...AMBIGUOUS_ALIAS_FIELDS,
  ...NESTED_AMBIGUOUS_ALIAS_FIELDS,
];

const DEDICATED_FIELDS: ReadonlySet<string> = new Set([
  ...EXPLICIT_GAME_ID_FIELDS,
  ...GAME_ALIAS_FIELDS,
  ...NESTED_GAME_ALIAS_FIELDS,
]);

export type VideoReviewGameFilterEvidence = {
  /** 증거를 낸 행 필드명. */
  field: string;
  /** 행에 적힌 원문(트림 후) — 입력 문서를 변경하지 않고 여기에 보존한다. */
  raw: string;
  /** 레지스트리 정규화 결과 타이틀 id. 미등록 값은 null. */
  gameId: string | null;
  /**
   * true = 이 값은 행의 주장이 아니라 인제스트 기본값 스탬프다(`gameIdUnresolved` 또는
   * `gameIdDefaulted` 마커가 붙은 `gameId`/`subject.gameId`). 원문 보존용으로만 남고
   * claim 집합에는 들어가지 않는다.
   */
  defaulted?: true;
};

export type VideoReviewGameFilterIdentity = {
  /** 확정된 레지스트리 타이틀 id. 미해결이면 "" — 호출부는 unknown 버킷으로 보낸다. */
  gameId: string;
  status: "resolved" | "unknown";
  /**
   * resolved = 단일 타이틀 수렴.
   * conflict = 서로 다른 게임 주장 2개 이상(등록 id 간 충돌, 또는 명시 전용 필드의 미등록
   *   주장과 등록 id 의 충돌).
   * unresolved-evidence = 주장은 있으나 레지스트리 타이틀로 하나도 해석되지 않음.
   * no-evidence = 스캔 필드에 비어있지 않은 값이 하나도 없음.
   */
  reason: "resolved" | "conflict" | "unresolved-evidence" | "no-evidence";
  /** 발견한 원문 증거 나열 — resolved 여부와 무관하게 항상 채운다. */
  evidence: readonly VideoReviewGameFilterEvidence[];
};

/**
 * 행 수준 명시 증거만으로 영상검수 게임 필터 신원을 해석한다.
 *
 * `programId` 는 타이틀 우주(레지스트리)를 고를 뿐 신원의 폴백으로 쓰이지 않는다 —
 * 미등록 프로그램은 빈 레지스트리라 모든 값이 미등록 → unknown 이 된다.
 */
export function resolveVideoReviewGameFilterIdentity(
  row: unknown,
  programId: unknown,
  override?: unknown,
): VideoReviewGameFilterIdentity {
  const registry = resolveProgramTitles(programId, override);
  const rec: Record<string, unknown> =
    row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};

  const evidence: VideoReviewGameFilterEvidence[] = [];
  const resolvedIds = new Set<string>();
  const unregisteredClaims = new Set<string>();

  const subject =
    rec.subject && typeof rec.subject === "object" && !Array.isArray(rec.subject)
      ? (rec.subject as Record<string, unknown>)
      : undefined;

  // `gameIdUnresolved: true` = 인제스트가 "레지스트리에 없는 선언"을 기본 타이틀로
  // 착지시켰다는 뜻. `gameIdDefaulted: true` = 선언 누락/빈 값을 포함해 gameId 가 선언 해석이
  // 아니라 기본값 스탬프라는 뜻. 둘 다 그 gameId 값은 행의 주장이 아니라 스탬프다. 마커는
  // gameId 필드와 같은 수준(최상위↔subject)에 붙으므로 수준별로 짝지어 할인한다 — 한 수준의
  // 마커가 다른 수준의 진짜 명시 값까지 지우지 않게.
  const topGameIdUnresolved = rec.gameIdUnresolved === true;
  const subjectGameIdUnresolved = subject?.gameIdUnresolved === true;
  const topGameIdDefaulted = topGameIdUnresolved || rec.gameIdDefaulted === true;
  const subjectGameIdDefaulted = subjectGameIdUnresolved || subject?.gameIdDefaulted === true;

  for (const field of VIDEO_REVIEW_GAME_FILTER_EVIDENCE_FIELDS) {
    const value = field.startsWith("subject.")
      ? subject?.[field.slice("subject.".length)]
      : rec[field];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const raw = value.trim();
    const gameId = normalizeProgramTitleId(registry, raw);
    const defaulted =
      (field === "gameId" && topGameIdDefaulted) ||
      (field === "subject.gameId" && subjectGameIdDefaulted);
    evidence.push({ field, raw, gameId, ...(defaulted ? { defaulted: true as const } : {}) });
    if (defaulted) continue;
    if (gameId) {
      resolvedIds.add(gameId);
    } else if (DEDICATED_FIELDS.has(field)) {
      unregisteredClaims.add(raw.toLowerCase().replace(/[\s_]+/g, "-"));
    }
  }

  if (resolvedIds.size === 1 && unregisteredClaims.size === 0) {
    const [gameId] = resolvedIds;
    return { gameId, status: "resolved", reason: "resolved", evidence };
  }
  if (resolvedIds.size + unregisteredClaims.size > 1) {
    return { gameId: "", status: "unknown", reason: "conflict", evidence };
  }
  // `gameIdUnresolved` 스탬프는 "해석 못 한 게임 주장이 있었다"는 증거다 — 아무것도 적히지
  // 않은 행(no-evidence)과는 다르게 취급한다. `gameIdDefaulted` 만으로는 주장이 없었다는
  // 뜻이라(선언 누락 포함) unresolved-evidence 로 올리지 않는다.
  const reason =
    unregisteredClaims.size === 1 || topGameIdUnresolved || subjectGameIdUnresolved
      ? "unresolved-evidence"
      : "no-evidence";
  return { gameId: "", status: "unknown", reason, evidence };
}

/**
 * B-2 하드닝 — the ONE field-priority contract for "this subject bag's declared game id".
 *
 * A few callers used to read `subject.gameId` directly (raw, un-normalized, no alias
 * fallback): scpOutboxMailWorkers.ts's video-result mail render, videoReviewStateCallables.ts's
 * admin-facing gameId badges. That meant a submission whose only game evidence lived under
 * `subject.game`/`subject.app` (the SAME aliases resolveVideoReviewGameFilterIdentity already
 * treats as evidence once you scan the subject bag — see `NESTED_GAME_ALIAS_FIELDS` above)
 * showed up gameId-less in mail/admin surfaces while resolving normally everywhere the full
 * scanner runs. This helper is what those raw callers must use instead of reading
 * `subject.gameId` themselves, so every lane applies the SAME field priority: the dedicated
 * id field first — UNLESS it is an ingest default-landing stamp (`gameIdUnresolved` /
 * `gameIdDefaulted`; see the module doc above — a stamped value is not the row's own claim) —
 * then the same game-alias fields, then the same ambiguous alias fields, in the exact order
 * `resolveVideoReviewGameFilterIdentity` already uses.
 *
 * Deliberately NOT registry-aware: unlike the full resolver, this never normalizes against a
 * title registry and never detects a cross-field conflict — it returns the first non-empty
 * candidate, trimmed, or "" when none exist. Callers that need registry validation or
 * conflict detection should call `resolveVideoReviewGameFilterIdentity` instead. Backward
 * compatible with existing docs that carry only `gameId`, only an alias, or neither.
 */
export function resolveSubjectGameId(subject: unknown): string {
  const rec: Record<string, unknown> =
    subject && typeof subject === "object" && !Array.isArray(subject) ? (subject as Record<string, unknown>) : {};
  const gameIdIsStamp = rec.gameIdUnresolved === true || rec.gameIdDefaulted === true;
  if (!gameIdIsStamp) {
    const declared = rec.gameId;
    if (typeof declared === "string" && declared.trim().length > 0) return declared.trim();
  }
  for (const field of [...GAME_ALIAS_FIELDS, ...AMBIGUOUS_ALIAS_FIELDS]) {
    const value = rec[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}
