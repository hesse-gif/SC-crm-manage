// Flu — 검수 화면의 프로그램/캠페인 종속 필터 정본 (W6-2, 2026-07-27).
//
// `reviewProgramOptions` / `canonicalReviewProgramId` 은 ReviewWorkspace.tsx:461,489 에서 그대로
// 옮겨왔다(별칭을 canonical program id 로 합치고 종료 프로그램에 `· 종료` 를 붙이는 동작 동일).
// 캐노니컬 검수 패널이 같은 옵션·같은 종속 판정을 쓰기 위한 이동이며 새 필터 API·enum 은 없다.
//
// 캠페인 종속(`reviewCampaignOptions`)은 ReviewWorkspace.tsx:2734 의 판정을 옮기면서 U8 공용
// 판정을 합집합으로 더했다:
//   ① 캐노니컬 별칭 지도 일치(resolveCanonicalProgramId) — 기존 동작, 유실 없음
//   ② programIdBelongsToProgram(id/slug/하위 파생 id) — U8 정본 판정
// 합집합이므로 기존에 보이던 캠페인이 사라지지 않고, 별칭(slug)·파생 id 캠페인이 추가로 붙는다.
//
// 런타임 상대 import(`.ts` 확장자 포함)는 src/lib 관례와 같다 — 노드 테스트 레인에서 이 모듈을
// 그대로 import 해 행위를 고정할 수 있다.

import { resolveCanonicalProgramId } from "../../lib/program-canonical.ts";
import { normalizeProgramScopeToken, programIdBelongsToProgram } from "./programScope.ts";

export type ReviewProgramOption = {
  id: string;
  label: string;
  aliases: string[];
  status: string;
};

type ReviewScopeProgramRow = Record<string, unknown>;

type ReviewScopeCampaign = {
  id?: string;
  programId?: string | null;
  canonicalProgramId?: string | null;
  deletedAt?: unknown;
  archivedAt?: unknown;
  deletedAtIso?: unknown;
  archivedAtIso?: unknown;
};

function scopeText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function isVisibleReviewProgram(program: ReviewScopeProgramRow): boolean {
  return Boolean(scopeText(program.id))
    && program.visible !== false
    && !program.deletedAt
    && !program.deletedAtIso
    && !program.archivedAt
    && !program.archivedAtIso;
}

export function reviewProgramOptions(programs: readonly ReviewScopeProgramRow[]): ReviewProgramOption[] {
  const options = new Map<string, ReviewProgramOption>();
  for (const program of programs.filter(isVisibleReviewProgram)) {
    const rawId = scopeText(program.id);
    const canonicalId = resolveCanonicalProgramId(scopeText(program.canonicalProgramId, rawId));
    if (!canonicalId) continue;
    const status = scopeText(program.status);
    const title = scopeText(program.title, scopeText(program.gameTitle, canonicalId));
    const label = status === "closed" ? `${title} · 종료` : title;
    const aliases = [rawId, scopeText(program.slug), canonicalId].filter(Boolean);
    const existing = options.get(canonicalId);
    options.set(canonicalId, existing
      ? {
        ...existing,
        label: rawId === canonicalId ? label : existing.label,
        aliases: Array.from(new Set([...existing.aliases, ...aliases])),
        status: rawId === canonicalId ? status : existing.status,
      }
      : { id: canonicalId, label, aliases: Array.from(new Set(aliases)), status });
  }
  const statusRank = (status: string) => status === "open" ? 0 : status === "draft" ? 1 : 2;
  return [...options.values()].sort((left, right) => (
    statusRank(left.status) - statusRank(right.status)
    || left.label.localeCompare(right.label, "ko")
    || left.id.localeCompare(right.id)
  ));
}

export function canonicalReviewProgramId(value: string, options: readonly ReviewProgramOption[]): string {
  const raw = value.trim();
  if (!raw) return "";
  const canonical = resolveCanonicalProgramId(raw);
  return options.find((option) => option.id === canonical || option.aliases.includes(raw))?.id ?? canonical;
}

/**
 * 행 하나에 붙은 프로그램 id 가 선택된 검수 프로그램 범위에 속하는지. 프로그램 선택 전에는 아무것도 열지 않는다.
 *
 * W7-1c-fix (2026-09-06): `candidateProgramId` 는 이제 서버가 이미 해석한 값이다
 * (`functions/videoReviewStateCallables.ts` → `functions/reviewStateProgramResolution.ts`).
 * 예전에는 검수 원장의 `canonicalProgramId` 가 포털 전역 태그(`view-cpm`)를 그대로 실어 왔고,
 * 그 값은 어떤 옵션의 id/별칭과도 일치하지 않아 서버 배지("전체 1")와 이 함수가 걸러낸 목록
 * ("0건 표시")이 어긋났다(2026-09-05 딥체크 Q6). 서버가 `subject.applicationId →
 * scp_application_management.currentProgramId` 로 조인해 실 프로그램을 채운 뒤 이 필드에 실어
 * 보내므로, 이 함수는 그 값을 원값 그대로 신뢰하고 판정한다 — 별도의 view-cpm 특수 처리는
 * 여기 없다(있으면 안 된다: 그 태그는 어떤 프로그램의 신원도 아니다).
 */
export function programIdBelongsToReviewProgram(
  candidateProgramId: string | null | undefined,
  option: ReviewProgramOption | null,
  rawProgramId: string,
): boolean {
  if (!option && !rawProgramId.trim()) return false;
  const candidate = scopeText(candidateProgramId);
  if (!candidate) return false;
  // ① 캐노니컬 별칭 지도 일치 — ReviewWorkspace 기존 동작, 유실 없음.
  if (option && resolveCanonicalProgramId(candidate) === option.id) return true;
  // ② 프로그램 문서의 별칭(레거시 id·slug)은 **정확 일치만** 인정한다. `pg-xphero----------` 처럼
  //    정규화하면 짧아지는 별칭에 하위 파생 매칭을 허용하면 형제 프로그램(pg-xphero-legacy)까지
  //    삼킨다(교차 유출).
  const normalizedCandidate = normalizeProgramScopeToken(candidate);
  if (option && option.aliases.some((alias) => normalizeProgramScopeToken(alias) === normalizedCandidate)) {
    return true;
  }
  // ③ F6(a): 프로그램 문서가 아직 안 왔거나(option null) 옵션에 없는 별칭이면, 캐노니컬 지도끼리
  //    비교해 별칭 유지를 보장한다 — 예전에는 별칭 판정이 option 존재에만 걸려 있어서 프로그램
  //    목록이 늦게 도착한 첫 렌더에서 별칭 행이 사라졌다.
  if (!option && resolveCanonicalProgramId(candidate) === resolveCanonicalProgramId(rawProgramId)) return true;
  // ④ U8 신원 판정(정확 일치 + `<id>-` 하위 파생)은 요청된 캐노니컬 프로그램 id 에만 적용한다.
  return programIdBelongsToProgram(candidate, null, option ? option.id : rawProgramId);
}

/** 캠페인 한 건이 선택된 검수 프로그램 범위에 속하는지. */
export function campaignBelongsToReviewProgram(
  campaign: ReviewScopeCampaign,
  option: ReviewProgramOption | null,
  rawProgramId: string,
): boolean {
  return programIdBelongsToReviewProgram(
    scopeText(campaign.canonicalProgramId, scopeText(campaign.programId)),
    option,
    rawProgramId,
  );
}

/** 선택된 프로그램에 속한 살아있는 캠페인만. 프로그램 미선택이면 빈 목록(= 캠페인 선택 비활성). */
export function reviewCampaignOptions<T extends ReviewScopeCampaign>(
  campaigns: readonly T[],
  option: ReviewProgramOption | null,
  rawProgramId: string,
): T[] {
  if (!option && !rawProgramId.trim()) return [];
  return campaigns.filter((campaign) => {
    // F6(d) 의도 문서화: 삭제/보관 표식은 **네 필드 모두** 본다. 레거시 행은 `deletedAt`/`archivedAt`,
    // 최근 행은 `*Iso` 를 쓰므로 두 쌍 중 하나만 보면 이미 보관된 캠페인이 검수 필터 옵션에 남는다.
    // (ReviewWorkspace 는 두 필드만 봐서 archived 캠페인이 노출됐다 — 노출 축소가 아니라 결함 수리다.)
    if (campaign.deletedAt || campaign.archivedAt || campaign.deletedAtIso || campaign.archivedAtIso) return false;
    return campaignBelongsToReviewProgram(campaign, option, rawProgramId);
  });
}

// ── 검수 상세 요약의 스코프 표시 이름 (W7-1b/d) ───────────────────────────────────────────
//
// 예전 패널은 `option.id === row.canonicalProgramId` 라는 naive 비교로 옵션을 찾아서, 별칭
// (레거시 id·slug)이 붙은 행은 전부 탈락해 raw id 를 그대로 화면에 찍었다. 해석 순서를 여기 한
// 곳에 모아 화면이 이름을 짓지 않게 한다:
//   ① 서버가 programs/campaigns 문서에서 조인해 준 이름(정본)
//   ② 필터 옵션 라벨 — 매칭은 `canonicalReviewProgramId`(별칭 지도) 로만
//   ③ `unclassified` 계열 센티널 → "미분류" (id 가 아니라 분류 안 됨 표식이다)
//   ④ 남은 원값 → 그대로, 원값도 없으면 "미확인"

/** 캠페인/프로그램 id 자리에 들어오는 미분류 센티널(`unclassified`, `unclassified:campaign:…`). */
export function isUnclassifiedScopeId(value: unknown): boolean {
  const text = scopeText(value);
  return text === "unclassified" || text.startsWith("unclassified:");
}

function scopeDisplayLabel(rawId: unknown, joinedName: unknown, optionLabel: unknown): string {
  const joined = scopeText(joinedName);
  if (joined) return joined;
  const label = scopeText(optionLabel);
  if (label) return label;
  const raw = scopeText(rawId);
  if (!raw) return "미확인";
  if (isUnclassifiedScopeId(raw)) return "미분류";
  return raw;
}

/** 검수 행의 프로그램 표시 이름. */
export function reviewProgramDisplayLabel(
  rawProgramId: unknown,
  options: readonly ReviewProgramOption[],
  joinedName?: unknown,
): string {
  const raw = scopeText(rawProgramId);
  const canonical = raw ? canonicalReviewProgramId(raw, options) : "";
  const option = canonical
    ? options.find((item) => item.id === canonical || item.aliases.includes(raw))
    : undefined;
  return scopeDisplayLabel(raw, joinedName, option?.label);
}

/** 검수 행의 캠페인 표시 이름. 캠페인은 별칭 지도가 없어 정확 일치만 본다. */
export function reviewCampaignDisplayLabel(
  rawCampaignId: unknown,
  campaigns: readonly { id?: string; name?: string | null }[],
  joinedName?: unknown,
): string {
  const raw = scopeText(rawCampaignId);
  const campaign = raw ? campaigns.find((item) => scopeText(item.id) === raw) : undefined;
  return scopeDisplayLabel(raw, joinedName, campaign?.name);
}
