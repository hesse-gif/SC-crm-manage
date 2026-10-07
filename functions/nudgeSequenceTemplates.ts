// W72 독려 메일 — 코호트 × 회차 문안 매핑 정본 (리더 승인 2026-08-12, 결정요청 5번)
//
// ■ 왜 문서 1개인가
//   요구는 코호트별 × 회차별(1..3 / 1..10 / 1..5 = 18슬롯) 문안을 헤세가 화면에서 전부 세팅하는 것이다.
//   문서를 18개로 쪼개면 같은 문안을 여러 회차에 쓸 때마다 **복제**해야 하고 수정이 18곳으로 흩어진다.
//   여기서는 매핑만 담고 문안 자체는 기존 `scp_mail_templates/{templateKey}` 를 그대로 가리킨다.
//   → 새 컬렉션 0, 새 스케줄 0, 문안 재사용 공짜.
//
// ■ 왜 `settings/` 인가
//   `settings/scp_receipt_mail_golive`(receiptMailGoLive.ts) 와 **같은 관례**다. 새 패턴을 발명하지 않는다.
//   `scp_mail_templates` 안에 두면 "문서 1개 = 템플릿 1개" 불변이 깨져 편집기 패널에 매핑 문서가
//   템플릿 카드로 뜬다.
//
// ■ fail-closed (이 파일의 핵심 계약)
//   문서 없음 / enabled !== true / cohorts 아님 / 회차 키 없음 / templateKey 빈 문자열
//   → 전부 "매핑 없음"이다. 호출부는 **적재하지 않는다**. 임의 폴백 문안으로 보내지 않는다.
//   읽기 실패도 같다. 즉 이 파일이 무엇을 잘못 읽어도 **발송이 늘어나는 방향으로는 실패하지 않는다.**
//
// ■ 왜 "발송 후 스킵"이 아니라 "적재 전 차단"인가
//   회차는 적재가 아니라 delivered 로 소모된다(W72-B). 그래도 미매핑 회차를 적재해 두면 큐에
//   영원히 소비되지 않는 행이 쌓이고 회계 레인에 stalled 로 뜬다. 애초에 만들지 않는 쪽이 정직하다.

import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";

export const NUDGE_SEQUENCE_TEMPLATES_DOC_PATH = "settings/scp_nudge_sequence_templates";

/** 코호트 키. 헤세 3코호트 정의와 1:1 이고 이 목록 밖의 키는 무시한다(오타로 레인이 생기지 않게). */
export const NUDGE_COHORT1_KEY = "cohort1_read_no_reply";
export const NUDGE_COHORT2_KEY = "cohort2_applied_no_video";
export const NUDGE_COHORT3_KEY = "cohort3_unread_no_reply";
// Task-100 F-6: 반려 후 재제출 독려 코호트. 회차/기한은 settings/scp_resubmission_policy(결정 #7
// 대기, resubmissionCyclePolicy.ts)가 정본이고, 이 코호트는 레인 캡·kill-switch·nudge_total 합산
// 축에 편입시키는 용도다(mailOutboundSafety.totalDailyQuotaAllows 가 NUDGE_LANE_PURPOSE_TO_COHORT
// 의 키를 그대로 합산하므로 여기 등록만으로 nudge_total 축에 자동 포함된다).
export const NUDGE_COHORT4_KEY = "cohort4_resubmission_nudge";

export const NUDGE_COHORT_KEYS = [
  NUDGE_COHORT1_KEY,
  NUDGE_COHORT2_KEY,
  NUDGE_COHORT3_KEY,
  NUDGE_COHORT4_KEY,
] as const;

/**
 * W72 마감리뷰 P0-2: 주기 기본값 정본. 파서와 스윕이 **같은 값**을 써야 한다 —
 * 갈라지면 스윕이 0(폭송) 쪽으로 열린다.
 */
export const NUDGE_DEFAULT_CADENCE_DAYS = 7;

export type NudgeCohortKey = (typeof NUDGE_COHORT_KEYS)[number];

/**
 * 헤세 확정 상한 3/10/5 와 리더 확정 레인 캡 250.
 * **코드 기본값으로 박는 것이 아니다**(브리프 §1-1a) — 설정 문서가 없을 때의 fail-closed 기본은
 * `enabled:false` 이고, 이 표는 설정이 값을 생략했을 때의 상한선일 뿐이다.
 * 상한을 생략했다고 무제한이 되면 안 되므로 여기서 막는다.
 */
const COHORT_CEILINGS: Record<
  NudgeCohortKey,
  { maxSends: number; liveSend: boolean; dailyCap: number }
> = {
  // dailyCap 천장도 코드가 쥔다(적대 리뷰 P0): 설정 한 줄로 일캡을 10,000 까지 올릴 수 있으면
  //   "리더 확정" 값은 안전망이 아니라 기본값에 불과해진다. 천장 초과는 **코드 변경 + 승인**이다.
  // [헤세 결정 2026-08-29] 250 → 500. 근거(프로드 실측): 적격자를 찾은 스윕 런은 예외 없이
  //   NUDGE_SWEEP_MAX_ENQUEUE_PER_RUN(50)을 채우고 `run_cap` 으로 끊긴다 — 대기 인구가 없어서가
  //   아니라 상한 때문에 멈춘다는 뜻이다. 실효 처리량은 ~600/일로 3코호트 합 750/일 천장 바로
  //   아래에 붙어 있었다. 이 상향은 그 천장을 1,500/일로 올린다.
  //   ⚠️ 스윕 쪽 상한은 그대로다: 런당 50 × 시간당 1런 = 1,200/일이 실질 공급 한계이므로,
  //   이 캡만 올려서는 1,200 을 넘지 않는다(레인 캡이 병목에서 빠질 뿐이다).
  // W72-B2 [헤세 결정 2026-08-13 03:3x]: "코호트 1 3 도 게이트 필요없어 바로 보내면 좋겠다".
  //   6라운드 리뷰가 지킨 코드 천장을 **의도적으로** 바꾼다. 설정이 이 값을 올릴 수는 여전히 없다 —
  //   바꾸려면 코드 변경 + 리뷰를 거쳐야 한다는 성질은 그대로다.
  [NUDGE_COHORT1_KEY]: { maxSends: 3, liveSend: true, dailyCap: 500 },
  [NUDGE_COHORT2_KEY]: { maxSends: 10, liveSend: true, dailyCap: 500 },
  [NUDGE_COHORT3_KEY]: { maxSends: 5, liveSend: true, dailyCap: 500 },
  // Task-100 [헤세 결정 대기 #7]: 별첨 B 원문(실제 횟수·기한)이 미확정이라 코드 천장은 보수적으로
  //   잡는다 — resubmissionCyclePolicy.ts 의 maxNudges(설정)는 이 천장을 넘지 못한다. 리더 확정치가
  //   나오면 이 값을 올린다(다른 코호트 천장과 같은 불변식: "설정이 코드 천장을 넘을 수 없다").
  [NUDGE_COHORT4_KEY]: { maxSends: 5, liveSend: true, dailyCap: 200 },
};

/** 리더 확정: 독려 3코호트 각 500/일(헤세 2026-08-29 상향). 비소모 유예 상한도 같은 값을 따른다. */
const DEFAULT_LANE_DAILY_CAP = 500;

/**
 * [헤세 2026-09-03] 코호트 **합산** 배출 상한의 코드 천장. 코호트별 캡은 레인 하나가 넘지
 * 못하는 개별 상한이고, 이 값은 여러 레인을 **합쳐서** 또 한 번 조인다 — 코호트별 캡만
 * 있으면 레인들이 동시에 각자 캡만큼 나가는 날 총합이 그만큼 커질 수 있다.
 * 애초에는 세 코호트(cohort1~3, 각 500) 물리적 최댓값(3 × 500)으로 1,500을 잡았다.
 * [헤세 2026-09-17] resubmission_nudge(cohort4, dailyCap 200)도 같은 합산 천장을 공유한다
 * (resubmissionNudgeMail.ts 의 readNudgeTotalDailyCap/totalQuotaCheck 참고) — 그래서 지금은
 * "코호트 수 × 500"과 정확히 일치하는 산식이 아니라 고정 상한이다. 설정 한 줄로 이 이상 열 수는
 * 없다(코호트별 천장과 같은 불변식: "설정이 코드 천장을 넘을 수 없다"). 값 자체(1,500)는 별도
 * 결정 없이는 바꾸지 않는다.
 */
export const NUDGE_TOTAL_DAILY_CAP_CEILING = 1500;

/**
 * 세 코호트 합산 배출 상한. 없으면(설정 미기입) **null = "이 축 없음, 코호트별 캡만 적용"**
 * (기존 동작 그대로 유지) — 이 필드가 생기기 전에는 합산 상한이 아예 없었으므로, 미기입은
 * "그 상태를 유지한다"는 뜻이지 "0"이나 "무한대"가 아니다.
 *
 * 망가진 값(숫자가 아님·정수가 아님 등)도 **같은 null 로 닫는다** — dailyCap 처리와 같은 논리다:
 * 0 으로 닫으면 이미 코호트별 레인 캡을 통과한 정상 배출까지 전부 멈춘다. 합산 축은 코호트별
 * 캡 위에 얹는 **추가** 안전판이지 유일한 방어선이 아니므로, 손상 시 이 축만 빠지고 코호트별
 * 캡은 그대로 강제된다 — "배출이 멈추면 안 된다"는 이 파일의 정본 원칙(위 dailyCap 주석 참고)을
 * 따른다.
 */
function parseTotalDailyCap(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  // 적대 리뷰 LOW: 음수를 0(전량 차단)으로 뭉개지 않는다 — 0 은 "의도적으로 전부 막는다"는
  //   유효한 값이지만(위 0 테스트 참고) 음수는 그런 의도를 표현할 방법이 아니라 타이핑 실수·버그
  //   같은 손상값에 가깝다. 손상값이 조용히 0(가장 공격적인 차단)으로 떨어지면, 이 축이 아예
  //   없던 이전 상태보다 **더 좁게** 실패한다 — "배출이 멈추면 안 된다"는 이 파일의 fail-closed
  //   방향과 반대다. 그래서 다른 손상값과 같은 취급(null = 이 축 없음, 코호트별 캡만 적용)으로 되돌린다.
  if (value < 0) return null;
  return Math.min(value, NUDGE_TOTAL_DAILY_CAP_CEILING);
}

/**
 * W72 C-1: 코드 천장을 **읽기 전용으로** 노출한다.
 * 화면이 3/10/5·250·liveSend 를 자기 상수로 복제하면 한쪽만 바뀌었을 때 화면과 서버가 다른 말을 한다.
 */
export function nudgeCohortCeilings(): Record<
  NudgeCohortKey,
  { maxSends: number; liveSend: boolean; dailyCap: number }
> {
  // 얕은 복사는 **중첩 객체를 공유**한다 — 호출부가 `ceilings.cohort2.maxSends = 999` 를 하면
  //   원본 천장이 오염되고, 그 순간 상한이 코드 상수가 아니게 된다(테스트가 잡았다).
  return Object.fromEntries(
    NUDGE_COHORT_KEYS.map((cohort) => [cohort, { ...COHORT_CEILINGS[cohort] }]),
  ) as Record<NudgeCohortKey, { maxSends: number; liveSend: boolean; dailyCap: number }>;
}

export type NudgeCohortConfig = {
  readonly cohort: NudgeCohortKey;
  readonly maxSends: number;
  readonly cadenceDays: number;
  readonly dailyCap: number;
  readonly quotaDeferralCap: number;
  /** 코호트2 만 true. 코호트1·3 은 draft_only 유지(리더 재확인 2026-08-12). */
  readonly liveSend: boolean;
  /** 회차(1-based) → 템플릿 문서 키. 미설정 회차는 **키 자체가 없다**. */
  readonly sequence: ReadonlyMap<number, string>;
};

/**
 * 0.6.110: 프로그램/캠페인별 문안 매핑 오버라이드. 같은 설정 문서의 `programOverrides.<id>` 에 둔다.
 * `<id>` 는 캠페인 ID(`cp-…`) 또는 정규 프로그램 ID(`pg-…`)다. 오버라이드가 **없으면**(또는 꺼져
 * 있거나 그 코호트 매핑이 비어 있으면) 전역 매핑이 그대로 쓰인다 — XP/SCP 동작은 불변이다.
 * 오버라이드가 선택된 코호트에서 회차가 비어 있으면 **전역으로 폴백하지 않는다**(fail-closed):
 * Snake 수신자에게 XP 문안이 섞여 나가는 것이 이 기능이 막으려는 사고다.
 */
export type NudgeProgramOverride = {
  readonly enabled: true;
  /** 코호트 → 회차(1-based) → 템플릿 키. 매핑이 하나도 없는 코호트는 키 자체가 없다. */
  readonly sequences: ReadonlyMap<NudgeCohortKey, ReadonlyMap<number, string>>;
};

export type NudgeSequenceConfig = {
  readonly enabled: boolean;
  readonly cohorts: ReadonlyMap<NudgeCohortKey, NudgeCohortConfig>;
  /** [헤세 2026-09-03] 세 코호트 합산 배출 상한. null = 이 축 없음(코호트별 캡만 적용). */
  readonly totalDailyCap: number | null;
  /** 0.6.110: 프로그램/캠페인 ID → 오버라이드. 전역 `enabled` 가 꺼지면 항상 빈 맵이다. */
  readonly programOverrides: ReadonlyMap<string, NudgeProgramOverride>;
};

const NO_PROGRAM_OVERRIDES: ReadonlyMap<string, NudgeProgramOverride> = new Map();
const DISABLED: NudgeSequenceConfig = {
  enabled: false, cohorts: new Map(), totalDailyCap: null, programOverrides: NO_PROGRAM_OVERRIDES,
};

/** 오버라이드 키(캠페인/프로그램 ID) 형상. 랜딩 링크 mint 의 IDENTIFIER_RE 와 같다. */
export const NUDGE_PROGRAM_OVERRIDE_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function parseProgramOverrides(
  value: unknown,
  cadenceInvalidCohorts: ReadonlySet<NudgeCohortKey>,
): Map<string, NudgeProgramOverride> {
  const out = new Map<string, NudgeProgramOverride>();
  for (const [rawId, rawOverride] of Object.entries(asRecord(value))) {
    if (!NUDGE_PROGRAM_OVERRIDE_KEY_RE.test(rawId)) continue;
    const override = asRecord(rawOverride);
    if (override.enabled !== true) continue;
    const sequences = new Map<NudgeCohortKey, ReadonlyMap<number, string>>();
    for (const [rawCohort, rawCohortValue] of Object.entries(asRecord(override.cohorts))) {
      if (!isNudgeCohortKey(rawCohort)) continue;
      // 주기 설정이 손상된 코호트는 전역이 매핑을 비워 적재를 막는다 — 오버라이드가 그 fail-closed 를 우회하면 안 된다.
      if (cadenceInvalidCohorts.has(rawCohort)) continue;
      const parsed = parseSequence(asRecord(rawCohortValue).sequence, COHORT_CEILINGS[rawCohort].maxSends);
      if (parsed.size > 0) sequences.set(rawCohort, parsed);
    }
    out.set(rawId, { enabled: true, sequences });
  }
  return out;
}
/**
 * 값이 **없으면** fallback, **있는데 망가졌으면** fail-closed(`whenInvalid`).
 *
 * 적대 리뷰 P1: 종전 `boundedInt` 는 둘을 구분하지 않아 `maxSends: "broken"` 이 천장(10)으로
 * 열렸다. 설정 오타가 발송을 **늘리는** 방향으로 실패하면 안 된다 — 그게 fail-closed 의 정의다.
 *
 * R1 P1-4: `Number()` 강제변환도 막는다. `true`→1 · `[10]`→10 · `"1.9"`→1 이 전부 유효값으로
 * 통과했다. **유한 정수 number 타입만** 수용한다 — 문자열 숫자조차 받지 않는다(설정은 JSON 이고
 * 숫자 필드는 숫자로 저장돼야 한다. 문자열을 관대하게 받으면 오타의 절반이 조용히 살아난다).
 */
function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  whenInvalid = 0,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return whenInvalid;
  }
  return Math.max(min, Math.min(value, max));
}

function isNudgeCohortKey(value: string): value is NudgeCohortKey {
  return (NUDGE_COHORT_KEYS as readonly string[]).includes(value);
}

/**
 * 회차 맵 파싱. 키는 "1".."N" 문자열이다.
 * - 정수가 아니거나 1 미만이거나 상한 초과 → 버린다(조용히 무시하지 않고 버려야 상한이 진짜 상한이다)
 * - templateKey 가 빈 문자열 → 미설정으로 본다
 */
function parseSequence(value: unknown, maxSends: number): Map<number, string> {
  const out = new Map<number, string>();
  const record = asRecord(value);
  for (const [rawSeq, rawKey] of Object.entries(record)) {
    // 적대 리뷰 P1: `Math.trunc(Number("1.9"))` 이 1 이 되어 오타 키가 유효 회차로 살아났다.
    //   회차 키는 **정확한 10진 정수 문자열**만 받는다. 애매하면 버린다.
    if (!/^\d+$/.test(rawSeq)) continue;
    const seq = Number(rawSeq);
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > maxSends) continue;
    // W72 [R1 P1-5①]: 문서 ID 로 못 쓰는 문자(`/` 등)를 여기서 버린다. 통과시키면 발송 시점에
    //   `doc("foo/bar")` 가 던지고 워커 루프가 통째로 멈춘다.
    const templateKey = asString(rawKey).trim();
    if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(templateKey) || templateKey === "." || templateKey === "..") continue;
    out.set(seq, templateKey);
  }
  return out;
}

/**
 * 0.6.110: **편집기용** 오버라이드 뷰 — 저장된 값 그대로(꺼진 것·전역이 꺼진 상태 포함). 발송 경로의
 * `programOverrides`(활성만, 전역 enabled/주기 게이트 통과분)와 다르다. 화면이 일시정지한 오버라이드를 잃지 않게 한다.
 */
export function parseProgramOverridesForEditor(
  value: unknown,
): Array<{ id: string; enabled: boolean; sequences: Map<NudgeCohortKey, Map<number, string>> }> {
  const out: Array<{ id: string; enabled: boolean; sequences: Map<NudgeCohortKey, Map<number, string>> }> = [];
  for (const [id, raw] of Object.entries(asRecord(value))) {
    if (!NUDGE_PROGRAM_OVERRIDE_KEY_RE.test(id)) continue;
    const override = asRecord(raw);
    const sequences = new Map<NudgeCohortKey, Map<number, string>>();
    for (const [cohort, cohortValue] of Object.entries(asRecord(override.cohorts))) {
      if (!isNudgeCohortKey(cohort)) continue;
      const parsed = parseSequence(asRecord(cohortValue).sequence, COHORT_CEILINGS[cohort].maxSends);
      if (parsed.size > 0) sequences.set(cohort, parsed);
    }
    out.push({ id, enabled: override.enabled === true, sequences });
  }
  return out;
}

export function parseNudgeSequenceConfig(
  record: Record<string, unknown> | null | undefined,
): NudgeSequenceConfig {
  const root = asRecord(record);
  // [헤세 2026-09-03] enabled 게이트 **밖**에서 파싱한다 — dailyCap 과 같은 이유다: enabled=false 는
  //   "새로 적재하지 않는다"는 뜻이지 "이미 큐에 있는 행의 배출을 멈춘다"는 뜻이 아니다. 이 값이
  //   enabled 안에 갇히면 스윕을 끄는 순간 합산 안전판까지 사라진다(드레인은 enabled 와 무관하게 돈다).
  const totalDailyCap = parseTotalDailyCap(root.totalDailyCap);
  if (root.enabled !== true) return { ...DISABLED, totalDailyCap };
  // W72 [R1 P1-4]: cadence 는 0 으로 닫으면 **쿨다운이 사라지는** 방향이라 fail-open 이다.
  //   손상 시에는 코호트를 통째로 비활성화하는 쪽으로 닫는다(아래 `cadenceInvalid`).
  const rootCadenceInvalid = root.cadenceDays !== undefined && root.cadenceDays !== null
    && !(typeof root.cadenceDays === "number" && Number.isInteger(root.cadenceDays) && root.cadenceDays >= 1);
  const cadenceDays = boundedInt(root.cadenceDays, NUDGE_DEFAULT_CADENCE_DAYS, 1, 365, NUDGE_DEFAULT_CADENCE_DAYS);
  const cohortsRecord = asRecord(root.cohorts);
  const cohorts = new Map<NudgeCohortKey, NudgeCohortConfig>();
  const cadenceInvalidCohorts = new Set<NudgeCohortKey>();
  for (const [rawKey, rawValue] of Object.entries(cohortsRecord)) {
    if (!isNudgeCohortKey(rawKey)) continue;
    const ceiling = COHORT_CEILINGS[rawKey];
    const cohortRecord = asRecord(rawValue);
    // 상한은 천장을 넘을 수 없다. 설정이 20 을 적어도 코호트2 는 10 이다.
    //   그리고 망가진 값은 천장이 아니라 0 으로 닫는다(적대 리뷰 P1).
    const maxSends = boundedInt(cohortRecord.maxSends, ceiling.maxSends, 0, ceiling.maxSends, 0);
    const sequence = parseSequence(cohortRecord.sequence, maxSends);
    // 일캡은 망가졌을 때 0 으로 닫으면 **이미 큐에 있는 행까지** 배출이 멈춘다(적재와 다른 축이다).
    //   그래서 여기만 예외로 코드 확정값으로 되돌린다 — 어느 경우에도 천장(250)을 넘지 않는다.
    const dailyCap = boundedInt(
      cohortRecord.dailyCap, ceiling.dailyCap, 0, ceiling.dailyCap, DEFAULT_LANE_DAILY_CAP,
    );
    const cohortCadenceInvalid = cohortRecord.cadenceDays !== undefined && cohortRecord.cadenceDays !== null
      && !(typeof cohortRecord.cadenceDays === "number" && Number.isInteger(cohortRecord.cadenceDays)
        && cohortRecord.cadenceDays >= 1);
    const cadenceInvalid = rootCadenceInvalid || cohortCadenceInvalid;
    if (cadenceInvalid) cadenceInvalidCohorts.add(rawKey);
    const cohortCadence = boundedInt(cohortRecord.cadenceDays, cadenceDays, 1, 365, cadenceDays);
    cohorts.set(rawKey, {
      cohort: rawKey,
      maxSends,
      cadenceDays: cohortCadence,
      dailyCap,
      // 리더 확정: 비소모 유예 상한은 레인 캡을 그대로 따른다.
      quotaDeferralCap: boundedInt(
        cohortRecord.quotaDeferralCap, dailyCap, 0, ceiling.dailyCap, DEFAULT_LANE_DAILY_CAP,
      ),
      // 실발송 여부는 **설정이 올릴 수 없다**. 코드 천장이 최종이다 —
      // W72-B2 이후 세 코호트 모두 라이브지만, 설정이 이 값을 뒤집는 경로는 여전히 없다.
      liveSend: ceiling.liveSend,
      // cadence 가 손상됐으면 매핑을 비워 적재를 막는다 — 캡(dailyCap)은 남겨 큐 배출은 계속한다.
      sequence: cadenceInvalid ? new Map<number, string>() : sequence,
    });
  }
  return cohorts.size === 0
    ? { ...DISABLED, totalDailyCap }
    : { enabled: true, cohorts, totalDailyCap, programOverrides: parseProgramOverrides(root.programOverrides, cadenceInvalidCohorts) };
}

/**
 * @param options.assumeEnabled W72F-R2 P1-6 — **재개 전 예고 전용.**
 *   `parseNudgeSequenceConfig` 는 `enabled !== true` 면 코호트를 아예 파싱하지 않고 DISABLED 를
 *   돌려준다(fail-closed 의 핵심). 그래서 읽은 뒤에 `enabled` 만 덮어써도 매핑은 빈 Map 이라
 *   "지금 켜면 무엇이 나가는가"를 산출할 수 없다 — 반드시 **파싱 입력**에서 켜야 한다.
 *
 *   이 옵션은 읽기 전용 예고에만 쓴다. 저장된 문서는 건드리지 않고, 적재/발송 경로는
 *   이 옵션 없이 호출하므로 킬스위치는 그대로 유효하다.
 */
export async function readNudgeSequenceConfig(
  options: { assumeEnabled?: boolean } = {},
): Promise<NudgeSequenceConfig> {
  try {
    const snapshot = await adminDb.doc(NUDGE_SEQUENCE_TEMPLATES_DOC_PATH).get();
    if (!snapshot.exists) return DISABLED;
    const raw = snapshot.data() as Record<string, unknown>;
    return parseNudgeSequenceConfig(
      options.assumeEnabled ? { ...raw, enabled: true } : raw,
    );
  } catch {
    return DISABLED;
  }
}

/**
 * 0.6.110: 이 수신자의 캠페인/프로그램에 **적용되는 오버라이드 ID** 를 돌려준다(없으면 빈 문자열).
 * `programKeys` 는 우선순위 순서(캠페인 ID → 프로그램 ID)다. 첫 번째로 "이 코호트에 매핑이 있는"
 * 활성 오버라이드가 이긴다.
 */
export function nudgeProgramOverrideIdFor(
  config: NudgeSequenceConfig,
  cohort: NudgeCohortKey,
  programKeys: readonly string[],
): string {
  if (!config.enabled) return "";
  for (const key of programKeys) {
    if (!key) continue;
    if (config.programOverrides.get(key)?.sequences.has(cohort)) return key;
  }
  return "";
}

/**
 * 회차에 매핑된 템플릿 키. 미설정이면 빈 문자열이고 호출부는 **적재하지 않는다**.
 * `programKeys` 를 생략하면(기존 호출부 전부) 전역 매핑만 본다 — 동작 불변.
 */
export function nudgeTemplateKeyForSequence(
  config: NudgeSequenceConfig,
  cohort: NudgeCohortKey,
  sequence: number,
  programKeys: readonly string[] = [],
): string {
  if (!config.enabled) return "";
  const cohortConfig = config.cohorts.get(cohort);
  if (!cohortConfig) return "";
  if (sequence < 1 || sequence > cohortConfig.maxSends) return "";
  const overrideId = nudgeProgramOverrideIdFor(config, cohort, programKeys);
  if (overrideId) return config.programOverrides.get(overrideId)?.sequences.get(cohort)?.get(sequence) ?? "";
  return cohortConfig.sequence.get(sequence) ?? "";
}

/** 미설정 회차 스킵 사유. 측정 가능해야 한다는 리더 요구의 정본 코드다. */
export const NUDGE_TEMPLATE_UNMAPPED_REASON = "nudge_template_unmapped";

/**
 * 드레인이 쓰는 레인 캡 설정. 설정 문서가 없거나 꺼져 있어도 **캡은 존재해야 한다** —
 * 캡이 0 이면 이미 적재된 행까지 멈춰 버리므로, 여기서는 리더 확정값을 그대로 돌려준다.
 * (적재를 막는 것은 `enabled` 이고, 캡은 적재된 것의 배출 속도를 정하는 별개 축이다.)
 */
export async function readNudgeLaneQuotaConfig(
  cohort: NudgeCohortKey,
): Promise<{ dailyCap: number; quotaDeferralCap: number }> {
  const config = await readNudgeSequenceConfig();
  const cohortConfig = config.cohorts.get(cohort);
  return {
    dailyCap: cohortConfig?.dailyCap ?? DEFAULT_LANE_DAILY_CAP,
    quotaDeferralCap: cohortConfig?.quotaDeferralCap ?? DEFAULT_LANE_DAILY_CAP,
  };
}

/**
 * [헤세 2026-09-03] 드레인이 쓰는 **합산** 배출 상한. 파싱이 이미 `enabled` 게이트 밖에서
 * `totalDailyCap` 을 처리하므로 여기서도 그대로 읽는다 — 설정이 꺼져 있어도 이미 적재된 행의
 * 배출은 계속돼야 하고(위 `readNudgeLaneQuotaConfig` 와 같은 원칙), 이 값이 null 이면 "이 축
 * 없음"이라 호출부가 무조건 통과시킨다(코호트별 캡만 적용).
 */
export async function readNudgeTotalDailyCap(): Promise<number | null> {
  const config = await readNudgeSequenceConfig();
  return config.totalDailyCap;
}

/**
 * W72 [R1 P1-3②]: mailPurpose → 코호트 매핑.
 *
 * 레인 캡을 드레인 안에서만 세면 **일반 `sendEmail` 콜러블에 같은 mailPurpose 를 실어 보내는 경로**가
 * 캡을 통째로 우회한다(전역 쿼터만 검사된다). 그래서 캡 판정을 쿼터 예약 트랜잭션으로 옮기고,
 * 그 트랜잭션이 이 표를 보고 레인 축을 세운다 — 발송 경로가 무엇이든 같은 원장을 소모한다.
 */
export const NUDGE_LANE_PURPOSE_TO_COHORT: Readonly<Record<string, NudgeCohortKey>> = {
  application_video_reminder: NUDGE_COHORT2_KEY,
  // W72-B2 [헤세 결정 2026-08-13]: 코호트1·3 이 라이브가 되면서 **자기 purpose 로 발송**한다.
  //   여기 없으면 레인 캡(250/일)이 그 발송에 붙지 않아 코호트1·3 이 캡 없이 나간다 —
  //   "레인캡 우회 금지"가 조용히 깨지는 지점이라 전환과 **같은 커밋에서** 등록한다.
  nudge_cohort1_read_no_reply: NUDGE_COHORT1_KEY,
  nudge_cohort3_unread_no_reply: NUDGE_COHORT3_KEY,
  // Task-100 F-6: 여기 없으면 레인 캡·nudge_total 합산이 이 purpose 에 붙지 않는다(위 코호트1·3
  //   주석과 같은 이유).
  resubmission_nudge: NUDGE_COHORT4_KEY,
};

export function isNudgeLaneMailPurpose(value: unknown): boolean {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(NUDGE_LANE_PURPOSE_TO_COHORT, value);
}

/**
 * 이 mailPurpose 가 독려 레인이면 일캡을, 아니면 null 을 돌려준다.
 * 설정이 없거나 읽기에 실패해도 **코드 확정값(250)** 으로 닫는다 — 캡이 사라지는 방향으로 실패하지 않는다.
 */
export async function readNudgeLaneDailyCapForPurpose(mailPurpose: unknown): Promise<number | null> {
  if (!isNudgeLaneMailPurpose(mailPurpose)) return null;
  const cohort = NUDGE_LANE_PURPOSE_TO_COHORT[mailPurpose as string];
  const { dailyCap } = await readNudgeLaneQuotaConfig(cohort);
  return dailyCap;
}
