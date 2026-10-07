// W8-FINAL R5(사용자 결정): 결과메일 안전장치를 "정본 프로그램인가"(하드코딩 동등 비교)에서
// **프로그램별 scope gate** 로 바꾼다. 다중 Program/Campaign 라이브 운영에서 정본 프로그램 하나만
// 열리는 구조는 맞지 않고, 그렇다고 게이트를 없애면 다른 프로그램의 템플릿·큐·발송 원장이 섞인다
// (그 격리가 원래 안전장치의 목적이다). `scp_mail_results` 는 readScope 의 SCP_ORG_WIDE_KEYS 라
// 서버가 전 프로그램 행을 그대로 내려준다 — 격리는 이 게이트가 유일한 방어선이다.
//
// 규칙:
//   ① fail-closed — 범위(programId)가 지정되지 않으면 **열지 않는다**.
//   ② 범위가 지정한 축을 행이 증명하지 못하면 **제외한다**(값 누락 = 통과 아님).
//   ③ 판정에 이메일·핸들 같은 퍼지 신호를 절대 쓰지 않는다(교차 프로그램 오염의 원인).
//
// ⚠️ R9-1(적대 리뷰 2레인 독립 지목): 축의 키 집합은 **화면 정본 해석기와 1:1 로 맞춘다**. 예전 주석은
// "같은 키"라고 적어놓고 실제로는 달랐고(program 축이 더 넓고 application 축은 폴백 3개 누락), 그 차이가
// 곧 "같은 화면의 두 목록이 어긋난다 = 사유 없이 큐가 0건" 이었다. 지금 대응은 다음과 같다:
//   - program 축      = ReviewWorkspace `scopedProgramId` 의 4키(canonicalProgramId → programId →
//                       bridgedProgramId → campaignProgramId) **+ `scope.programId` · `programRef`**.
//                       R10-1: 화면 해석기보다 **의도적으로 넓다**. 이 축은 큐뿐 아니라 **발송 원장
//                       (suppression 마스크)** 에도 걸리는데(ReviewWorkspace 의 원장 호출), 이 레포는
//                       `scp_mail_results` 에서 programRef 를 프로그램 신원 필드로 인정한다
//                       (functions/qaProgramRetirement.ts 의 프로그램 신원 필드 목록). 축을 좁히면
//                       programRef 로만 신원을 든 원장 행이 마스크에서 빠져 **이미 보낸 리드가 큐에
//                       재등장 → 중복 실발송**이다. 넓히는 쪽은 과잉 마스킹(=미발송)이라 가역이고,
//                       좁히는 쪽만 비가역이다. **다시 좁히지 마라.**
//   - application 축  = ReviewWorkspace `qualificationApplicationId` 와 동일
//                       (applicationId → __qualificationApplicationId →
//                        (applicationRef ?? bridgedApplicationRef ?? sourceRef) 의 문서 id →
//                        sourceType==="program_application" 이면 행 id).
//   - **campaign 축은 없다**(R9-1b). 포털 신청이 만드는 `program_sheet_leads` 문서에는 campaignId 필드가
//     아예 없는데(functions/programs.ts 리드 생성), URL 의 campaignId 는 `buildScpTabHref` 가 탭 전환마다
//     보존한다 → 캠페인 딥링크로 들어오면 포털 리드 **전원이 미증명으로 제외**되어 큐가 조용히 0건이
//     된다. 기록되지 않은 축은 격리 대상이 될 수 없다. 다시 추가하지 마라.
//   - submission/revision 축은 **현재 호출부가 없다**. 화면 정본 해석기와의 1:1 대응이 아직 없으므로,
//     실제로 쓰기 전에 해당 화면 해석기와 키를 먼저 맞춰라(지금은 fail-closed 로만 동작한다).
//
// ⚠️ 적용 축은 **호출부가 정한다. 큐 후보와 발송 원장에 같은 scope 를 쓰면 안 된다**(의도된 비대칭):
// 큐 후보는 "보낼 수 있는 것"이라 미증명 행을 넣는 쪽이 위험하고, 발송 원장은 "이미 보냈다"는
// suppression 마스크라 미증명 행을 **빼는 쪽**이 위험하다(마스크 유실 → 발송된 리드가 미발송으로
// 큐에 재등장 → 실제 크리에이터에게 중복 발송). "일관성" 명목으로 원장까지 좁히면 회귀다 —
// 그 회귀는 tests/scp-result-mail-scope-gate.test.mjs 가 단정으로 잡는다.
import { resolveCanonicalProgramId } from "./program-canonical.ts";

export type ResultMailScope = {
  programId: string;
  applicationId?: string;
  submissionId?: string;
  revision?: string;
};

type ScopeAxis = {
  /** 범위가 이 축을 **지정했는가**를 원값으로 판단한다(R11-3 — 아래 주석). */
  raw: unknown;
  requested: string;
  resolve: (row: Record<string, unknown>) => string;
};

/**
 * R11-3: "지정됐는가"는 **원값**으로 판단한다. 정규화 결과(문자열)로 판단하면, 숫자처럼 문자열이
 * 아닌 범위 값이 들어왔을 때 그 축이 통째로 건너뛰어져(fail-open) 규칙 ①②와 정면으로 모순된다
 * — 지정된 축은 증명 못 하면 제외여야지, 판정 자체가 사라지면 안 된다.
 */
function axisSpecified(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return Boolean(raw.trim());
  return true;
}

// R10-3: 화면 정본 `leadText` 와 같은 규칙이다 — **문자열만** 받는다. number 를 String() 으로 받아
// 주면 숫자로 들어온 축 필드에서 화면과 게이트의 판정이 갈라진다(같은 행을 한쪽만 인정).
function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function canonical(value: unknown): string {
  const raw = text(value);
  return raw ? resolveCanonicalProgramId(raw) : "";
}

/** `<collection>/<id>` 형태의 ref 에서 문서 id 만 꺼낸다(중첩 경로는 인정하지 않는다). */
function idFromRef(value: unknown, collection: string): string {
  const ref = text(value);
  const prefix = `${collection}/`;
  return ref.startsWith(prefix) && !ref.slice(prefix.length).includes("/")
    ? ref.slice(prefix.length)
    : "";
}

/** 범위가 지정됐는가. programId 가 없으면 결과메일 템플릿·큐·원장을 열지 않는다(fail-closed). */
export function resultMailScopeReady(scope: ResultMailScope | null | undefined): boolean {
  return Boolean(scope && canonical(scope.programId));
}

/** 범위 식별자 — 큐 캐시 키·감사 문구에 쓴다(값이 같으면 같은 범위). */
export function resultMailScopeKey(scope: ResultMailScope | null | undefined): string {
  if (!resultMailScopeReady(scope)) return "";
  return [
    canonical(scope!.programId),
    text(scope!.applicationId),
    text(scope!.submissionId),
    text(scope!.revision),
  ].join("|");
}

function nestedScope(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = row.scope;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
}

/**
 * ReviewWorkspace `scopedProgramId` 의 4키 + `scope.programId` · `programRef`(R10-1).
 * 이 축은 발송 원장(suppression 마스크)에도 걸리므로 **좁히는 변경은 중복 실발송**이다 —
 * 신원을 드는 방식이 하나라도 빠지면 그 원장 행이 마스크에서 사라진다. 넓히는 쪽만 안전하다.
 */
function rowProgramId(row: Record<string, unknown>): string {
  return canonical(row.canonicalProgramId)
    || canonical(row.programId)
    || canonical(row.bridgedProgramId)
    || canonical(row.campaignProgramId)
    || canonical(nestedScope(row)?.programId)
    || canonical(idFromRef(row.programRef, "programs"));
}

/** ReviewWorkspace `qualificationApplicationId` 와 같은 키·같은 순서(폴백 3개 포함). */
function rowApplicationId(row: Record<string, unknown>): string {
  const direct = text(row.applicationId) || text(row.__qualificationApplicationId);
  if (direct) return direct;
  const fromRef = idFromRef(
    row.applicationRef ?? row.bridgedApplicationRef ?? row.sourceRef,
    "program_applications",
  );
  if (fromRef) return fromRef;
  return text(row.sourceType) === "program_application" ? text(row.id) : "";
}

function rowFirstField(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = text(row[key]);
    if (value) return value;
  }
  return "";
}

function scopeAxes(scope: ResultMailScope): ScopeAxis[] {
  return [
    { raw: scope.applicationId, requested: text(scope.applicationId), resolve: rowApplicationId },
    {
      raw: scope.submissionId,
      requested: text(scope.submissionId),
      resolve: (row) => rowFirstField(row, ["submissionId", "videoSubmissionId"])
        || idFromRef(row.submissionRef, "submissions"),
    },
    {
      raw: scope.revision,
      requested: text(scope.revision),
      resolve: (row) => rowFirstField(row, ["revision", "videoRevision"]),
    },
  ];
}

/**
 * 이 행이 요청된 범위 안에 있는가.
 * - programId 는 **반드시** 일치한다(행에 programId 가 없으면 범위를 증명하지 못하므로 제외).
 * - 나머지 축도 **범위가 지정했으면 반드시 일치**한다. 행이 그 축을 증명하지 못하면 제외(fail-closed).
 *   단 축 판정은 화면 정본 해석기와 같은 폴백까지 본다 — 해석기가 "이 신청 소속"이라고 보는 행을
 *   게이트만 제외하면 두 목록이 어긋난다(R9-1).
 */
export function rowInResultMailScope(
  row: Record<string, unknown> | null | undefined,
  scope: ResultMailScope | null | undefined,
): boolean {
  if (!row || !resultMailScopeReady(scope)) return false;
  if (rowProgramId(row) !== canonical(scope!.programId)) return false;
  for (const axis of scopeAxes(scope!)) {
    // R11-3: 지정 여부는 원값으로 본다. 정규화 결과로 보면 문자열이 아닌 범위 값(숫자 등)이 축을
    // 통째로 건너뛰게 만들어 fail-open 이 된다 — 지정된 축은 증명 못 하면 **제외**여야 한다.
    if (!axisSpecified(axis.raw)) continue;
    if (!axis.requested) return false;
    if (axis.resolve(row) !== axis.requested) return false;
  }
  return true;
}

/**
 * 범위 조건으로 제외된 건수를 화면에 노출할지 — **값으로 검증 가능한 순수함수**로 뽑았다(R11-2).
 * 예전 가드는 소스 문자열 위치·창 검사라 배지를 환경 게이트로 감싸거나 조건을 인라인으로 바꿔도
 * 통과했다(같은 결함이 두 번 통과한 구조). 표시 규칙이 함수면 값으로 고정된다.
 * ⚠️ 이 표면은 **운영 빌드에도 있어야 한다** — 조용한 0건을 막으려고 만든 것이므로 여기에도,
 * 호출부에도 환경(NEXT_PUBLIC_USE_EMULATOR 등) 조건을 걸지 마라.
 */
export function shouldShowResultMailScopeExcluded(input: {
  queue: string;
  scopeReady: boolean;
  excludedCount: number;
}): boolean {
  return input.queue === "mail"
    && input.scopeReady === true
    && Number.isFinite(input.excludedCount)
    && input.excludedCount > 0;
}

/** 범위 밖 행을 걸러낸다. 범위 미지정이면 **빈 목록**(fail-closed). */
export function scopedResultMailRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  scope: ResultMailScope | null | undefined,
): T[] {
  if (!resultMailScopeReady(scope)) return [];
  return rows.filter((row) => rowInResultMailScope(row, scope));
}
