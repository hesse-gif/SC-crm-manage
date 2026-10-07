// 캠페인별 콜드메일 성과 분해 — 슬랙 10:00 리포트의 콜드 섹션과 발송 레인 상태 블록이 공용으로 쓴다.
//
// WHY (헤세 지시, 2026-09-17): XP Hero(pg-scp-cpm-2608-2)와 Snake Clash×Pororo
// (pg-snake-clash-creator-program)가 동시에 라이브인데, 종전 리포트는 콜드메일 숫자를 프로그램
// 구분 없이 전역 하나로만 보여줬다 — 한쪽이 멈춰도 다른 쪽 숫자에 가려 안 보였다.
//
// 인덱스 규율: `campaign_outreach` 의 기존 복합 인덱스는 `campaignId + deliveryState + __name__`
// 뿐이다(firestore.indexes.json). 등호 필터 2개(campaignId·deliveryState)까지는 그 인덱스로 되지만,
// `sentAtIso`/`suppressedAtIso` 범위 판정을 얹으려면 새 복합 인덱스가 필요하다 — 새로 만들지 않는다.
// 대신 캠페인별 일일 카운터 문서(`campaign_outreach_daily_counters/{KST일자}__{campaignId}`, 다른
// 브랜치가 추가할 수도 있는 문서 — 있으면 그대로 읽고, 없으면 select()+limit 로 당겨와 메모리에서
// 그 날짜만 센다. 메모리 스캔은 `__name__`(campaignId_유튜브채널ID) 순이라 시간과 무관한 표본이다 —
// 캠페인의 전체 `sent` 행이 스캔 상한(2,000)을 넘으면 오늘/어제 몫이 슬라이스 밖에 있을 수 있다.
// 카운터 문서가 생기기 전까지는 알려진 근사치다(README/handoff 에 명시할 것).
//
// SEC-P0-009: campaignId·캠페인명·건수만 다룬다. 수신자 이메일/이름은 이 모듈에 들어오지 않는다.

import { adminDb } from "./firebaseAdmin";
import { koreaDayKeyFrom } from "./mailOutboundSafety";
import { resolveCampaignOperationalState } from "./campaignControlCore";
import { defaultProgramTitle, resolveProgramTitles } from "./programTitles";
import { readOwnedDiscoveryVertical } from "./discoveryVerticalPolicy";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 캠페인이 "라이브"로 잡히려면 이 기간 내 갱신된 active/paused 여야 한다(autoApproveLiveSend 는 예외). */
const CAMPAIGN_RECENCY_WINDOW_MS = 7 * DAY_MS;
/** 후보 캠페인 자체는 적다(현재 2개) — 상한은 미래 확장에 대비한 안전판일 뿐이다. */
const CAMPAIGN_SCAN_LIMIT = 200;
/** sent/suppressed_duplicate 행 메모리 스캔 상한 — 위 WHY 주석의 근사치 한계와 짝이다. */
const OUTREACH_ROW_SCAN_LIMIT = 2000;

export type CampaignOutreachCounts = {
  readonly sentToday: number;
  readonly sentYesterday: number;
  readonly approvedPending: number;
  readonly queuedForReview: number;
  readonly suppressedDuplicateToday: number;
};

const EMPTY_COUNTS: CampaignOutreachCounts = {
  sentToday: 0,
  sentYesterday: 0,
  approvedPending: 0,
  queuedForReview: 0,
  suppressedDuplicateToday: 0,
};

export type PerCampaignReportRow = CampaignOutreachCounts & {
  readonly campaignId: string;
  readonly campaignName: string;
  readonly programId: string;
  /** programTitles 레지스트리의 기본 타이틀명. 없으면 빈 문자열 — 렌더가 campaignName 으로 떨어진다. */
  readonly programTitle: string;
  readonly operationalState: string;
  /**
   * TEST Slack 리포트의 업무 단위. 제목/자유 텍스트가 아니라 campaign/program의
   * 정본 scope만 사용한다. 알 수 없는 캠페인은 절대 XP·Pororo·AI Drama로 추측하지 않는다.
   */
  readonly workstream: OutreachWorkstream;
  /** 캠페인 단위 일일 발송 상한. 0/미설정은 전역 상한만 적용한다. */
  readonly dailyCap?: number;
  /** campaign 문서에 마지막으로 기록된 후보 재고 센서. 새 후보 쿼리를 만들지 않는다. */
  readonly candidatePoolInventory?: { sendableEstimate?: number; floor?: number; atIso?: string };
  readonly lastRefillAtIso?: string;
  readonly lastRefillErrorCode?: string;
  /** AI Drama가 명시 vertical로 확인되었을 때만 true다. */
  readonly aiDramaCriteriaConfigured: boolean;
};

export type OutreachWorkstream = "xp" | "pororo" | "ai_drama" | "unclassified";

export const XP_OUTREACH_PROGRAM_ID = "pg-scp-cpm-2608-2";
export const PORORO_OUTREACH_PROGRAM_ID = "pg-snake-clash-creator-program";

export type ProgramVerticalInput = Record<string, unknown> & { readonly id?: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * AI Drama는 campaign targetingCriteria의 유효 vertical을 먼저 본다. 레거시 top-level
 * campaign vertical은 그 다음 폴백이고, 둘 다 없을 때만 parent program으로 떨어진다.
 * `readOwnedDiscoveryVertical`의 기본값(game)은 여기서 AI라는 증거가 아니므로, 실제
 * ai_drama가 확인됐을 때만 분류한다.
 */
export function classifyOutreachWorkstream(
  campaign: CampaignDocInput,
  parentProgram: ProgramVerticalInput | undefined,
): OutreachWorkstream {
  const campaignVertical = readOwnedDiscoveryVertical([
    record(campaign.targetingCriteria),
    campaign,
  ]);
  if (campaignVertical === "ai_drama") return "ai_drama";

  const programVertical = parentProgram
    ? readOwnedDiscoveryVertical([parentProgram, record(parentProgram.candidateCriteria)])
    : "game";
  if (programVertical === "ai_drama") return "ai_drama";

  const programId = stringField(campaign, "programId");
  if (programId === XP_OUTREACH_PROGRAM_ID) return "xp";
  if (programId === PORORO_OUTREACH_PROGRAM_ID) return "pororo";
  return "unclassified";
}

/** Firestore 문서를 그대로 물린 최소 입력 — 순수 집계 함수는 이 형태만 본다. */
export type CampaignDocInput = Record<string, unknown> & { readonly id: string };

function stringField(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function candidatePoolInventoryFrom(campaign: CampaignDocInput): PerCampaignReportRow["candidatePoolInventory"] {
  const inventory = record(campaign.candidatePoolInventory);
  const sendableEstimate = nonNegativeNumber(inventory.sendableEstimate);
  const floor = nonNegativeNumber(inventory.floor);
  const atIso = stringField(inventory, "atIso");
  return sendableEstimate === undefined && floor === undefined && !atIso
    ? undefined
    : {
        ...(sendableEstimate === undefined ? {} : { sendableEstimate }),
        ...(floor === undefined ? {} : { floor }),
        ...(atIso ? { atIso } : {}),
      };
}

// ---- 순수 집계 -------------------------------------------------------------

/** 캠페인 문서 1건 + 그 캠페인의 카운트를 한 행으로 합친다. Firestore/네트워크 의존이 없다. */
export function buildPerCampaignReportRow(
  campaign: CampaignDocInput,
  counts: CampaignOutreachCounts,
  parentProgram?: ProgramVerticalInput,
): PerCampaignReportRow {
  const campaignId = campaign.id;
  const programId = stringField(campaign, "programId");
  const programTitle = defaultProgramTitle(resolveProgramTitles(programId))?.name ?? "";
  const workstream = classifyOutreachWorkstream(campaign, parentProgram);
  const dailyCap = nonNegativeNumber(campaign.dailyCap);
  const candidatePoolInventory = candidatePoolInventoryFrom(campaign);
  const lastRefillAtIso = stringField(campaign, "lastRefillAtIso");
  const lastRefillErrorCode = stringField(campaign, "lastRefillErrorCode");
  return {
    campaignId,
    campaignName: stringField(campaign, "name", campaignId),
    programId,
    programTitle,
    operationalState: resolveCampaignOperationalState(campaign),
    workstream,
    aiDramaCriteriaConfigured: workstream === "ai_drama",
    ...(dailyCap && dailyCap > 0 ? { dailyCap } : {}),
    ...(candidatePoolInventory ? { candidatePoolInventory } : {}),
    ...(lastRefillAtIso ? { lastRefillAtIso } : {}),
    ...(lastRefillErrorCode ? { lastRefillErrorCode } : {}),
    ...counts,
  };
}

/** 캠페인 목록 + campaignId→카운트 맵을 행 배열로 합친다(정렬은 formatPerCampaignReportLines 가 한다). */
export function buildPerCampaignReportRows(
  campaigns: readonly CampaignDocInput[],
  countsByCampaignId: ReadonlyMap<string, CampaignOutreachCounts>,
  programsById: ReadonlyMap<string, ProgramVerticalInput> = new Map(),
): PerCampaignReportRow[] {
  return campaigns.map((campaign) =>
    buildPerCampaignReportRow(
      campaign,
      countsByCampaignId.get(campaign.id) ?? EMPTY_COUNTS,
      programsById.get(stringField(campaign, "programId")),
    ));
}

export type PerCampaignRowsByWorkstream = Record<OutreachWorkstream, PerCampaignReportRow[]>;

export function groupPerCampaignRowsByWorkstream(rows: readonly PerCampaignReportRow[]): PerCampaignRowsByWorkstream {
  const grouped: PerCampaignRowsByWorkstream = { xp: [], pororo: [], ai_drama: [], unclassified: [] };
  for (const row of rows) grouped[row.workstream].push(row);
  return grouped;
}

function compareBySentTodayDesc(a: PerCampaignReportRow, b: PerCampaignReportRow): number {
  if (b.sentToday !== a.sentToday) return b.sentToday - a.sentToday;
  return a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0;
}

/** 오늘 발송 많은 순. 동률은 campaignId 사전순으로 고정해 렌더 결과가 매 실행 안정적이게 한다. */
export function sortPerCampaignReportRows(rows: readonly PerCampaignReportRow[]): PerCampaignReportRow[] {
  return [...rows].sort(compareBySentTodayDesc);
}

const OPERATIONAL_STATE_LABELS: Record<string, string> = {
  paused: "일시정지",
  completed: "종료",
  cancelled: "취소",
};

/** 렌더용 표시명: programTitles 오버라이드 우선, 없으면 캠페인명, 그것도 없으면 id. 이메일은 절대 안 쓴다. */
function displayTitle(row: PerCampaignReportRow): string {
  return row.programTitle || row.campaignName || row.programId || row.campaignId;
}

export function formatPerCampaignReportRow(row: PerCampaignReportRow): string {
  const title = displayTitle(row);
  const sentToday = row.sentToday.toLocaleString("ko-KR");
  const sentYesterday = row.sentYesterday.toLocaleString("ko-KR");
  const approvedPending = row.approvedPending.toLocaleString("ko-KR");
  const stateLabel = OPERATIONAL_STATE_LABELS[row.operationalState];
  const parts = [`오늘 ${sentToday} / 어제 ${sentYesterday}`, `승인대기 ${approvedPending}`];
  if (stateLabel) {
    // 정지/종료 계열은 검토대기·일캡보다 그 사실 자체가 더 급하다 — 대신 보여준다.
    parts.push(stateLabel);
  } else {
    parts.push(`검토대기 ${row.queuedForReview.toLocaleString("ko-KR")}`);
    if (row.dailyCap !== undefined) parts.push(`일캡 ${row.dailyCap.toLocaleString("ko-KR")}`);
  }
  const inventory = row.candidatePoolInventory;
  if (inventory?.sendableEstimate !== undefined) {
    const floor = inventory.floor === undefined ? "하한 미설정" : `하한 ${inventory.floor.toLocaleString("ko-KR")}`;
    parts.push(`후보 재고 예상 ${inventory.sendableEstimate.toLocaleString("ko-KR")} (${floor})`);
  }
  if (row.lastRefillAtIso) parts.push(`최근 보충 ${formatKstShortDate(row.lastRefillAtIso)}`);
  if (row.lastRefillErrorCode) parts.push(refillStatusLabel(row.lastRefillErrorCode));
  return `• ${title} — ${parts.join(" · ")}`;
}

function formatKstShortDate(iso: string): string {
  const millis = Date.parse(iso);
  if (!Number.isFinite(millis)) return "시각 형식 오류";
  return new Date(millis + 9 * 60 * 60 * 1_000).toISOString().slice(5, 16).replace("T", " ");
}

function refillStatusLabel(errorCode: string): string {
  if (errorCode.startsWith("campaign_refill_deadline_yield")) return "보충 이월(실행 시간 한도)";
  if (errorCode === "campaign_targets_all_already_touched") return "보충 대상 없음(기접촉 후보)";
  if (errorCode === "failed-precondition") return "보충 사전조건 미충족";
  return /^[a-z0-9_]{1,96}$/.test(errorCode) ? `보충 오류(${errorCode})` : "보충 오류(코드 형식 불가)";
}

function formatAiDramaReportRow(row: PerCampaignReportRow): string {
  const title = displayTitle(row);
  const parts = [row.aiDramaCriteriaConfigured ? "발굴 조건 설정됨" : "발굴 조건 미확인"];
  const inventory = row.candidatePoolInventory;
  if (inventory?.sendableEstimate !== undefined) {
    const floor = inventory.floor === undefined ? "하한 미설정" : `하한 ${inventory.floor.toLocaleString("ko-KR")}`;
    parts.push(`후보 재고 예상 ${inventory.sendableEstimate.toLocaleString("ko-KR")} (${floor})`);
  } else {
    parts.push("후보 재고 미측정");
  }
  parts.push(`검토대기 ${row.queuedForReview.toLocaleString("ko-KR")}`);
  if (row.lastRefillAtIso) parts.push(`최근 보충 ${formatKstShortDate(row.lastRefillAtIso)}`);
  if (row.lastRefillErrorCode) parts.push(refillStatusLabel(row.lastRefillErrorCode));
  return `• ${title} — ${parts.join(" · ")}`;
}

/** 캠페인이 하나도 없으면 빈 배열 — 호출부가 빈 섹션 헤더만 남기지 않게 한다. */
export function formatPerCampaignReportLines(rows: readonly PerCampaignReportRow[]): string[] {
  if (rows.length === 0) return [];
  return sortPerCampaignReportRows(rows).map(formatPerCampaignReportRow);
}

// ---- 요약(글래스) 채널: 캠페인별 발송 건수 한 줄 -----------------------------
// 2026-09-27(헤세 지시): 요약 채널도 "어디서·무엇을 보냈는지"는 보여야 한다 — 단 비율·코호트·
// 부연설명 없이 초단축 이름 + 오늘 발송 건수만, 0건 캠페인은 뺀다.

function compareBySentYesterdayDesc(a: PerCampaignReportRow, b: PerCampaignReportRow): number {
  if (b.sentYesterday !== a.sentYesterday) return b.sentYesterday - a.sentYesterday;
  return a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0;
}

function glanceShortNameWords(row: PerCampaignReportRow): string[] {
  const title = displayTitle(row);
  const words = title.split(/[×·\s]+/).filter(Boolean);
  return words.length > 0 ? words : [title];
}

/**
 * "Snake Clash×Pororo" → "Snake", "XP Hero" → "XP Hero" — 요약 채널 한 줄 표 전용 초단축
 * 이름이다(상세 채널의 displayTitle 과는 다른, 더 짧은 축). 첫 토큰이 3자 이하면(예: "XP")
 * 그것만으로는 구분이 안 되므로 두 번째 토큰까지 붙인다.
 *
 * 단독으로 쓰면(예: 테스트) 다른 캠페인과의 충돌을 모른다 — 여러 캠페인을 한 줄에 같이
 * 렌더할 때는 이 함수가 아니라 아래 uniqueGlanceCampaignNames 를 쓴다(같은 세트 안에서 겹치는
 * 이름을 서로 구분되게 늘린다).
 */
export function glanceCampaignShortName(row: PerCampaignReportRow): string {
  const words = glanceShortNameWords(row);
  return words[0].length <= 3 && words.length > 1 ? `${words[0]} ${words[1]}` : words[0];
}

/** 지금 wordCount 스냅샷 기준으로, 서로 다른 원문 제목을 가진 행들이 겹치는 이름 그룹만 골라낸다. */
function collidingNameGroups(
  titles: readonly string[],
  wordsList: readonly string[][],
  wordCount: readonly number[],
): number[][] {
  const indicesByName = new Map<string, number[]>();
  wordsList.forEach((words, index) => {
    const name = words.slice(0, wordCount[index]).join(" ");
    const indices = indicesByName.get(name) ?? [];
    indices.push(index);
    indicesByName.set(name, indices);
  });
  return [...indicesByName.values()].filter((indices) => {
    if (indices.length <= 1) return false;
    const distinctTitles = new Set(indices.map((index) => titles[index]));
    return distinctTitles.size > 1; // 진짜 같은 캠페인명끼리의 그룹은 충돌이 아니다.
  });
}

/**
 * 렌더 대상 집합 **안에서** 초단축 이름이 겹치면(예: "Snake Clash×Pororo"·"Snake Clash×Loopy"
 * 둘 다 "Snake") 서로 구분될 때까지 단어를 늘린다 — 안 그러면 다른 두 캠페인의 발송 건수가
 * 같은 이름 아래 나란히 찍혀 어느 쪽 숫자인지 알 수 없다. 이름 원문이 완전히 같으면(진짜 같은
 * 캠페인) 굳이 늘리지 않는다.
 *
 * 코드 리뷰 지적(2026-09-27, round 3): 쌍(pairwise)으로 하나씩 늘리면 **비대칭**이 생긴다 —
 * (A,B) 를 먼저 비교해 둘 다 늘려놓고 나서 (A,C) 를 비교하면, A 는 이미 길어진 상태라 아직
 * 안 늘어난 C 와는 우연히 안 겹쳐 보여 C 가 충돌 그룹에서 조용히 빠진다(A·B·C 세 이름이
 * 구분자만 다를 뿐 단어로는 전부 같을 때 실측). 그래서 **매 라운드마다 지금 이름으로 그룹을
 * 다시 짓고, 진짜로 겹치는 그룹 전체를 동시에** 한 단어씩 늘린다 — 어느 한쪽만 먼저 늘어나는
 * 비대칭이 없어야 그룹에서 빠지는 행이 안 생긴다.
 */
function uniqueGlanceCampaignNames(rows: readonly PerCampaignReportRow[]): string[] {
  const titles = rows.map((row) => displayTitle(row));
  const wordsList = rows.map((row) => glanceShortNameWords(row));
  const wordCount = wordsList.map((words) => (words[0].length <= 3 && words.length > 1 ? 2 : 1));

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of collidingNameGroups(titles, wordsList, wordCount)) {
      for (const index of group) {
        if (wordCount[index] < wordsList[index].length) { wordCount[index] += 1; changed = true; }
      }
    }
  }

  const names = rows.map((_, index) => wordsList[index].slice(0, wordCount[index]).join(" "));
  // 단어를 끝까지 늘려도(전체 이름) 여전히 겹치면(구분자만 다른 이름 등, 단어로는 원천적으로
  // 안 갈라짐) 원문 제목 그대로로 최종 확정한다 — 원문이 다르면 반드시 서로 다르다.
  for (const group of collidingNameGroups(titles, wordsList, wordCount)) {
    for (const index of group) names[index] = titles[index];
  }
  return names;
}

/**
 * 요약(글래스) 채널의 콜드 캠페인별 발송 건수 한 줄. 0건 캠페인은 뺀다 — 전부 0건이거나
 * 캠페인이 하나도 없으면 줄 자체를 null 로 없앤다(빈 "• 콜드:" 헤더만 남기지 않는다).
 * 집계 조회 자체가 실패했으면(available=false) 0건처럼 보이면 안 되므로 "측정 불가"로 드러낸다.
 *
 * 코드 리뷰 지적(2026-09-27, High): `sentToday` 가 아니라 **`sentYesterday`** 를 쓴다.
 * `sentToday`/`sentYesterday` 는 리포트 실행 시각(nowMs) 기준이고, 글래스 상단 지표
 * (ScheduledReportFacts.daily)는 항상 **그 실행일의 전날 KST 전체 구간**이다 — 둘 다
 * "실행일 - 1일"을 가리키므로 `sentYesterday` 가 상단 지표와 같은 구간이다. `sentToday`
 * (실행 당일, 아직 누적 중인 실시간 값)를 쓰면 상단 "발송 1,015"와 다른 날짜의 숫자가
 * 나란히 찍혀 합계가 맞지 않는다.
 *
 * AI 드라마 업무는 뺀다 — formatAiDramaReportRow 와 같은 이유(상세 채널 전례,
 * "AI 드라마 알림은 발송 자동화를 암시하는 메일 지표를 앞세우지 않는다"): 요약 채널의
 * "콜드: 이름 건수" 표가 그 건수를 정확히 앞세우는 형태라, 상세 채널이 이미 의도적으로
 * 숨긴 신호를 여기서 새로 노출하면 안 된다.
 */
export function formatGlanceColdCampaignLine(rows: readonly PerCampaignReportRow[], available = true): string | null {
  if (!available) return "• 콜드: 측정 불가";
  const qualifying = [...rows]
    .filter((row) => row.workstream !== "ai_drama" && row.sentYesterday > 0)
    .sort(compareBySentYesterdayDesc);
  if (qualifying.length === 0) return null;
  const names = uniqueGlanceCampaignNames(qualifying);
  const parts = qualifying.map((row, index) => `${names[index]} ${row.sentYesterday.toLocaleString("ko-KR")}`);
  return `• 콜드: ${parts.join(" · ")}`;
}

const WORKSTREAM_TITLES: Record<Exclude<OutreachWorkstream, "unclassified">, string> = {
  xp: "XP",
  pororo: "뽀로로",
  ai_drama: "AI 드라마",
};

/**
 * 상세 채널에서 발행할 독립 top-level 메시지들. 각 업무 메시지에는 자기
 * campaign 행만 들어가며, 전역 지표를 세 업무에 복사하지 않는다.
 *
 * 2026-09-27(헤세 지시): 캠페인이 0개인 업무는 "구성되지 않았습니다" placeholder 문구 대신
 * 메시지 자체를 스킵한다 — 조회 자체가 실패한 경우(sourceAvailable=false)만 그 사실을 알리는
 * 메시지를 남긴다(둘은 다른 신호다: 전자는 정상이고 후자는 장애다).
 */
export function formatDetailWorkstreamReportMessages(
  groups: PerCampaignRowsByWorkstream,
  sourceAvailable = true,
): string[] {
  const unavailableLine = "• 캠페인 범위 집계 조회 실패";
  const messages = (Object.keys(WORKSTREAM_TITLES) as Array<Exclude<OutreachWorkstream, "unclassified">>)
    .map((workstream) => {
      const lines = sourceAvailable
        ? workstream === "ai_drama"
          ? sortPerCampaignReportRows(groups[workstream]).map(formatAiDramaReportRow)
          : formatPerCampaignReportLines(groups[workstream])
        : [unavailableLine];
      if (lines.length === 0) return null;
      return [
        `*[${WORKSTREAM_TITLES[workstream]}] 아웃리치 리포트*`,
        ...lines,
      ].join("\n");
    })
    .filter((message): message is string => message !== null);

  if (sourceAvailable && groups.unclassified.length > 0) {
    messages.push([
      "*[미분류] 아웃리치 리포트*",
      "• XP·뽀로로·AI 드라마 정본 scope로 확인되지 않은 캠페인입니다",
      ...formatPerCampaignReportLines(groups.unclassified),
    ].join("\n"));
  }
  return messages;
}

// ---- I/O -------------------------------------------------------------------

function koreaDayKeyOfIso(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? koreaDayKeyFrom(new Date(parsed)) : "";
}

function perCampaignDailyCounterDocId(dayKey: string, campaignId: string): string {
  return `${dayKey}__${campaignId}`;
}

/** 캠페인별 일일 카운터 문서가 있으면 그 값을, 없으면 null(호출부가 스캔으로 보정). */
async function readPerCampaignDailyCounter(campaignId: string, dayKey: string): Promise<number | null> {
  try {
    const snapshot = await adminDb.collection("campaign_outreach_daily_counters")
      .doc(perCampaignDailyCounterDocId(dayKey, campaignId)).get();
    if (!snapshot.exists) return null;
    const value = snapshot.data()?.sent;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  } catch {
    return null;
  }
}

/** deliveryState=="sent" 행의 sentAtIso 만 당겨온다 — 본문 없음, 상한 있음(위 WHY 주석 참고). */
async function scanSentIsoValues(campaignId: string): Promise<string[]> {
  try {
    const snapshot = await adminDb.collection("campaign_outreach")
      .where("campaignId", "==", campaignId)
      .where("deliveryState", "==", "sent")
      .select("sentAtIso")
      .limit(OUTREACH_ROW_SCAN_LIMIT)
      .get();
    return snapshot.docs.map((doc) => String(doc.data().sentAtIso ?? ""));
  } catch {
    return [];
  }
}

function countIsoOnDay(isoValues: readonly string[], dayKey: string): number {
  let count = 0;
  for (const value of isoValues) if (koreaDayKeyOfIso(value) === dayKey) count += 1;
  return count;
}

/** 오늘/어제 발송 건수. 카운터 문서가 둘 다 있으면 스캔 자체를 하지 않는다(읽기 최소화). */
async function sentCountsForCampaign(
  campaignId: string,
  todayKey: string,
  yesterdayKey: string,
): Promise<Pick<CampaignOutreachCounts, "sentToday" | "sentYesterday">> {
  const [todayCounter, yesterdayCounter] = await Promise.all([
    readPerCampaignDailyCounter(campaignId, todayKey),
    readPerCampaignDailyCounter(campaignId, yesterdayKey),
  ]);
  if (todayCounter !== null && yesterdayCounter !== null) {
    return { sentToday: todayCounter, sentYesterday: yesterdayCounter };
  }
  const scanned = await scanSentIsoValues(campaignId);
  return {
    sentToday: todayCounter ?? countIsoOnDay(scanned, todayKey),
    sentYesterday: yesterdayCounter ?? countIsoOnDay(scanned, yesterdayKey),
  };
}

async function countByDeliveryState(campaignId: string, deliveryState: string): Promise<number> {
  try {
    const snapshot = await adminDb.collection("campaign_outreach")
      .where("campaignId", "==", campaignId)
      .where("deliveryState", "==", deliveryState)
      .count()
      .get();
    return Math.max(0, Math.round(snapshot.data().count ?? 0));
  } catch {
    return 0;
  }
}

async function suppressedDuplicateTodayCount(campaignId: string, todayKey: string): Promise<number> {
  try {
    const snapshot = await adminDb.collection("campaign_outreach")
      .where("campaignId", "==", campaignId)
      .where("deliveryState", "==", "suppressed_duplicate")
      .select("suppressedAtIso")
      .limit(OUTREACH_ROW_SCAN_LIMIT)
      .get();
    return snapshot.docs.filter((doc) => koreaDayKeyOfIso(doc.data().suppressedAtIso) === todayKey).length;
  } catch {
    return 0;
  }
}

async function fetchCampaignOutreachCounts(campaignId: string, nowMs: number): Promise<CampaignOutreachCounts> {
  const todayKey = koreaDayKeyFrom(new Date(nowMs));
  const yesterdayKey = koreaDayKeyFrom(new Date(nowMs - DAY_MS));
  const [sentCounts, approvedPending, queuedForReview, suppressedDuplicateToday] = await Promise.all([
    sentCountsForCampaign(campaignId, todayKey, yesterdayKey),
    countByDeliveryState(campaignId, "approved"),
    countByDeliveryState(campaignId, "queued_for_review"),
    suppressedDuplicateTodayCount(campaignId, todayKey),
  ]);
  return { ...sentCounts, approvedPending, queuedForReview, suppressedDuplicateToday };
}

const CAMPAIGN_PROJECTION = [
  "name", "programId", "operationalState", "status", "autoApproveLiveSend", "updatedAtIso",
  "discoveryVertical", "targetingCriteria", "dailyCap", "candidatePoolInventory", "lastRefillAtIso", "lastRefillErrorCode",
];
const PROGRAM_VERTICAL_PROJECTION = ["discoveryVertical", "candidateCriteria"];

/** autoApproveLiveSend==true 이거나, 최근 7일 내 갱신된 active/paused 캠페인. */
async function fetchQualifyingCampaigns(nowMs: number): Promise<CampaignDocInput[]> {
  const recentSinceIso = new Date(nowMs - CAMPAIGN_RECENCY_WINDOW_MS).toISOString();
  const [autoApproveSnapshot, recentSnapshot] = await Promise.all([
    adminDb.collection("campaigns")
      .where("autoApproveLiveSend", "==", true)
      .select(...CAMPAIGN_PROJECTION)
      .limit(CAMPAIGN_SCAN_LIMIT)
      .get(),
    adminDb.collection("campaigns")
      .where("updatedAtIso", ">=", recentSinceIso)
      .select(...CAMPAIGN_PROJECTION)
      .limit(CAMPAIGN_SCAN_LIMIT)
      .get(),
  ]);
  const byId = new Map<string, CampaignDocInput>();
  for (const doc of [...autoApproveSnapshot.docs, ...recentSnapshot.docs]) {
    if (byId.has(doc.id)) continue;
    byId.set(doc.id, { id: doc.id, ...(doc.data() ?? {}) });
  }
  return [...byId.values()].filter((campaign) => {
    const state = resolveCampaignOperationalState(campaign);
    return state === "active" || state === "paused";
  });
}

/** 전체 파이프라인(캠페인 조회 → 캠페인별 카운트 → 행). 실패는 위로 던진다 — Safe 래퍼가 흡수한다. */
export async function collectPerCampaignReportRows(nowMs: number): Promise<PerCampaignReportRow[]> {
  const campaigns = await fetchQualifyingCampaigns(nowMs);
  if (campaigns.length === 0) return [];
  const programIds = [...new Set(campaigns.map((campaign) => stringField(campaign, "programId")).filter(Boolean))];
  const [counts, programSnapshots] = await Promise.all([
    Promise.all(campaigns.map((campaign) => fetchCampaignOutreachCounts(campaign.id, nowMs))),
    programIds.length > 0
      ? adminDb.getAll(...programIds.map((programId) => adminDb.collection("programs").doc(programId)), {
          fieldMask: PROGRAM_VERTICAL_PROJECTION,
        })
      : Promise.resolve([]),
  ]);
  const countsByCampaignId = new Map(campaigns.map((campaign, index) => [campaign.id, counts[index]]));
  const programsById = new Map(
    programSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [
      snapshot.id,
      { id: snapshot.id, ...(snapshot.data() ?? {}) },
    ]),
  );
  return buildPerCampaignReportRows(campaigns, countsByCampaignId, programsById);
}

/** 섹션 전체가 실패해도 리포트를 죽이지 않는다 — 다른 사이드 섹션(outreachSendHealthReport 등)과 같은 규약. */
export async function buildPerCampaignReportLinesSafe(now: Date = new Date()): Promise<string[]> {
  try {
    return formatPerCampaignReportLines(await collectPerCampaignReportRows(now.getTime()));
  } catch {
    console.warn("[slack-scheduled-reports]", JSON.stringify({ outcome: "source_unavailable", metric: "outreach_per_campaign" }));
    return [];
  }
}
