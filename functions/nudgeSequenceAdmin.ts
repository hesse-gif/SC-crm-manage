// W72 C-1 — 코호트 × 회차 문안 매핑 편집 콜러블 (검수 > 메일 템플릿)
//
// ■ 왜 별도 모듈인가
//   `nudgeSequenceTemplates.ts` 는 **발송 경로가 읽는 순수 파서**다. 거기에 쓰기(관리자 콜러블)를
//   섞으면 발송 판정 코드가 RBAC·감사와 얽혀 읽기 어려워진다. 파서는 그대로 두고 편집만 여기서 한다.
//
// ■ 화면이 값을 지어내지 못하게 한다
//   상한(3/10/5)·레인 캡·실발송 여부는 **코드 천장**이 최종이다(nudgeSequenceTemplates COHORT_CEILINGS).
//   조회 응답에 그 천장을 함께 실어서 화면이 자기 상수를 복제하지 않게 한다 — 복제하면 한쪽만
//   바뀌었을 때 화면과 서버가 다른 말을 한다.
//
// ■ 저장은 파서를 한 번 통과시킨 뒤 저장한다
//   저장 직전에 `parseNudgeSequenceConfig` 로 정규화해서, **저장된 문서가 곧 발송이 읽을 값**이 되게
//   한다. 화면이 보낸 그대로 저장하면 "저장은 됐는데 발송은 무시하는" 값이 생긴다.

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  type CallableRequestShape,
} from "./shared";
import {
  NUDGE_COHORT_KEYS,
  NUDGE_COHORT1_KEY,
  NUDGE_COHORT2_KEY,
  NUDGE_COHORT3_KEY,
  NUDGE_PROGRAM_OVERRIDE_KEY_RE,
  NUDGE_SEQUENCE_TEMPLATES_DOC_PATH,
  // [헤세 2026-09-03] 세 코호트 합산 배출 상한.
  NUDGE_TOTAL_DAILY_CAP_CEILING,
  nudgeCohortCeilings,
  parseNudgeSequenceConfig,
  parseProgramOverridesForEditor,
  type NudgeCohortKey,
} from "./nudgeSequenceTemplates";
// W72-C2: 대상 판정 정본. 화면과 스윕이 같은 함수를 쓴다(복제 금지).
import { listNudgeCohortCandidates } from "./nudgeCohortSweep";
import { assertScpEntitled } from "./mailAccounts";
import { isNudgeDraftMailTemplateKind, nudgeDraftMailTemplateBaseKind } from "./scpReceiptMailTemplates";
import { SETTINGS_AUDIT_COLLECTION } from "./settings";

const TEMPLATE_COLLECTION = "scp_mail_templates";
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

export type NudgeSequenceAdminCohortView = {
  readonly cohort: NudgeCohortKey;
  readonly maxSends: number;
  readonly cadenceDays: number;
  readonly dailyCap: number;
  readonly liveSend: boolean;
  /** 회차 → 템플릿 키. 미설정 회차는 **빈 문자열**이다(0 이 아니라 "없음"이다). */
  readonly sequence: Record<string, string>;
};

export type NudgeSequenceAdminEnvelope = {
  readonly ok: true;
  readonly enabled: boolean;
  readonly cadenceDays: number;
  readonly cohorts: NudgeSequenceAdminCohortView[];
  /** 매핑에 고를 수 있는 템플릿 키. `active` 발행 문서만 실제 발송에 쓰인다. */
  readonly templateOptions: Array<{ key: string; status: string; sendable: boolean }>;
  readonly docPath: string;
  readonly updatedAtIso: string;
  readonly actorRole: string;
  /** [헤세 2026-09-03] 세 코호트 합산 배출 상한. null = 미설정(코호트별 캡만 적용). */
  readonly totalDailyCap: number | null;
  /** 화면이 상한을 지어내지 않게 코드 천장을 그대로 실어 보낸다(코호트별 천장과 같은 원칙). */
  readonly totalDailyCapCeiling: number;
  /** 0.6.110: 프로그램/캠페인별 문안 매핑 오버라이드(활성만 파서를 통과한 값). */
  readonly programOverrides: NudgeProgramOverrideView[];
  /** 0.6.110: 오버라이드를 걸 수 있는 프로그램/캠페인 후보(선택기용). 직접 입력도 서버가 검증한다. */
  readonly programOptions: Array<{ id: string; label: string; kind: "program" | "campaign" }>;
};

export type NudgeProgramOverrideView = {
  readonly id: string;
  /** 저장된 활성 여부(꺼진 오버라이드도 편집기에 남는다). */
  readonly enabled: boolean;
  /** 코호트 → 회차 → 템플릿 키. */
  readonly cohorts: Record<string, Record<string, string>>;
};

/** 오버라이드가 지원하는 코호트(코호트4 재제출 독려는 별도 발송기라 제외). */
const OVERRIDE_COHORTS = [NUDGE_COHORT1_KEY, NUDGE_COHORT2_KEY, NUDGE_COHORT3_KEY] as const;
const OVERRIDE_COHORT_BASE_KIND: Record<(typeof OVERRIDE_COHORTS)[number], string> = {
  [NUDGE_COHORT1_KEY]: "scp_nudge_cohort1_read_no_reply_en",
  [NUDGE_COHORT2_KEY]: "scp_nudge_cohort2_applied_no_video_en",
  [NUDGE_COHORT3_KEY]: "scp_nudge_cohort3_unread_no_reply_en",
};
const OVERRIDE_WRITE_ROLES = ["super_admin", "admin"] as const;

/** 코드 폴백이 있는 내장 kind — 발행 문서가 없어도 발송된다(W72 R2-1). */
const BUILT_IN_SENDABLE_KEYS = new Set(["application_video_reminder"]);

export async function getScpNudgeSequenceConfig(
  request: CallableRequestShape,
): Promise<NudgeSequenceAdminEnvelope> {
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): NOT gated by
  // assertScpEntitled — settings/nudge_sequence_templates is a global (not per-org) admin config
  // also edited from the Admin workspace's general mail controls card
  // (src/app/(app)/admin/MailAdminControlsCard.tsx), which any admin/super_admin may reach
  // regardless of their own org's scp mailbox entitlement.
  const auth = assertNonGuestAuth(request, "nudge_sequence.get");
  const snapshot = await adminDb.doc(NUDGE_SEQUENCE_TEMPLATES_DOC_PATH).get();
  const raw = snapshot.exists ? (snapshot.data() ?? {}) : {};
  const parsed = parseNudgeSequenceConfig(raw as Record<string, unknown>);
  const ceilings = nudgeCohortCeilings();
  // W72 합동리뷰 P1-2: 저장된 주기 정본. 파서를 통과한 코호트 값이 있으면 그것을, 없으면
  //   루트 값을, 둘 다 없을 때만 기본 7 이다. 응답이 이 값을 그대로 실어야 왕복이 안정된다.
  const rootCadenceRaw = Math.trunc(Number((raw as Record<string, unknown>).cadenceDays));
  const storedCadenceDays = [...parsed.cohorts.values()][0]?.cadenceDays
    ?? (Number.isSafeInteger(rootCadenceRaw) && rootCadenceRaw >= 1 ? rootCadenceRaw : 7);

  const templates = await adminDb.collection(TEMPLATE_COLLECTION).get();
  const templateOptions = templates.docs.map((doc) => {
    const status = asString((doc.data() ?? {}).status);
    return { key: doc.id, status: status || "(없음)", sendable: status === "active" };
  });
  for (const key of BUILT_IN_SENDABLE_KEYS) {
    if (!templateOptions.some((option) => option.key === key)) {
      // 발행 문서가 없어도 코드 폴백으로 나가는 키다. 목록에서 빼면 화면이 "고를 수 없는 기본값"을
      // 보여주게 되고, 지금 프로드가 정확히 그 상태다(문서 0건).
      templateOptions.push({ key, status: "코드 기본값", sendable: true });
    }
  }
  templateOptions.sort((left, right) => left.key.localeCompare(right.key));

  // 0.6.110 integration review (Codex MEDIUM): global program/campaign options are super_admin-only — org-scoped callers must not enumerate other orgs.
  const isSuperAdmin = auth.role === "super_admin";
  const programOverrides: NudgeProgramOverrideView[] = (isSuperAdmin ? parseProgramOverridesForEditor(
    (raw as Record<string, unknown>).programOverrides,
  ) : [])
    .map((override) => ({
      id: override.id,
      enabled: override.enabled,
      cohorts: Object.fromEntries(
        [...override.sequences.entries()].map(([cohort, sequence]) => [
          cohort,
          Object.fromEntries([...sequence.entries()].map(([index, key]) => [String(index), key])),
        ]),
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const programOptions = isSuperAdmin ? await listProgramOverrideOptions() : [];

  const cohorts = NUDGE_COHORT_KEYS.map((cohort) => {
    const config = parsed.cohorts.get(cohort);
    const ceiling = ceilings[cohort];
    const sequence: Record<string, string> = {};
    const maxSends = config?.maxSends ?? ceiling.maxSends;
    for (let index = 1; index <= ceiling.maxSends; index += 1) {
      sequence[String(index)] = config?.sequence.get(index) ?? "";
    }
    return {
      cohort,
      maxSends,
      cadenceDays: config?.cadenceDays ?? storedCadenceDays,
      dailyCap: config?.dailyCap ?? ceiling.dailyCap,
      liveSend: ceiling.liveSend,
      sequence,
    };
  });

  return {
    ok: true,
    enabled: parsed.enabled,
    // W72 합동리뷰 P1-2: 여기가 `7` 하드코딩이었다. 화면이 이 값을 저장 상태로 재사용하므로,
    //   14일로 저장해 둔 뒤 다른 매핑만 바꿔 저장하면 주기가 7일로 덮였다 —
    //   **라이브 코호트2 의 발송 주기가 2배로 가속되는 축**이다. 저장된 정본을 그대로 돌려준다.
    cadenceDays: storedCadenceDays,
    cohorts,
    templateOptions,
    docPath: NUDGE_SEQUENCE_TEMPLATES_DOC_PATH,
    updatedAtIso: asString((raw as Record<string, unknown>).updatedAtIso),
    actorRole: auth.role,
    totalDailyCap: parsed.totalDailyCap,
    totalDailyCapCeiling: NUDGE_TOTAL_DAILY_CAP_CEILING,
    programOverrides,
    programOptions,
  };
}

async function listProgramOverrideOptions(): Promise<NudgeSequenceAdminEnvelope["programOptions"]> {
  const [programs, campaigns] = await Promise.all([
    adminDb.collection("programs").select("title").limit(100).get(),
    adminDb.collection("campaigns").select("name").limit(200).get(),
  ]);
  return [
    ...programs.docs.map((doc) => ({
      id: doc.id, label: asString(doc.data()?.title) || doc.id, kind: "program" as const,
    })),
    ...campaigns.docs.map((doc) => ({
      id: doc.id, label: asString(doc.data()?.name) || doc.id, kind: "campaign" as const,
    })),
  ].filter((option) => NUDGE_PROGRAM_OVERRIDE_KEY_RE.test(option.id));
}

function parseTotalDailyCapForSave(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (
    typeof input !== "number"
    || !Number.isFinite(input)
    || !Number.isInteger(input)
  ) {
    throw Object.assign(
      new Error("전체 일 발송 상한은 정수여야 합니다."),
      { code: "invalid-argument", errorCode: "nudge_total_daily_cap_invalid" },
    );
  }
  if (input < 0 || input > NUDGE_TOTAL_DAILY_CAP_CEILING) {
    throw Object.assign(
      new Error(`전체 일 발송 상한은 0~${NUDGE_TOTAL_DAILY_CAP_CEILING} 사이여야 합니다.`),
      { code: "invalid-argument", errorCode: "nudge_total_daily_cap_out_of_range" },
    );
  }
  return input;
}

function parseNudgeCohortDailyCapsForSave(input: unknown): Partial<Record<NudgeCohortKey, number>> {
  const record = asRecord(input);
  const caps: Partial<Record<NudgeCohortKey, number>> = {};
  const ceilings = nudgeCohortCeilings();
  for (const cohort of NUDGE_COHORT_KEYS) {
    const value = record[cohort];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw Object.assign(
        new Error("독려 코호트 일 상한은 정수여야 합니다."),
        { code: "invalid-argument", errorCode: "nudge_cohort_daily_cap_invalid" },
      );
    }
    if (value < 0 || value > ceilings[cohort].dailyCap) {
      throw Object.assign(
        new Error(`독려 코호트 일 상한은 0~${ceilings[cohort].dailyCap} 사이여야 합니다.`),
        { code: "invalid-argument", errorCode: "nudge_cohort_daily_cap_out_of_range" },
      );
    }
    caps[cohort] = value;
  }
  return caps;
}

/**
 * [2026-09-17 운영 사고 수리] cap-only 저장이 실제로 Firestore 에 쓰는 patch 를 만든다.
 *
 * 근인: `transaction.set(ref, { cohorts: capPatch, ... }, { merge: true })` 에서 `capPatch`
 * 가 **빈 객체**(코호트별 캡을 하나도 안 바꾸는 저장)면, Firestore merge 는 "손댈 leaf 가 없다"가
 * 아니라 "`cohorts` 필드를 빈 맵으로 덮어써라"로 해석한다 — merge 는 **값으로 존재하는 하위 키만**
 * 보존하는데, 빈 맵에는 하위 키가 없어서 전체를 지운다. 그 결과로 세 코호트의 회차 매핑이
 * 전부 사라져 독려 레인이 조용히 꺼졌다(약 3.5시간, 수동 복구).
 *
 * 수리: 캡 맵이 비어 있으면 `cohorts` 키를 **아예 patch 에 넣지 않는다**(필드를 안 건드린다 —
 * merge 는 patch 에 없는 필드는 그대로 둔다). 비어 있지 않을 때는 `cohorts` 를 **터치하는
 * 코호트만 담은 중첩 객체**로 쓴다(각 코호트 값도 `dailyCap`/`quotaDeferralCap` 두 leaf 뿐,
 * `sequence`/`maxSends` 는 안 넣는다) — Firestore merge 는 **값으로 존재하는 비어있지 않은
 * 중첩 맵**은 그 안의 leaf 만 갱신하고 형제 필드는 보존한다(빈 것은 다르다: 그게 근인이었다).
 * 도트 경로 문자열 키(`"cohorts.x.dailyCap"`)는 여기서 쓰지 않는다 — 그건 `update()` 에서만
 * 중첩 경로로 해석되고 `set(..., {merge:true})` 에서는 점이 든 **문자 그대로의 필드명**이
 * 되어 조용히 아무것도 안 바꾼다(직접 확인: 에뮬레이터 라운드트립이 캡이 반영 안 되는 걸로 잡아냄).
 */
export function buildNudgeTotalDailyCapPatch(
  totalDailyCap: number | null,
  cohortDailyCaps: Partial<Record<NudgeCohortKey, number>>,
  updatedBy: string,
  nowIso: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    totalDailyCap,
    updatedBy,
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
  const cohortEntries = Object.entries(cohortDailyCaps);
  if (cohortEntries.length > 0) {
    patch.cohorts = Object.fromEntries(
      cohortEntries.map(([cohort, dailyCap]) => [cohort, { dailyCap, quotaDeferralCap: dailyCap }]),
    );
  }
  return patch;
}

/**
 * 저장이 "이미 회차가 매핑돼 있던 코호트"를 조용히 빈 매핑으로 되돌리면 안 된다. 단, 운영자가
 * 그 코호트를 **요청에서 명시적으로 건드렸다면**(예: 전체 초기화로 일부러 비움) 그건 의도한
 * 동작이라 막지 않는다 — 막아야 하는 건 "요청이 그 코호트를 언급도 안 했는데 결과적으로
 * 비워지는" 경우뿐이다(cap-only 사고, 그리고 전체 저장이 요청에 없는 코호트 키를 빈 값으로
 * 채워 덮어쓰는 잠재 케이스 둘 다를 이 한 가드로 막는다).
 */
export function assertCohortSequencesNotDropped(
  beforeCohorts: Record<string, unknown>,
  afterCohorts: Record<string, unknown>,
  explicitlyTouchedCohorts: ReadonlySet<string>,
): void {
  const dropped: string[] = [];
  for (const cohort of NUDGE_COHORT_KEYS) {
    if (explicitlyTouchedCohorts.has(cohort)) continue;
    const hadSequence = Object.keys(asRecord(asRecord(beforeCohorts[cohort]).sequence)).length > 0;
    if (!hadSequence) continue;
    const willHaveSequence = Object.keys(asRecord(asRecord(afterCohorts[cohort]).sequence)).length > 0;
    if (!willHaveSequence) dropped.push(cohort);
  }
  if (dropped.length > 0) {
    throw Object.assign(
      new Error(`저장이 요청하지 않은 코호트의 회차 매핑을 지웁니다: ${dropped.join(", ")}. 다시 불러온 뒤 저장하세요.`),
      { code: "failed-precondition", errorCode: "nudge_sequence_cohorts_would_be_dropped" },
    );
  }
}

export async function saveScpNudgeSequenceConfig(request: CallableRequestShape) {
  // 매핑을 바꾸는 것은 **무엇이 발송되는지**를 바꾸는 것이다. 발송 콜러블과 같은 권한대를 쓴다.
  // 2026-09-27 codex adversarial review round 2 FAIL-3: this function is split into two branches
  // below by data.totalDailyCapOnly — only the FULL cadence/sequence-mapping branch is gated by
  // assertScpEntitled (see its own comment further down); the shared totalDailyCapOnly branch
  // stays ungated (same reason getScpNudgeSequenceConfig above does).
  const auth = assertNonGuestAuth(request, "nudge_sequence.save", [...WRITE_ROLES]);
  const data = asRecord(request.data);
  const totalDailyCap = parseTotalDailyCapForSave(data.totalDailyCap);

  if (data.totalDailyCapOnly === true) {
    const expectedUpdatedAtIso = asString(data.expectedUpdatedAtIso);
    const cohortDailyCaps = parseNudgeCohortDailyCapsForSave(data.cohortDailyCaps);
    const nowIso = new Date().toISOString();
    const result = await adminDb.runTransaction(async (transaction) => {
      const ref = adminDb.doc(NUDGE_SEQUENCE_TEMPLATES_DOC_PATH);
      const snapshot = await transaction.get(ref);
      const raw = snapshot.exists ? (snapshot.data() ?? {}) : {};
      const currentUpdatedAtIso = asString((raw as Record<string, unknown>).updatedAtIso);
      if (currentUpdatedAtIso !== expectedUpdatedAtIso) {
        throw Object.assign(
          new Error("다른 운영자가 먼저 독려 설정을 변경했습니다. 다시 불러온 뒤 저장하세요."),
          { code: "aborted", errorCode: "nudge_sequence_total_daily_cap_stale" },
        );
      }
      const currentCohorts = asRecord((raw as Record<string, unknown>).cohorts);
      const capPatch = Object.fromEntries(
        Object.entries(cohortDailyCaps).map(([cohort, dailyCap]) => [cohort, { dailyCap, quotaDeferralCap: dailyCap }]),
      );
      const nextCohorts = Object.fromEntries(
        NUDGE_COHORT_KEYS.map((cohort) => [cohort, {
          ...asRecord(currentCohorts[cohort]),
          ...asRecord(capPatch[cohort]),
        }]),
      );
      const nextRaw = {
        ...raw,
        cohorts: { ...currentCohorts, ...nextCohorts },
        totalDailyCap,
        updatedBy: `callable:${auth.role}`,
        updatedAtIso: nowIso,
      };
      const parsed = parseNudgeSequenceConfig(nextRaw as Record<string, unknown>);
      const mappedSequences = [...parsed.cohorts.values()]
        .reduce((total, cohort) => total + cohort.sequence.size, 0);
      // [적대 리뷰 LOW-6] cap-only 저장은 sequence 를 절대 건드리지 않는다 — 이전에는 여기서
      // 드롭 가드 함수(아래 정의부 참고)를 before/after 양쪽에 같은 currentCohorts 참조로 불렀는데,
      // 그러면 dropped 판정이 절대 비지 않을 수 없는 no-op 였다. 실제 보호는 아래
      // buildNudgeTotalDailyCapPatch 가 cohortDailyCaps 가 비어 있으면 patch.cohorts 필드 자체를
      // 만들지 않는다는 것(merge:true 라 기존 cohorts.*.sequence 를 건드리지 않음) —
      // patch-builder 정의부 주석 참고.
      transaction.set(
        ref,
        buildNudgeTotalDailyCapPatch(totalDailyCap, cohortDailyCaps, `callable:${auth.role}`, nowIso),
        { merge: true },
      );
      return { ok: true, enabled: parsed.enabled, mappedSequences, updatedAtIso: nowIso, totalDailyCap: parsed.totalDailyCap };
    });
    return result;
  }

  // 2026-09-27 codex adversarial review round 2 FAIL-3: only the FULL cadence/sequence mapping
  // below is scp-exclusive (its only reachable UI is NudgeSequenceMappingCard.tsx, rendered
  // inside /flu/scp) — the totalDailyCapOnly branch above is a shared operational cap also edited
  // from the general Admin workspace's MailAdminControlsCard.tsx (same reason
  // getScpNudgeSequenceConfig above stays ungated), so gating it would break that general screen.
  await assertScpEntitled(auth, request, "nudge_sequence.save");
  const cohortsInput = asRecord(data.cohorts);
  const ceilings = nudgeCohortCeilings();

  const cohorts: Record<string, unknown> = {};
  for (const cohort of NUDGE_COHORT_KEYS) {
    const input = asRecord(cohortsInput[cohort]);
    const ceiling = ceilings[cohort];
    const sequenceInput = asRecord(input.sequence);
    const sequence: Record<string, string> = {};
    for (let index = 1; index <= ceiling.maxSends; index += 1) {
      const key = asString(sequenceInput[String(index)]).trim();
      // 빈 값은 **키를 만들지 않는다**. `""` 로 저장하면 파서가 버리긴 하지만, 문서에 남으면
      // "설정했는데 안 나간다"로 읽혀 운영자가 원인을 엉뚱한 데서 찾는다.
      if (key) sequence[String(index)] = key;
    }
    cohorts[cohort] = {
      maxSends: ceiling.maxSends,
      dailyCap: ceiling.dailyCap,
      quotaDeferralCap: ceiling.dailyCap,
      sequence,
    };
  }

  const cadenceDays = Math.trunc(Number(data.cadenceDays));
  // [헤세 2026-09-03] 세 코호트 합산 상한. null/미기입 = 무제한(이 축 없음, 코호트별 캡만 적용).
  //   숫자 필드는 강제변환을 받지 않는다(파서와 같은 원칙 — 문자열 "200" 등은 오타 방어를 위해 거절).

  const nowIso = new Date().toISOString();
  const document = {
    enabled: data.enabled === true,
    cadenceDays: Number.isSafeInteger(cadenceDays) && cadenceDays >= 1 ? cadenceDays : 7,
    cohorts,
    totalDailyCap,
    updatedBy: `callable:${auth.role}`,
    updatedAtIso: nowIso,
  };

  // 저장 전에 파서를 통과시킨다 — 여기서 비면 발송도 비는 것이고, 그 사실을 저장 시점에 알려야 한다.
  const parsed = parseNudgeSequenceConfig(document);
  const mappedSequences = [...parsed.cohorts.values()]
    .reduce((total, cohort) => total + cohort.sequence.size, 0);
  // 합동리뷰 P2-10: 요청에 있었는데 파서가 버린 매핑이 있으면 **저장을 거절**한다.
  //   그대로 저장하면 "저장은 됐는데 실행은 안 되는" drift 가 문서에 남는다.
  // 합동리뷰 R2-7: 비교 기준이 **사전 정제된 값**이면 범위 밖 회차·unknown cohort 가 조용히 사라진다.
  //   원 요청(cohortsInput)에서 비어 있지 않은 매핑 수를 센다 — 버려진 것이 있으면 거절된다.
  let requestedSequences = 0;
  for (const rawCohort of Object.values(cohortsInput)) {
    const sequenceInput = asRecord(asRecord(rawCohort).sequence);
    for (const value of Object.values(sequenceInput)) {
      if (asString(value).trim()) requestedSequences += 1;
    }
  }
  if (requestedSequences !== mappedSequences) {
    throw Object.assign(
      new Error(
        `저장할 수 없는 매핑이 있습니다(요청 ${requestedSequences}개 중 ${mappedSequences}개만 유효). `
        + "템플릿 키에 사용할 수 없는 문자가 있거나 상한을 넘은 회차입니다.",
      ),
      { code: "invalid-argument", errorCode: "nudge_sequence_mapping_rejected" },
    );
  }
  if (document.enabled && mappedSequences === 0) {
    throw Object.assign(
      new Error("활성화하려면 최소 1개 회차에 템플릿을 지정해야 합니다."),
      { code: "failed-precondition", errorCode: "nudge_sequence_no_mapping" },
    );
  }

  // W72E-R1 P1-6: **활성화 시 매핑 키가 실제로 발행돼 있는지 확인한다(fail-closed).**
  //   종전에는 "매핑이 1개라도 있으면" 켤 수 있었다. 그런데 매핑된 키의 문서가 없거나
  //   status 가 active 가 아니면 스윕이 매 회차 미발행으로 죽는다.
  //   재개(enabled=true)는 사고 뒤 되돌리는 조작이라 여기서 한 번 더 막는다.
  if (document.enabled) {
    const referenced = new Set<string>();
    for (const cohort of Object.values(document.cohorts ?? {})) {
      const sequence = (cohort as { sequence?: Record<string, string> }).sequence ?? {};
      for (const key of Object.values(sequence)) {
        if (asString(key)) referenced.add(asString(key));
      }
    }
    const missing: string[] = [];
    for (const key of referenced) {
      // 코드 폴백이 있는 내장 kind 는 문서가 없어도 발송된다(W72 R2-1).
      if (BUILT_IN_SENDABLE_KEYS.has(key)) continue;
      const snapshot = await adminDb.collection(TEMPLATE_COLLECTION).doc(key).get();
      if (!snapshot.exists || asString(snapshot.data()?.status) !== "active") missing.push(key);
    }
    if (missing.length > 0) {
      throw Object.assign(
        new Error(`활성화할 수 없습니다 — 매핑된 문안이 발행되지 않았습니다: ${missing.join(", ")}`),
        { code: "failed-precondition", errorCode: "nudge_sequence_template_not_published" },
      );
    }
  }

  const initialSnapshot = await adminDb.doc(NUDGE_SEQUENCE_TEMPLATES_DOC_PATH).get();
  const initialUpdatedAtIso = asString(initialSnapshot.data()?.updatedAtIso);
  const result = await adminDb.runTransaction(async (transaction) => {
    const ref = adminDb.doc(NUDGE_SEQUENCE_TEMPLATES_DOC_PATH);
    const snapshot = await transaction.get(ref);
    const currentUpdatedAtIso = asString(snapshot.data()?.updatedAtIso);
    if (currentUpdatedAtIso !== initialUpdatedAtIso) {
      throw Object.assign(
        new Error("다른 운영자가 먼저 독려 설정을 변경했습니다. 다시 불러온 뒤 저장하세요."),
        { code: "aborted", errorCode: "nudge_sequence_full_save_stale" },
      );
    }
    const currentCohorts = asRecord(snapshot.data()?.cohorts);
    // [2026-09-17 사고 수리] 전체 저장은 `cohorts` 를 통째로 덮어쓴다(merge 아님) — 요청이
    //   언급하지 않은 코호트도 위 루프가 빈 sequence 로 채워 버리면 그 코호트의 기존 매핑이
    //   조용히 사라진다. 요청에 없던 코호트가 매핑을 잃는 경우만 막는다(명시적으로 비우는
    //   전체 초기화는 정상 동작이라 막지 않는다).
    assertCohortSequencesNotDropped(currentCohorts, cohorts, new Set(Object.keys(cohortsInput)));
    const preservedCohorts = Object.fromEntries(NUDGE_COHORT_KEYS.map((cohort) => {
      const current = asRecord(currentCohorts[cohort]);
      const ceiling = ceilings[cohort];
      const preservedDailyCap = parseNudgeCohortDailyCapsForSave({ [cohort]: current.dailyCap })[cohort] ?? ceiling.dailyCap;
      const preservedDeferralCap = parseNudgeCohortDailyCapsForSave({ [cohort]: current.quotaDeferralCap })[cohort] ?? preservedDailyCap;
      return [cohort, {
        ...asRecord(document.cohorts[cohort]),
        dailyCap: preservedDailyCap,
        quotaDeferralCap: preservedDeferralCap,
      }];
    }));
    // 0.6.110: 전체 저장은 문서를 **통째로** 덮어쓴다(merge 아님). 이 화면이 모르는
    //   `programOverrides` 를 같이 지우면 Snake 오버라이드가 전역 저장 한 번에 사라진다 — 보존한다.
    const currentProgramOverrides = snapshot.data()?.programOverrides;
    transaction.set(ref, {
      ...document,
      cohorts: preservedCohorts,
      ...(currentProgramOverrides !== undefined ? { programOverrides: currentProgramOverrides } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, enabled: parsed.enabled, mappedSequences, updatedAtIso: nowIso, totalDailyCap: parsed.totalDailyCap };
  });

  return result;
}


/**
 * W72-C2 [헤세 지시 2026-08-13] — 지원 검수 탭 코호트①③ 리스트업(읽기 전용).
 *
 * 대상 판정은 스윕과 **같은 정본 함수**가 한다 — 이 콜러블은 인증·파싱·전달만 하는 껍데기다.
 * 건수도 코어 계산값을 그대로 싣는다(화면 재계산 금지 · 리더 하드 룰).
 */
export async function listScpNudgeCohortCandidates(
  request: CallableRequestShape,
): Promise<Record<string, unknown>> {
  const auth = assertNonGuestAuth(request, "nudge_cohort.list", [...WRITE_ROLES]);
  // 2026-09-27 codex adversarial review FAIL-4: unlike getScpNudgeSequenceConfig above (a global,
  // not org-scoped, admin config also edited from the general Admin mail controls card), this
  // lists actual scp nudge-cohort candidate rows (same judgment core as the scheduled sweep) —
  // scp mailbox content, not general admin config. No client UI reaches this callable yet; gate it
  // now rather than leave a role-only opening.
  await assertScpEntitled(auth, request, "nudge_cohort.list");
  const data = asRecord(request.data);
  const cursorInput = asRecord(data.cursor);
  const cursorSentAtIso = asString(cursorInput.sentAtIso);
  const cursorDocId = asString(cursorInput.docId);
  const page = await listNudgeCohortCandidates({
    limit: Number(data.limit ?? 50),
    cursor: cursorSentAtIso && cursorDocId ? { sentAtIso: cursorSentAtIso, docId: cursorDocId } : null,
  });
  return { ...page };
}


/**
 * 0.6.110 — 프로그램/캠페인별 문안 매핑 오버라이드 저장 콜러블.
 *
 * 전역 매핑(`cohorts`)은 건드리지 않는다 — `programOverrides.<id>` 한 칸만 **정확히 교체**(또는 삭제)한다.
 * 서버가 전부 다시 검증한다(화면은 편의일 뿐):
 *   · 대상 ID 는 실제 `programs/{id}` 또는 `campaigns/{id}` 여야 한다(오타로 죽은 오버라이드가 쌓이지 않게).
 *   · 문안 키는 발행(active)돼 있어야 하고, 독려 문안 키이며, **그 코호트의 base 와 같은 계열**이어야 한다
 *     (코호트1 칸에 코호트3 문안을 넣는 사고 차단).
 *   · 요청한 슬롯이 하나라도 버려지면 거절한다(저장은 됐는데 발송은 무시하는 drift 금지).
 *   · super_admin/admin 만. 감사 로그(`settings_audit_log`)를 남긴다.
 * 효과는 전역 `enabled` 가 true 일 때만 난다(전역 킬스위치가 이 오버라이드도 함께 끈다).
 */
export async function saveScpNudgeProgramOverride(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "nudge_sequence.program_override.save", [...OVERRIDE_WRITE_ROLES]);
  await assertScpEntitled(auth, request, "nudge_sequence.program_override.save");
  const data = asRecord(request.data);
  const programKey = asString(data.programKey).trim();
  if (!NUDGE_PROGRAM_OVERRIDE_KEY_RE.test(programKey)) {
    throw Object.assign(new Error("프로그램/캠페인 ID 형식이 올바르지 않습니다."), {
      code: "invalid-argument", errorCode: "nudge_program_override_key_invalid",
    });
  }
  const remove = data.remove === true;
  const expectedUpdatedAtIso = asString(data.expectedUpdatedAtIso);

  const cohortsInput = asRecord(data.cohorts);
  const sequences: Record<string, Record<string, string>> = {};
  let requested = 0;
  if (!remove) {
    for (const rawCohort of Object.keys(cohortsInput)) {
      if (!(OVERRIDE_COHORTS as readonly string[]).includes(rawCohort)) {
        throw Object.assign(new Error(`오버라이드를 지원하지 않는 코호트입니다: ${rawCohort}`), {
          code: "invalid-argument", errorCode: "nudge_program_override_cohort_unsupported",
        });
      }
    }
    const ceilings = nudgeCohortCeilings();
    for (const cohort of OVERRIDE_COHORTS) {
      const sequenceInput = asRecord(asRecord(cohortsInput[cohort]).sequence);
      for (const rawIndex of Object.keys(sequenceInput)) {
        if (asString(sequenceInput[rawIndex]).trim()) requested += 1;
        const index = /^\d+$/.test(rawIndex) ? Number(rawIndex) : 0;
        if (index < 1 || index > ceilings[cohort].maxSends) {
          throw Object.assign(new Error(`상한을 넘는 회차입니다: ${cohort} ${rawIndex}`), {
            code: "invalid-argument", errorCode: "nudge_program_override_sequence_out_of_range",
          });
        }
      }
      const sequence: Record<string, string> = {};
      for (let index = 1; index <= ceilings[cohort].maxSends; index += 1) {
        const key = asString(sequenceInput[String(index)]).trim();
        if (key) sequence[String(index)] = key;
      }
      if (Object.keys(sequence).length > 0) sequences[cohort] = sequence;
    }
    const mapped = Object.values(sequences).reduce((total, seq) => total + Object.keys(seq).length, 0);
    if (mapped !== requested) {
      throw Object.assign(new Error("저장할 수 없는 매핑이 있습니다(사용할 수 없는 문자가 있는 템플릿 키)."), {
        code: "invalid-argument", errorCode: "nudge_program_override_mapping_rejected",
      });
    }
    if (data.enabled === true && mapped === 0) {
      throw Object.assign(new Error("활성화하려면 최소 1개 회차에 템플릿을 지정해야 합니다."), {
        code: "failed-precondition", errorCode: "nudge_program_override_no_mapping",
      });
    }
    for (const [cohort, sequence] of Object.entries(sequences)) {
      for (const [index, key] of Object.entries(sequence)) {
        if (!NUDGE_PROGRAM_OVERRIDE_KEY_RE.test(key)) {
          throw Object.assign(new Error(`템플릿 키 형식이 올바르지 않습니다: ${key}`), {
            code: "invalid-argument", errorCode: "nudge_program_override_template_key_invalid",
          });
        }
        const builtIn = cohort === NUDGE_COHORT2_KEY && BUILT_IN_SENDABLE_KEYS.has(key);
        if (!builtIn) {
          const baseKind = nudgeDraftMailTemplateBaseKind(key);
          if (!isNudgeDraftMailTemplateKind(key) || baseKind !== OVERRIDE_COHORT_BASE_KIND[cohort as (typeof OVERRIDE_COHORTS)[number]]) {
            throw Object.assign(new Error(`이 코호트에 쓸 수 없는 문안 키입니다: ${cohort} 회차 ${index} → ${key}`), {
              code: "invalid-argument", errorCode: "nudge_program_override_template_kind_mismatch",
            });
          }
          const template = await adminDb.collection(TEMPLATE_COLLECTION).doc(key).get();
          if (!template.exists || asString(template.data()?.status) !== "active") {
            throw Object.assign(new Error(`발행되지 않은 문안입니다: ${key}`), {
              code: "failed-precondition", errorCode: "nudge_program_override_template_not_published",
            });
          }
        }
      }
    }
  }

  // 대상 존재 확인 — 삭제는 이미 죽은 키도 지울 수 있어야 하므로 건너뛴다.
  if (!remove) {
    const [programDoc, campaignDoc] = await Promise.all([
      adminDb.collection("programs").doc(programKey).get(),
      adminDb.collection("campaigns").doc(programKey).get(),
    ]);
    if (!programDoc.exists && !campaignDoc.exists) {
      throw Object.assign(new Error(`존재하지 않는 프로그램/캠페인입니다: ${programKey}`), {
        code: "not-found", errorCode: "nudge_program_override_target_not_found",
      });
    }
  }

  const nowIso = new Date().toISOString();
  const overrideValue = {
    enabled: !remove && data.enabled === true,
    cohorts: Object.fromEntries(Object.entries(sequences).map(([cohort, sequence]) => [cohort, { sequence }])),
    updatedBy: `callable:${auth.role}`,
    updatedAtIso: nowIso,
  };
  const ref = adminDb.doc(NUDGE_SEQUENCE_TEMPLATES_DOC_PATH);
  const result = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const raw = (snapshot.exists ? snapshot.data() : {}) ?? {};
    if (asString((raw as Record<string, unknown>).updatedAtIso) !== expectedUpdatedAtIso) {
      throw Object.assign(
        new Error("다른 운영자가 먼저 독려 설정을 변경했습니다. 다시 불러온 뒤 저장하세요."),
        { code: "aborted", errorCode: "nudge_program_override_stale" },
      );
    }
    const before = asRecord(asRecord((raw as Record<string, unknown>).programOverrides)[programKey]);
    const patchPath = new FieldPath("programOverrides", programKey);
    if (!snapshot.exists) {
      // 설정 문서가 없으면 전역은 꺼진 채(enabled 미기입) 오버라이드만 둔다 — fail-closed.
      transaction.set(ref, remove ? { updatedAtIso: nowIso } : {
        programOverrides: { [programKey]: overrideValue }, updatedAtIso: nowIso, updatedBy: `callable:${auth.role}`,
      }, { merge: true });
    } else if (remove) {
      transaction.update(ref, patchPath, FieldValue.delete(), "updatedAtIso", nowIso, "updatedBy", `callable:${auth.role}`);
    } else {
      // update(FieldPath, value) 는 해당 칸을 **통째로 교체**한다(merge 는 비운 슬롯을 남긴다).
      transaction.update(ref, patchPath, overrideValue, "updatedAtIso", nowIso, "updatedBy", `callable:${auth.role}`);
    }
    transaction.set(adminDb.collection(SETTINGS_AUDIT_COLLECTION).doc(), {
      path: NUDGE_SEQUENCE_TEMPLATES_DOC_PATH,
      action: remove ? "delete" : "update",
      field: `programOverrides.${programKey}`,
      before: Object.keys(before).length > 0 ? JSON.stringify(before).slice(0, 4000) : "(없음)",
      after: remove ? "(삭제)" : JSON.stringify(overrideValue).slice(0, 4000),
      actorUserId: auth.userId,
      actorRole: auth.role,
      atIso: nowIso,
      source: "callable:saveScpNudgeProgramOverride",
    });
    return {
      ok: true as const,
      programKey,
      enabled: overrideValue.enabled,
      removed: remove,
      mappedSequences: Object.values(sequences).reduce((total, seq) => total + Object.keys(seq).length, 0),
      globalEnabled: (raw as Record<string, unknown>).enabled === true,
      updatedAtIso: nowIso,
    };
  });
  return result;
}
