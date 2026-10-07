// Flu bot scheduled reports — 이메일 재고 부가 섹션.
//
// slackScheduledReportsHandler 가 C0ARCM9CZNG 채널에만 덧붙이는 별도 축이다. 채널 분기는
// slackScheduledReports.ts 의 postScheduledReportToSlack 이 담당한다 — 이 모듈은 채널을 모른다.
// W68-B/W73 정본 4지표(발송/회신/Apply/영상 제출)와는 무관한 재고 스냅샷이라 별도 파일로 뺐다.
//
// 축 선택 근거(2026-08-24 프로드 실측, 헤세 확정):
//   집계 원장은 campaign_candidates 다. candidate_pool 은 8/21 heepsy 시드 이후 신규 유입이
//   0 인 스냅샷 축이라(실측) 재고·전일 수치 어느 쪽에도 못 쓴다. discovery_runs 의
//   materialization 카운터도 쓰지 않는다 — emailsFound 는 런 단위 관측치라 재관측을 다시 세고
//   (연인원), newUnique 도 문서 createTime 기준 순증과 일치하지 않는 것을 실측으로 확인했다.
//   유일하게 정직한 순증 축은 문서 createTime 메타데이터다(select 프로젝션에서도 항상 실린다).
//   R1-H3(적대 리뷰): createTime 은 문서 **생성** 시각이다 — campaign_candidates 문서 ID 는
//   sha256(program, campaign, candidateId) 라 repair/refill 웨이브가 기존 채널을 새 캠페인
//   문서로 다시 만들면 그 채널의 "발굴"은 예전인데 createTime 은 어제가 된다. 그래서 이 축이
//   세는 것은 "발굴 신규"가 아니라 "스코프(캠페인) 편입 신규"다 — 렌더 문구가 이를 반영한다.
//
// 집계 방식: campaign_candidates 풀스캔(candidateId·email·국가·heldContactEvidence 필드만 select,
//   페이지 1000, 최대 MAX_SCAN_PAGES 페이지 — H1). 문서는 (프로그램×캠페인×채널) 참여 단위라 같은
//   채널이 여러 캠페인에 중복 등장한다 — candidateId 로 dedupe 해 "채널" 단위로 센다. 전일 신규 =
//   채널의 최초 등장(createTime 최솟값)이 전일 KST 창 안인 채널. 국가 사다리는
//   applicationDeclaredAudienceCountry 의 normalizedIsoAlpha2 로 creatorCountry→country→region
//   순(발굴 파이프라인 실사용 필드) — 더 앞 순위 필드가 나중 문서에서 나와도 승격한다(M2).
//   COST-P0-006: 일 1회 · 문서당 1 read — 2026-08 기준 약 18k reads/일(≈$0.011). A4 세그먼트
//   집계는 campaign_candidates 가 아니라 candidate_pool 을 도는 별도 축이라 컬렉션도 겹치지 않는다
//   (A4 표는 cap 절단으로 부정확해 이 모듈은 재사용하지 않는다).
//
// SEC-P0-009: 채널명·이메일 원문은 담지 않는다. 건수만 렌더/로그한다.

import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { validEmailField } from "./admin";
import { normalizedIsoAlpha2 } from "./applicationDeclaredAudienceCountry";
import type { ReportWindow } from "./slackScheduledReports";

const CAMPAIGN_CANDIDATE_SCAN_PAGE_SIZE = 1_000;
/** H1: 2026-08 기준 실측 ~18k 문서(≈19페이지) 대비 3배 여유. 상한 도달 시 무한 루프 대신 부분 집계로 중단한다. */
const MAX_SCAN_PAGES = 60;
const COUNTRY_PRIORITY_FIELDS = ["creatorCountry", "country", "region"] as const;
const TOP_COUNTRY_LIMIT = 3;
/** H3: 전일 신규 편입이 전체 채널의 이 비율을 넘으면 재편입 웨이브 의심을 표시한다. */
const REINGESTION_WAVE_RATIO = 0.2;
/** R3: 전체 채널이 이 미만이면(스테이징·초기 데이터) 비율만으로 상시 점등되지 않게 경보를 건너뛴다. */
const REINGESTION_WAVE_MIN_TOTAL_CHANNELS = 500;

export type EmailInventoryCountryCount = {
  readonly country: string;
  readonly count: number;
};

/** 26-08-27: 누적 발굴 대비 아웃리치 소진 축. 전수 대조에 실패하면 measured:false 다. */
export type EmailInventoryConsumption = {
  readonly measured: boolean;
  /** 아웃리치(campaign_outreach)가 이미 들고 있는 고유 주소 수. */
  readonly outreachAddresses: number;
  /** 누적 발굴 주소 중 아웃리치에 아직 안 들어간 수 = 실제로 새로 보낼 수 있는 물량. */
  readonly untouched: number;
};

export type EmailInventoryFacts = {
  /** candidateId 로 dedupe 한 채널 수. */
  readonly totalChannels: number;
  readonly totalWithEmail: number;
  readonly consumption: EmailInventoryConsumption;
  /** 미상 제외 상위 3개국(이메일 보유 채널 기준). 보유가 0이거나 전부 미상이면 빈 배열. */
  readonly topCountries: readonly EmailInventoryCountryCount[];
  readonly previousDay: {
    /** R1-H3: "발굴 신규"가 아니라 캠페인 스코프 편입 신규(문서 생성) — repair/refill 웨이브도 센다. */
    readonly newChannels: number;
    /** 전일 신규 채널 중 이메일 보유 — "이메일 N건 확보" 표현 금지(관측 혼동 방지, 헤세 지시). */
    readonly newChannelsWithEmail: number;
  };
  /** H1: MAX_SCAN_PAGES 상한에 도달해 스캔을 중단했다 — 전수가 아니라 부분 집계. */
  readonly partial: boolean;
  /** M6 계측용: 읽은 문서 총수. */
  readonly docsRead: number;
  /** M6 계측용: 실행한 페이지 수. */
  readonly pages: number;
  /** M3: candidateId 결측이라 채널 집계에서 제외한 행 수. */
  readonly unidentifiedRows: number;
};

type CampaignCandidateRow = Record<string, unknown> & {
  id: string;
  /**
   * 문서 createTime 메타데이터(ms). 없으면 0. 채널 집계에서는 ChannelAggregate.hasMissingCreateTime
   *   가 이 결측을 도착 순서와 무관하게 잡아내 그 채널을 영원히 신규 판정에서 제외한다(R1, 보수적 방향).
   */
  createTimeMs: number;
};

export type EmailInventorySource = {
  /** campaign_candidates 한 페이지(문서 ID 순 · candidateId+email+국가+heldContactEvidence 필드만). 짧은 페이지 = 끝. */
  campaignCandidatePage(afterId: string | null): Promise<CampaignCandidateRow[]>;
  /**
   * 26-08-27 [헤세 지시]: 아웃리치가 이미 가져간 주소 한 페이지(creatorEmail 만). 미구현이면 생략
   *   가능하다 — 그때 소진 축은 "미측정"으로 렌더된다(기존 3행 동작 불변).
   */
  campaignOutreachEmailPage?(afterId: string | null): Promise<{ id: string; email: string }[]>;
};

function rowOf(doc: QueryDocumentSnapshot): CampaignCandidateRow {
  return {
    ...(doc.data() ?? {}),
    id: doc.id,
    createTimeMs: doc.createTime ? doc.createTime.toMillis() : 0,
  };
}

/**
 * H2: admin.ts 의 validEmailField 계약(도메인 점 필수)을 정본으로 따른다 — 기존 `.includes("@")`
 *   는 "a@" 같은 값도 보유로 오판했다. admin.ts import 는 순환 위험 우려가 있어 먼저 시도했고,
 *   빌드로 순환 없음을 확인했다(2026-08-24) — 그래서 정규식을 복제하지 않고 그대로 재사용한다.
 */
function hasEmail(value: unknown): boolean {
  return validEmailField(value).length > 0;
}

/**
 * H2+M8: 국가 보류(unknownCountryHeld) 채널은 worker 가 email:null 로 저장하고 대신
 *   heldContactEvidence.email 에 실측 주소를 싣는다(worker/ytdlp-worker/index.mjs). 정식 email
 *   필드가 비어 있다고 재고에서 빠지면 실제로 확보된 연락처가 과소집계된다.
 */
function heldEmail(row: CampaignCandidateRow): unknown {
  const evidence = row.heldContactEvidence;
  return evidence && typeof evidence === "object" ? (evidence as Record<string, unknown>).email : undefined;
}

function rowHasEmail(row: CampaignCandidateRow): boolean {
  return hasEmail(row.email) || hasEmail(heldEmail(row));
}

/** 정규화된 주소(소문자·트림). 유효하지 않으면 빈 문자열 — validEmailField 계약 그대로. */
function rowEmailValue(row: CampaignCandidateRow): string {
  return validEmailField(row.email) || validEmailField(heldEmail(row));
}

type CountryMatch = { readonly code: string; readonly rank: number };

/** creatorCountry(rank0) → country(rank1) → region(rank2) 사다리. 처음 맞은 유효 ISO alpha-2 에서 멈춘다. */
function firstCountry(row: CampaignCandidateRow): CountryMatch | null {
  for (let rank = 0; rank < COUNTRY_PRIORITY_FIELDS.length; rank++) {
    const code = normalizedIsoAlpha2(row[COUNTRY_PRIORITY_FIELDS[rank]]);
    if (code) return { code, rank };
  }
  return null;
}

/** H4: db 주입 가능 — 테스트가 fake db 로 collection→orderBy→select→limit→startAfter→get 체인을 검증한다. */
export function createFirestoreEmailInventorySource(db: Firestore = adminDb): EmailInventorySource {
  return {
    campaignCandidatePage: async (afterId) => {
      let query = db.collection("campaign_candidates")
        .orderBy(FieldPath.documentId())
        .select("candidateId", "email", "creatorCountry", "country", "region", "heldContactEvidence")
        .limit(CAMPAIGN_CANDIDATE_SCAN_PAGE_SIZE);
      if (afterId) query = query.startAfter(afterId);
      const snapshot = await query.get();
      return snapshot.docs.map(rowOf);
    },
    // COST-P0-006: 일 1회 · 문서당 1 read. 2026-08 기준 약 11k reads/일(≈$0.007) 추가 —
    //   기존 candidates 스캔(≈18k)과 합쳐 하루 30k 미만이다.
    campaignOutreachEmailPage: async (afterId) => {
      let query = db.collection("campaign_outreach")
        .orderBy(FieldPath.documentId())
        .select("creatorEmail")
        .limit(CAMPAIGN_CANDIDATE_SCAN_PAGE_SIZE);
      if (afterId) query = query.startAfter(afterId);
      const snapshot = await query.get();
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        email: validEmailField((doc.data() ?? {}).creatorEmail),
      }));
    },
  };
}

type ChannelAggregate = {
  hasEmail: boolean;
  /**
   * 26-08-27: 소진 대조용 정규화 주소(없으면 null). **집계에만 쓰고 렌더·로그에는 절대 싣지
   *   않는다**(SEC-P0-009) — formatEmailInventorySection 은 건수만 출력한다.
   */
  email: string | null;
  country: string | null;
  /** M2: 낮을수록 우선(0=creatorCountry). 국가 미상이면 Infinity — 더 낮은 rank 가 나오면 교체한다. */
  countryRank: number;
  firstSeenMs: number;
  /**
   * R1: 채널의 참여 행 중 하나라도 createTimeMs<=0(결측)이면 true — 도착 순서와 무관하게
   *   마킹한다. firstSeenMs 는 유효(>0) 값 중 최솟값만 반영하므로(M1), 결측 행이 먼저 오든
   *   나중에 오든 firstSeenMs 자체만으로는 결측 여부를 못 되짚는다 — 그래서 별도 플래그로 신규
   *   판정을 게이트한다(같은 채널 [1500, 0] 순서에서 newChannels 오판 방지).
   */
  hasMissingCreateTime: boolean;
};

export async function collectEmailInventoryFacts(
  window: ReportWindow,
  source: EmailInventorySource = createFirestoreEmailInventorySource(),
): Promise<EmailInventoryFacts> {
  const channels = new Map<string, ChannelAggregate>();
  let afterId: string | null = null;
  let pages = 0;
  let docsRead = 0;
  let unidentifiedRows = 0;
  // H1: 짧은 페이지(끝)를 보기 전에 루프가 끝났으면 상한에 걸려 중단한 것이다 — partial 로 표면화한다.
  let hitScanCap = true;
  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex++) {
    const page = await source.campaignCandidatePage(afterId);
    pages += 1;
    docsRead += page.length;
    for (const row of page) {
      // M3: candidateId 결측 행은 채널 정체성이 없다 — 문서 ID 폴백은 서로 다른 참여 행을
      //   별개 채널로 오분류할 수 있어 제거했다. 대신 unidentifiedRows 로 세서 계측 로그에 싣는다.
      if (typeof row.candidateId !== "string" || row.candidateId.length === 0) {
        unidentifiedRows += 1;
        continue;
      }
      const candidateId = row.candidateId;
      const rowEmail = rowHasEmail(row);
      const rowEmailAddress = rowEmailValue(row) || null;
      const rowCountry = firstCountry(row);
      const existing = channels.get(candidateId);
      if (!existing) {
        channels.set(candidateId, {
          hasEmail: rowEmail,
          email: rowEmailAddress,
          country: rowCountry?.code ?? null,
          countryRank: rowCountry?.rank ?? Infinity,
          firstSeenMs: row.createTimeMs,
          hasMissingCreateTime: row.createTimeMs <= 0,
        });
        continue;
      }
      existing.hasEmail = existing.hasEmail || rowEmail;
      if (!existing.email && rowEmailAddress) existing.email = rowEmailAddress;
      // M2: 국가 사다리 순위를 유지한다 — 더 낮은(우선) rank 의 국가가 나중 문서에서 나와도 교체한다.
      if (rowCountry && rowCountry.rank < existing.countryRank) {
        existing.country = rowCountry.code;
        existing.countryRank = rowCountry.rank;
      }
      // M1: createTime 결측(0)을 나중 값으로 승격하지 않는다 — firstSeenMs 는 유효(>0) 값 중
      //   최솟값만 갱신한다.
      if (row.createTimeMs > 0 && row.createTimeMs < existing.firstSeenMs) {
        existing.firstSeenMs = row.createTimeMs;
      }
      // R1: 결측이 어느 위치에서 오든(순서 무관) 이 채널을 영원히 신규 판정에서 제외한다 — [1500, 0]
      //   순서에서도 [0, 1500] 과 동일하게 보수적이어야 한다(firstSeenMs 값 자체에는 기대지 않는다).
      if (row.createTimeMs <= 0) {
        existing.hasMissingCreateTime = true;
      }
    }
    if (page.length < CAMPAIGN_CANDIDATE_SCAN_PAGE_SIZE) {
      hitScanCap = false;
      break;
    }
    afterId = page[page.length - 1].id;
  }

  const countryCounts = new Map<string, number>();
  let totalWithEmail = 0;
  let newChannels = 0;
  let newChannelsWithEmail = 0;
  for (const aggregate of channels.values()) {
    if (aggregate.hasEmail) {
      totalWithEmail += 1;
      if (aggregate.country) countryCounts.set(aggregate.country, (countryCounts.get(aggregate.country) ?? 0) + 1);
    }
    // R1: hasMissingCreateTime 채널은 firstSeenMs 값과 무관하게 신규 판정에서 제외한다(순서 무관 보수 게이트).
    if (!aggregate.hasMissingCreateTime && aggregate.firstSeenMs >= window.startMs && aggregate.firstSeenMs < window.endMs) {
      newChannels += 1;
      // L9(의도된 동작, 헤세 확인): 여기서 읽는 hasEmail 은 채널의 스캔 시점 **최종** 집계
      //   상태다 — 그 채널이 이 창 **안에서** 이메일을 확보했다는 뜻이 아니라, 창 밖 시점에
      //   나중에 확보한 경우도 포함한다. 별도 시점 조인은 하지 않는다.
      if (aggregate.hasEmail) newChannelsWithEmail += 1;
    }
  }
  const topCountries = [...countryCounts.entries()]
    .map(([country, count]) => ({ country, count }))
    .sort((left, right) => right.count - left.count || left.country.localeCompare(right.country))
    .slice(0, TOP_COUNTRY_LIMIT);
  // 26-08-27 [헤세 지시]: 위 숫자는 **누적 발굴**이지 보낼 수 있는 물량이 아니다. 실측(그날):
  //   누적 이메일 10,806채널인데 아웃리치가 이미 11,046주소를 가져가 미접촉은 931건뿐이었다 —
  //   리포트만 보면 "만 건 재고"로 읽혀 실제 고갈(약 10일치)이 가려진다. 그래서 소진 축을 같이 센다.
  //   대조는 정규화 주소 단위다(채널 단위가 아니다 — 아웃리치 행이 채널 id 를 안 들고 오기도 한다).
  const consumption = await collectOutreachConsumption(source, channels);

  return {
    totalChannels: channels.size,
    totalWithEmail,
    topCountries,
    previousDay: { newChannels, newChannelsWithEmail },
    consumption,
    partial: hitScanCap,
    docsRead,
    pages,
    unidentifiedRows,
  };
}

/**
 * 누적 발굴 주소 중 아웃리치가 아직 안 가져간 수를 센다. 소스가 이 페이지를 제공하지 않거나
 * 스캔 상한에 걸리면 `measured:false` 로 돌려 렌더가 "미측정"을 명시하게 한다 — 조용히 0 이나
 * 낙관적 추정치를 내지 않는다(이 축을 만든 이유 자체가 과대 표기 방지다).
 */
async function collectOutreachConsumption(
  source: EmailInventorySource,
  channels: ReadonlyMap<string, ChannelAggregate>,
): Promise<EmailInventoryConsumption> {
  if (!source.campaignOutreachEmailPage) return { measured: false, outreachAddresses: 0, untouched: 0 };
  const discovered = new Set<string>();
  for (const aggregate of channels.values()) {
    if (aggregate.email) discovered.add(aggregate.email);
  }
  const outreach = new Set<string>();
  let afterId: string | null = null;
  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex++) {
    const page = await source.campaignOutreachEmailPage(afterId);
    for (const row of page) {
      if (row.email) outreach.add(row.email);
    }
    if (page.length < CAMPAIGN_CANDIDATE_SCAN_PAGE_SIZE) {
      let untouched = 0;
      for (const email of discovered) {
        if (!outreach.has(email)) untouched += 1;
      }
      return { measured: true, outreachAddresses: outreach.size, untouched };
    }
    afterId = page[page.length - 1].id;
  }
  // 상한 도달 = 아웃리치 전수를 못 봤다 → 미접촉을 과대 계산하게 되므로 미측정으로 닫는다.
  return { measured: false, outreachAddresses: outreach.size, untouched: 0 };
}

export function formatEmailInventorySection(facts: EmailInventoryFacts): string {
  const countryLine = facts.topCountries.length > 0
    ? facts.topCountries.map((entry) => `${entry.country} ${entry.count.toLocaleString("ko-KR")}개`).join(" · ")
    : "해당 없음";
  // R4: 상한 도달로 중단된 스캔은 3행 전체가 부분 집계다 — 개별 라인 접미 대신 섹션 헤더에서 밝힌다.
  const header = facts.partial ? "*── 이메일 재고 (부분 집계)*" : "*── 이메일 재고*";
  // M7: 채널 수엔 "건" 대신 채널 단위를 쓴다.
  // 26-08-27 [헤세 지시]: "보유 이메일"은 **이미 다 쓴 주소까지 포함한 누적 발굴량**인데 그 이름
  //   때문에 "지금 보낼 수 있는 재고"로 읽혔다(실측: 누적 10,806 vs 실제 미접촉 931). 라벨에
  //   "누적 발굴"을 박고, 보낼 수 있는 물량은 아래 별도 행으로 분리한다.
  const holdingsLine = `• 누적 발굴(이메일 확보): ${facts.totalWithEmail.toLocaleString("ko-KR")}채널 `
    + `(전체 ${facts.totalChannels.toLocaleString("ko-KR")}채널 중) — 소진분 포함 누적치`;
  const consumption = facts.consumption;
  const sendableLine = consumption.measured
    ? `• 발송 가능 잔여: ${consumption.untouched.toLocaleString("ko-KR")}주소 미접촉 `
      + `(아웃리치 기소진 ${consumption.outreachAddresses.toLocaleString("ko-KR")}주소)`
    : "• 발송 가능 잔여: **미측정** — 아웃리치 대조 실패";
  // H3: repair/refill 웨이브가 기존 채널의 새 문서를 만들면 newChannels 는 스코프 편입 신규를
  //   센 것이지 발굴 순증이 아니다 — 비중이 크면(20% 초과) 이상치로 표시한다.
  // R3: 다만 전체 채널이 적으면(스테이징·초기 데이터) 비율만으로 상시 점등되므로 최소 베이스를 둔다.
  const reingestionSuspected = facts.totalChannels >= REINGESTION_WAVE_MIN_TOTAL_CHANNELS
    && facts.previousDay.newChannels > facts.totalChannels * REINGESTION_WAVE_RATIO;
  const reingestionSuffix = reingestionSuspected ? " (재편입 웨이브 의심 — 발굴 순증 아님)" : "";
  const newChannelsLine = `• 전일 신규 편입: 채널 ${facts.previousDay.newChannels.toLocaleString("ko-KR")}개 `
    + `· 그중 이메일 보유 ${facts.previousDay.newChannelsWithEmail.toLocaleString("ko-KR")}개${reingestionSuffix}`;
  return [
    header,
    holdingsLine,
    sendableLine,
    `• 메이저 3국: ${countryLine}`,
    newChannelsLine,
  ].join("\n");
}

/**
 * 실패 격리(헤세 지시): 이 섹션 산출이 죽어도 나머지 리포트는 그대로 나가야 한다.
 * W110 의 sourceUnavailable 표면화와 같은 결 — 조용히 0 을 찍지 않고 실패 사실을 한 줄로 남긴다.
 * L3: source 기본값 생성을 try **안**으로 옮긴다 — try 밖에서 평가되면
 *   createFirestoreEmailInventorySource 자체가 던질 때 이 함수가 실패 격리 없이 그대로 던진다.
 */
export async function buildEmailInventorySectionSafe(
  window: ReportWindow,
  source?: EmailInventorySource,
): Promise<string> {
  const startedAtMs = Date.now();
  try {
    const activeSource = source ?? createFirestoreEmailInventorySource();
    const facts = await collectEmailInventoryFacts(window, activeSource);
    // M6: 성공 경로 계측 — 건수만(SEC-P0-009). 실패 경로 로그는 아래 catch 가 별도로 남긴다.
    console.log("[slack-scheduled-reports]", JSON.stringify({
      section: "email_inventory",
      docsRead: facts.docsRead,
      pages: facts.pages,
      durationMs: Date.now() - startedAtMs,
      unidentifiedRows: facts.unidentifiedRows,
    }));
    return formatEmailInventorySection(facts);
  } catch {
    console.warn("[slack-scheduled-reports]", JSON.stringify({ outcome: "source_unavailable", section: "email_inventory" }));
    // L5: 실패 폴백도 다른 채널 문면과 마찬가지로 섹션 헤더를 먼저 얹는다.
    return "*── 이메일 재고*\n• 이메일 재고: **측정 불가** — 재고 섹션 산출 실패";
  }
}
