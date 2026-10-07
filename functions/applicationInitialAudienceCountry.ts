// Flu — 지원서 **초기** 오디언스 국가(관측값)와 신고-국가 백필의 종결 정책.
//
// ■ 왜 신고값과 다른 필드인가 (리더 L2026-0810-42 결정 1)
//   `declaredPrimaryAudienceCountry` 는 *지원자가 말한 값*이다. 여기서 다루는 값은 *우리가 발굴
//   시점에 관측한 값*(채널 snippet.country 유래)이라 성격이 다르다. 같은 필드에 섞으면 화면과
//   하류 소비자가 "신고받았다"고 오해한다. 그래서 필드를 나누고, 값에 **출처와 권위**를 붙인다.
//   authority = "observed_not_declared" 는 장식이 아니라 계약이다:
//   **발송 국가 하드 게이트(타겟팅·억제)에는 이 값을 쓸 수 없다**(리더 결정 1). 하드 게이트는
//   declared 만 쓴다. 이 모듈은 게이트 판정 함수를 **제공하지 않는다** — 없는 함수는 오용될 수 없다.
//
// ■ 왜 이 모듈이 firebase-admin 을 import 하지 않는가
//   조회는 전부 주입(lookups)이다. 사다리 판정을 노드 레인에서 그대로 행위 테스트할 수 있어야 하고,
//   "어디서 읽는가"와 "무엇을 값으로 인정하는가"가 한 파일에 섞이면 후자가 검증 불가능해진다.
//
// ■ 실측 근거 (2026-08-10, artifacts/w63/)
//   관리 문서 71건 전건이 신고 국가 없음. 68건은 identity(fluCreatorId/portalCreatorId/channelId)가
//   **완전 공란**이라 신원 조인이 불가능하다. 유일하게 남은 키가 확인메일 아웃박스의
//   `recipientEmailHash`(sha256 전체, 원문은 발송 후 삭제됨)이고, 콜드메일 이력의 `emailHash` 가
//   같은 다이제스트의 앞 24자다. 이 해시 사다리로 31건이 국가를 얻는다(쿼리 경로 실측).
import { normalizedIsoAlpha2 } from "./applicationDeclaredAudienceCountry";
import { resolveCreatorCountryProjection } from "./creatorCountryProjection";

/** 이 값이 붙은 국가는 **관측**이지 신고가 아니다. 하드 게이트 금지의 표식. */
export const INITIAL_AUDIENCE_COUNTRY_AUTHORITY = "observed_not_declared" as const;

/** 이력 emailHash 는 sha256 전체가 아니라 앞 24자다(scpColdmailHistory 계약). */
export const COLDMAIL_EMAIL_HASH_LENGTH = 24;

export const INITIAL_AUDIENCE_COUNTRY_SOURCES = [
  "campaign_outreach",
  "candidate_pool",
  "campaign_candidates",
  "creators",
] as const;
export type InitialAudienceCountrySource = (typeof INITIAL_AUDIENCE_COUNTRY_SOURCES)[number];

export type InitialAudienceCountryEvidence = {
  readonly source: InitialAudienceCountrySource;
  /** 실제로 읽은 필드명. 화면 출처 라벨과 사후 감사용. */
  readonly sourceField: string;
  readonly sourceRef: string;
  /** 원문 이메일을 쓰지 않았다는 사실 자체를 계약에 남긴다. */
  readonly joinKey: "recipient_email_hash" | "identity";
  readonly resolvedAtIso: string;
  readonly authority: typeof INITIAL_AUDIENCE_COUNTRY_AUTHORITY;
  readonly countryDecision?: string;
  /** 소스끼리 값이 갈렸다. 조용히 고르지 않고 표시한다. */
  readonly conflict?: true;
  /** M2: 조회가 상한에 걸려 "본 것 중 최신"이었다. 전수 중 최신과 구분해 남긴다. */
  readonly sourceTruncated?: true;
};

export type InitialAudienceCountryMissReason =
  | "no_email_hash"
  | "no_source_match"
  | "source_country_absent";

export type InitialAudienceCountryResolution =
  | { readonly resolved: true; readonly code: string; readonly evidence: InitialAudienceCountryEvidence }
  | { readonly resolved: false; readonly reason: InitialAudienceCountryMissReason };

/** 사다리 1단: 아웃리치(발송 이력) — 발송 시점 국가 판정까지 함께 남아 있는 가장 두꺼운 근거. */
export type OutreachCountryFact = {
  readonly sourceRef: string;
  readonly country?: unknown;
  readonly creatorRegion?: unknown;
  readonly countryDecision?: unknown;
  readonly candidateRef?: unknown;
  /**
   * W63 2차 델타 M2: 조회가 상한에 걸려 **일부만 본 결과**인지. 조인 구현이 최신 1건을 고르지만,
   * "여러 발송 중 최신"과 "상한에 걸려 자른 것 중 최신"은 다른 사실이다 — 증거에 그대로 남긴다.
   */
  readonly truncated?: boolean;
};

/** 사다리 2단: 후보 풀(발굴 원천). */
export type CandidateCountryFact = {
  readonly sourceRef: string;
  readonly source: Extract<InitialAudienceCountrySource, "candidate_pool" | "campaign_candidates">;
  readonly creatorCountry?: unknown;
  readonly country?: unknown;
  readonly region?: unknown;
};

/**
 * 사다리 3단: creators.
 *
 * W63 2차 델타 [독립 MEDIUM]: 종전에는 여기서 필드 사다리(countryCode→country→region)를
 * **복제**했다. creators 국가 해석의 정본은 `creatorCountryProjection.ts` 하나여야 한다 —
 * 사본을 두면 같은 질문에 두 답이 생기고, 실제로 ZZ 처리가 정본과 갈렸다.
 * 그래서 문서 데이터를 **그대로** 넘기고 정본 해석기를 부른다.
 */
export type CreatorCountryFact = {
  readonly sourceRef: string;
  /** creators 문서 원본. 필드 선택은 정본 해석기가 한다. */
  readonly data: Record<string, unknown>;
};

export type InitialAudienceCountryLookups = {
  /** 확인메일 아웃박스가 남긴 sha256 전체 해시. 원문 이메일은 이 경로에 존재하지 않는다. */
  readonly recipientEmailHash: (applicationId: string) => Promise<string | null>;
  readonly outreachByEmailHash: (emailHash: string) => Promise<OutreachCountryFact | null>;
  readonly candidateByRef?: (candidateRef: string) => Promise<CandidateCountryFact | null>;
  readonly creatorByIdentity?: (identity: {
    readonly fluCreatorId: string | null;
    readonly channelId: string | null;
  }) => Promise<CreatorCountryFact | null>;
};

export type ResolveInitialAudienceCountryInput = {
  readonly applicationId: string;
  readonly identity?: { readonly fluCreatorId?: string | null; readonly channelId?: string | null };
  readonly nowIso: string;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** 이력 조인용 접두 해시. 길이를 계약 상수로 고정한다 — 24 를 리터럴로 흩뿌리면 한 곳만 바뀐다. */
export function coldmailEmailHashPrefix(fullSha256Hex: string): string {
  const normalized = text(fullSha256Hex).toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized.slice(0, COLDMAIL_EMAIL_HASH_LENGTH) : "";
}

const firstCountryField = (
  record: Record<string, unknown>,
  fields: readonly string[],
): { code: string; field: string } => {
  for (const field of fields) {
    const code = normalizedIsoAlpha2(record[field]);
    if (code) return { code, field };
  }
  return { code: "", field: "" };
};

/**
 * 초기 국가 사다리. **처음 맞은 하나에서 멈춘다** — 합의·투표·평균 없음.
 * 여러 소스가 값을 갖고 서로 다르면 상위 소스를 쓰되 `conflict: true` 를 남긴다(조용히 고르지 않는다).
 * 어디에서도 못 찾으면 **지어내지 않고** miss 사유를 돌려준다.
 */
export async function resolveInitialAudienceCountry(
  input: ResolveInitialAudienceCountryInput,
  lookups: InitialAudienceCountryLookups,
): Promise<InitialAudienceCountryResolution> {
  const nowIso = input.nowIso;
  const identity = {
    fluCreatorId: text(input.identity?.fluCreatorId) || null,
    channelId: text(input.identity?.channelId) || null,
  };

  const fullHash = text(await lookups.recipientEmailHash(input.applicationId)).toLowerCase();
  const prefix = coldmailEmailHashPrefix(fullHash);

  let outreach: OutreachCountryFact | null = null;
  if (prefix) outreach = await lookups.outreachByEmailHash(prefix);
  /**
   * W63 MINOR-1 [적대 재리뷰]: 이 표식은 종전에 **1단 성공 evidence 에만** 실렸다. 그런데 상한에
   * 걸린 조회가 고른 아웃리치에 국가가 없어 2·3단으로 내려간 경우가 오히려 표식이 가장 필요한
   * 자리다 — 전수를 봤다면 1단에서 다른 답이 나왔을 수 있고, 실제로 실린 값은 **잘린 선택의
   * 결과로 하위 단에서 얻은 값**이다. 그래서 사다리 전체가 이 사실을 들고 다닌다.
   */
  const sourceTruncatedMark = outreach?.truncated === true
    ? ({ sourceTruncated: true } as const)
    : ({} as const);

  // 1단 — 아웃리치
  if (outreach) {
    const found = firstCountryField(outreach as Record<string, unknown>, ["country", "creatorRegion"]);
    if (found.code) {
      const decision = text((outreach as Record<string, unknown>).countryDecision);
      return {
        resolved: true,
        code: found.code,
        evidence: {
          source: "campaign_outreach",
          sourceField: found.field,
          sourceRef: text(outreach.sourceRef),
          joinKey: "recipient_email_hash",
          resolvedAtIso: nowIso,
          authority: INITIAL_AUDIENCE_COUNTRY_AUTHORITY,
          ...(decision ? { countryDecision: decision } : {}),
          // M2: 상한에 걸린 조회였다면 "본 것 중 최신"임을 증거에 남긴다(사후 감사용).
          ...sourceTruncatedMark,
        },
      };
    }
  }

  // 2단 — 후보 풀(아웃리치가 국가를 안 들고 있을 때만 읽는다)
  const candidateRef = text(outreach?.candidateRef);
  if (candidateRef && lookups.candidateByRef) {
    const candidate = await lookups.candidateByRef(candidateRef);
    if (candidate) {
      const found = firstCountryField(candidate as Record<string, unknown>, ["creatorCountry", "country", "region"]);
      if (found.code) {
        return {
          resolved: true,
          code: found.code,
          evidence: {
            source: candidate.source,
            sourceField: found.field,
            sourceRef: text(candidate.sourceRef),
            joinKey: "recipient_email_hash",
            resolvedAtIso: nowIso,
            authority: INITIAL_AUDIENCE_COUNTRY_AUTHORITY,
            // MINOR-1: 이 후보 참조는 **잘린 선택으로 고른 아웃리치 행**에서 왔다 — 파생값도 같은 표식을 단다.
            ...sourceTruncatedMark,
          },
        };
      }
    }
  }

  // 3단 — creators(신원이 있는 소수 경로). 실측 3/71 이지만 v3 인테이크 유입에는 이게 정상 경로다.
  if ((identity.fluCreatorId || identity.channelId) && lookups.creatorByIdentity) {
    const creator = await lookups.creatorByIdentity(identity);
    if (creator) {
      // 필드 사다리는 **정본 해석기**가 답한다(사본 금지). 다만 "무엇을 국가로 승격하는가"는
      // 신고 경로와 같은 규칙을 쓴다 — 정본 해석기는 표시용이라 ZZ(미상)도 통과시키는데,
      // 이 축은 신고 경로와 마찬가지로 ZZ 를 국가로 만들지 않는다.
      const projected = resolveCreatorCountryProjection(creator.data);
      const code = normalizedIsoAlpha2(projected.code);
      if (code && projected.sourceField) {
        return {
          resolved: true,
          code,
          evidence: {
            source: "creators",
            sourceField: projected.sourceField,
            sourceRef: text(creator.sourceRef),
            joinKey: "identity",
            resolvedAtIso: nowIso,
            authority: INITIAL_AUDIENCE_COUNTRY_AUTHORITY,
            // MINOR-1: 조인 키는 identity 지만, **여기까지 내려온 이유**가 잘린 선택일 수 있다
            //   (전수를 봤다면 1단이 답했을 수도 있다). 그 가능성을 값과 함께 들고 다닌다.
            ...sourceTruncatedMark,
          },
        };
      }
    }
  }

  if (!prefix) return { resolved: false, reason: "no_email_hash" };
  if (!outreach) return { resolved: false, reason: "no_source_match" };
  return { resolved: false, reason: "source_country_absent" };
}

// ---- 신고-국가 백필 종결 정책 (리더 L2026-0810-42 결정 2) ----------------------------------------
//
// 실측: `no_intake_material` 70건 전건이 **인테이크 영수증 포인터 자체 부재**다. v1 커맨드 경로로
// 들어온 지원서라 영수증이 생길 수 없고, 그 경로의 보호자재 계약에는 국가 필드가 아예 없다.
// 그런데 재시도 루프는 이 70건을 attempts 5~17회까지 계속 재방문했다 — **종료 조건이 없었다.**
// 종결은 "영원히 포기"가 아니라 "새 사실이 오기 전까지 재방문 금지"다. 그래서 재검토 주기를 둔다.

/** 인테이크 영수증 해석의 하위 사실. 종전에는 다섯 사실이 `no_intake_material` 한 이름으로 접혔다. */
export const INTAKE_MATERIAL_CASES = [
  "resolvable",
  "app_pointer_absent",
  "last_event_id_absent",
  "event_absent",
  "effect_state_pending",
  "receipt_fields_malformed",
  /** 하위 사유를 알 수 없는 경로(구 계약 로더 주입 등). **모르는 것은 종결 근거가 아니다.** */
  "unknown_absent",
] as const;
export type IntakeMaterialCase = (typeof INTAKE_MATERIAL_CASES)[number];

/**
 * 이 사유로 실패했으면 기다려도 달라지지 않는다(영수증이 생길 수 없거나 이미 깨졌다).
 * W63 2차 델타 M1: 목록을 손으로 두 번 쓰지 않는다 — 아래 사유 매핑에서 **유도**한다.
 * 두 벌이 어긋나면 "결정적이라 종결했는데 사유가 없다" 같은 상태가 생긴다.
 */

/**
 * 종결 사유는 **"왜 신고값이 영원히 안 오는가"** 하나만 서술한다.
 *
 * W63 2차 델타 M1 [적대 리뷰 실측]: 종전 구현은 이 필드에 **관측 조회 결과**를 담았다
 * (`no_source_material` = 이메일 해시 없음, `source_country_absent` = 아웃리치에 국가 없음).
 * 그래서 영수증이 **손상**된 문서(receipt_fields_malformed)가 `no_source_material` 로 라벨돼
 * **손상 사실 자체가 은폐**됐다 — 운영자는 "원천이 없구나"로 읽고 대장을 들여다보지 않는다.
 * 더 나쁘게, 그 틀린 값이 테스트에 정답으로 못박혀 뮤테이션도 못 잡았다.
 * 오늘 하루에만 네 번째 재발한 **"틀린 사유는 없는 사유보다 비싸다"** 클래스다.
 *
 * 두 축을 분리한다:
 *   · 이 필드(terminalReason) = 신고 축. intakeCase 에서 **유도**한다(문자열을 손으로 고르지 않는다).
 *   · 관측 축의 실패 사유는 `InitialAudienceCountryMissReason` 으로 **따로** 기록한다.
 */
export const DECLARED_COUNTRY_TERMINAL_REASONS = [
  /** 영수증 포인터/이벤트가 아예 없다 — 만들어질 수 없는 상태. */
  "intake_receipt_absent",
  /** 영수증은 있는데 계약 필드가 깨졌다 — 기다려도 안 고쳐지고, **대장을 봐야 한다**. */
  "intake_receipt_malformed",
] as const;
export type DeclaredCountryTerminalReason = (typeof DECLARED_COUNTRY_TERMINAL_REASONS)[number];

/** intakeCase → 종결 사유. 결정적이지 않은 사유는 종결 자체가 없으므로 여기에 없다. */
const TERMINAL_REASON_BY_INTAKE_CASE: Readonly<Partial<Record<IntakeMaterialCase, DeclaredCountryTerminalReason>>> =
  Object.freeze({
    app_pointer_absent: "intake_receipt_absent",
    last_event_id_absent: "intake_receipt_absent",
    event_absent: "intake_receipt_absent",
    receipt_fields_malformed: "intake_receipt_malformed",
  });

/** 위 매핑에서 유도한다(사본 금지 — §DETERMINISTIC_INTAKE_CASES 주석 참조). */
export const DETERMINISTIC_INTAKE_CASES: readonly IntakeMaterialCase[] =
  Object.freeze(Object.keys(TERMINAL_REASON_BY_INTAKE_CASE) as IntakeMaterialCase[]);

/**
 * 결정적 실패는 제출 후 유예(기본 24시간)가 지난 뒤에만 종결한다.
 * 유예가 없으면 **방금 들어온 지원서**가 인테이크 커밋 직전 스냅샷 한 번으로 종결될 수 있다.
 */
export const DECLARED_COUNTRY_TERMINAL_GRACE_MS = 24 * 60 * 60 * 1000;
/** 종결 후 재검토 주기. "새 사실이 오면 해제"를 비용 한계 안에서 실현하는 장치다. */
export const DECLARED_COUNTRY_TERMINAL_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type TerminalDecisionInput = {
  readonly intakeCase: IntakeMaterialCase;
  readonly submittedAtIso: string | null;
  readonly nowMs: number;
  readonly graceMs?: number;
};

/**
 * 종결할 것인가. **관측 국가를 찾았는지와 완전히 무관하다** — 재시도가 노리는 값은 신고값이고,
 * 관측값은 그 대체물이 아니라 다른 축이다. 관측 조회가 실패해도(또는 아예 못 돌아도) 신고 축의
 * 결정적 부재는 그대로 결정적이다.
 */
export function resolveDeclaredCountryTerminal(
  input: TerminalDecisionInput,
): { readonly terminal: true; readonly terminalReason: DeclaredCountryTerminalReason } | null {
  const terminalReason = TERMINAL_REASON_BY_INTAKE_CASE[input.intakeCase];
  // 매핑에 없는 사유(진행 중·미상)는 결정적이지 않다 — 목록 두 벌이 어긋날 여지를 없앤다.
  if (!terminalReason) return null;

  const submittedAtMs = Date.parse(text(input.submittedAtIso ?? ""));
  const graceMs = input.graceMs ?? DECLARED_COUNTRY_TERMINAL_GRACE_MS;
  // 제출 시각을 못 읽으면 유예를 적용할 수 없다 → 종결하지 않는다(모호할 때 재시도 쪽이 안전하다).
  if (!Number.isFinite(submittedAtMs)) return null;
  if (input.nowMs - submittedAtMs < graceMs) return null;

  return { terminal: true, terminalReason };
}

export type BackfillEligibilityInput = {
  readonly hasDeclaredCountry: boolean;
  readonly attemptAtIso: string | null;
  readonly attempts: number;
  readonly terminal: boolean;
  readonly terminalAtIso: string | null;
  readonly nowMs: number;
  readonly backoffMs: (attempts: number) => number;
  readonly reviewIntervalMs?: number;
};

/**
 * 후보 산정. 종전 계약("declared 없음 ∧ (마커 없음 ∨ 백오프 경과)")에 종결 축을 얹는다.
 * 종결된 문서는 **재검토 주기가 지나야** 다시 후보가 된다 — 그 한 번의 재방문이 "새 사실 도착"을
 * 발견하는 자리다(확인메일 발송으로 해시가 생겼거나, v3 영수증이 뒤늦게 도착했거나).
 * 종결 시각을 못 읽으면 fail-open 으로 후보에 넣는다(영구 봉쇄보다 재시도가 안전하다).
 */
export function isDeclaredCountryBackfillCandidate(input: BackfillEligibilityInput): boolean {
  if (input.hasDeclaredCountry) return false;
  if (input.terminal) {
    const terminalAtMs = Date.parse(text(input.terminalAtIso ?? ""));
    if (!Number.isFinite(terminalAtMs)) return true;
    const reviewIntervalMs = input.reviewIntervalMs ?? DECLARED_COUNTRY_TERMINAL_REVIEW_INTERVAL_MS;
    return input.nowMs - terminalAtMs >= reviewIntervalMs;
  }
  const attemptAtMs = Date.parse(text(input.attemptAtIso ?? ""));
  if (!input.attemptAtIso) return true;
  if (!Number.isFinite(attemptAtMs)) return true;
  const attempts = Number.isFinite(input.attempts) && input.attempts > 0 ? input.attempts : 1;
  return input.nowMs - attemptAtMs >= input.backoffMs(attempts);
}
