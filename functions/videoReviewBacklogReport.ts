// Flu bot scheduled reports — 검수 처리 백로그 + 결과 메일 dead_letter 부가 섹션 (W126).
//
// slackScheduledReportsHandler 가 덧붙이는 별도 축이다. 채널 분기는 slackScheduledReports.ts 의
// postScheduledReportToSlack 이 담당한다 — **이 모듈은 채널을 모른다**(W118 emailInventoryReport 와
// 같은 경계). W68-B/W73 정본 4지표(발송/회신/Apply/영상 제출)는 "얼마나 들어왔나"의 축이고,
// 이 섹션은 "얼마나 안 나갔나"의 축이라 파일을 분리한다.
//
// 축 선택 근거:
//   ① 백로그 = `scp_video_review_state` 의 `state == queued`. 레거시 별칭 `pending` 은 읽기 시점에
//      queued 로 정규화되지만 **저장된 값은 그대로**라(videoReviewTransitionCore.normalize…),
//      단일 필드 `in` 으로 둘 다 센다. 단일 필드 조건이라 신규 복합 인덱스가 필요 없다
//      (W75 P0-1 전례: 인덱스 누락은 매시간 전사한다).
//   ② 최장 체류 = queued 행의 `currentRevisionSubmittedAtIso` 최솟값. `updatedAtIso` 를 쓰지 않는
//      이유는 scpVideoRevisionIngress 주석이 못박은 그대로다 — 판정·콜백으로 갱신되므로 제출
//      시각의 대체값이 아니다. orderBy 로 뽑으면 (state, currentRevisionSubmittedAtIso) 복합
//      인덱스가 필요해지므로, **상한 있는 스캔 + 메모리 최솟값**으로 인덱스 없이 구한다.
//   ③ dead_letter = `scp_video_result_mail_outbox` 의 `deliveryState == "dead_letter"`.
//      `suppressed` 는 실패가 아니라 결정적 차단이라 섞지 않는다(W62e-MAJ-A). `retryable_failed`
//      는 아직 재시도 예정이라 "발생 알림" 축이 아니다(검수 탭 필터가 그쪽을 담당한다).
//
// COST-P0-006: 일 1회 · 쿼리 3개. `.count()` 2건은 집계 쿼리라 인덱스 엔트리 1000개당 1 read 이고,
//   체류 스캔만 문서를 읽는다(상한 QUEUE_AGE_SCAN_LIMIT + 1 = 301건). 실측 백로그가 수십 건
//   규모라 상한에 닿지 않는다. 읽은 건수는 buildVideoReviewBacklogSectionSafe 가 한 줄로 남긴다.
//
// SEC-P0-009: 제출 id·크리에이터·메일 본문·provider 오류 원문은 담지 않는다. 건수와 일수만 렌더/로그한다.

import type { Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 백로그로 세는 저장값 — **검수 탭의 `ACTION_REQUIRED_STATES` 와 같은 5종**이다.
 *
 * W126 [적대 리뷰 M4]: 처음에는 `queued`(+레거시 별칭 `pending`)만 셌는데, 그러면 AI 가
 * "사람이 처리하라"고 올린 `human_review_required` 가 백로그 알림에서 통째로 빠진다 — 가장
 * 확실하게 사람 손이 필요한 상태가 빠지는 셈이다. `in_review`(운영자가 열어 두고 확정 안 한
 * 건)·`needs_review` 도 탭에서는 "처리 필요" 칸에 있다. 리포트 숫자와 탭 숫자가 갈리면
 * 리포트를 안 믿게 되므로 축을 맞춘다. 여전히 **단일 필드 `in`** 이라 인덱스는 불필요하다.
 */
const BACKLOG_STATES = [
  "queued",
  "in_review",
  "human_review_required",
  "pending",
  "needs_review",
] as const;
/**
 * 최장 체류를 구하려고 실제 문서를 읽는 상한. 상한에 닿으면 최솟값이 **표본** 최솟값이라
 * 실제 최장 체류를 과소평가할 수 있다 — 그 사실을 facts 에 실어 렌더가 밝힌다.
 */
const QUEUE_AGE_SCAN_LIMIT = 300;

export type VideoReviewBacklogSource = {
  /** queued(+pending) 행 수. 집계 쿼리 — 문서를 읽지 않는다. */
  queuedCount(): Promise<number>;
  /** queued(+pending) 행의 제출 시각 ISO 목록(상한 QUEUE_AGE_SCAN_LIMIT + 1). */
  queuedSubmittedAtIsos(): Promise<string[]>;
  /** 결과 메일 아웃박스의 전체 dead_letter 행 수. 집계 쿼리. */
  deadLetterCount(): Promise<number>;
  /** 운영자가 수동 확인한 dead_letter 행 수. 집계 쿼리. */
  acknowledgedDeadLetterCount(): Promise<number>;
};

export type VideoReviewBacklogFacts = {
  readonly backlogCount: number;
  /** 가장 오래 대기한 행의 체류 일수. 백로그가 0 이거나 제출 시각이 전부 결손이면 null. */
  readonly oldestWaitingDays: number | null;
  /** 체류 스캔이 상한에 닿아 표본 최솟값만 본 경우 true. */
  readonly ageSampleTruncated: boolean;
  /** 백로그는 있는데 제출 시각을 하나도 못 읽은 경우 true(체류를 "0일"로 단정하지 않기 위한 축). */
  readonly ageUnavailable: boolean;
  readonly deadLetterCount: number;
  readonly docsRead: number;
};

export function createFirestoreVideoReviewBacklogSource(
  db: Firestore = adminDb,
): VideoReviewBacklogSource {
  const backlog = () => db.collection("scp_video_review_state")
    .where("state", "in", [...BACKLOG_STATES]);
  return {
    queuedCount: async () => {
      const snapshot = await backlog().count().get();
      return Number(snapshot.data().count ?? 0);
    },
    queuedSubmittedAtIsos: async () => {
      const snapshot = await backlog()
        .select("currentRevisionSubmittedAtIso")
        .limit(QUEUE_AGE_SCAN_LIMIT + 1)
        .get();
      return snapshot.docs.map((doc) => {
        const value = doc.data()?.currentRevisionSubmittedAtIso;
        return typeof value === "string" ? value : "";
      });
    },
    deadLetterCount: async () => {
      const snapshot = await db.collection("scp_video_result_mail_outbox")
        .where("deliveryState", "==", "dead_letter")
        .count()
        .get();
      return Number(snapshot.data().count ?? 0);
    },
    acknowledgedDeadLetterCount: async () => {
      const snapshot = await db.collection("scp_video_result_mail_outbox")
        .where("deliveryState", "==", "dead_letter")
        .where("deadLetterAcknowledged", "==", true)
        .count()
        .get();
      return Number(snapshot.data().count ?? 0);
    },
  };
}

/** ISO 문자열의 밀리초. 파싱 불가면 null — 결손을 0(=1970)으로 읽으면 체류가 폭발한다. */
function isoMillis(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export async function collectVideoReviewBacklogFacts(
  nowMs: number,
  source: VideoReviewBacklogSource = createFirestoreVideoReviewBacklogSource(),
): Promise<VideoReviewBacklogFacts> {
  // 세 축은 서로 의존하지 않는다 — 병렬로 모은다.
  const [backlogCount, submittedAtIsos, deadLetterCount, acknowledgedDeadLetterCount] = await Promise.all([
    source.queuedCount(),
    source.queuedSubmittedAtIsos(),
    source.deadLetterCount(),
    source.acknowledgedDeadLetterCount(),
  ]);
  const ageSampleTruncated = submittedAtIsos.length > QUEUE_AGE_SCAN_LIMIT;
  const sample = submittedAtIsos.slice(0, QUEUE_AGE_SCAN_LIMIT);
  let oldestMs: number | null = null;
  for (const iso of sample) {
    const ms = isoMillis(iso);
    if (ms === null) continue;
    if (oldestMs === null || ms < oldestMs) oldestMs = ms;
  }
  // 미래 시각(시계 편차·수기 보정)은 음수 체류가 되므로 0 으로 눌러 둔다.
  const oldestWaitingDays = oldestMs === null
    ? null
    : Math.max(0, Math.floor((nowMs - oldestMs) / DAY_MS));
  return {
    backlogCount,
    oldestWaitingDays,
    ageSampleTruncated,
    ageUnavailable: backlogCount > 0 && oldestMs === null,
    deadLetterCount: Math.max(0, deadLetterCount - acknowledgedDeadLetterCount),
    docsRead: sample.length,
  };
}

export function formatVideoReviewBacklogSection(facts: VideoReviewBacklogFacts): string {
  const count = facts.backlogCount.toLocaleString("ko-KR");
  // 체류를 못 구한 경우 "0일"로 쓰지 않는다 — 이 파일 전체의 규율(측정 불가는 측정 불가로 쓴다).
  const agePart = facts.oldestWaitingDays === null
    ? (facts.ageUnavailable ? "최장 체류 측정 불가(제출 시각 결손)" : null)
    : `최장 체류 ${facts.oldestWaitingDays.toLocaleString("ko-KR")}일`
      + (facts.ageSampleTruncated ? "(표본 하한)" : "");
  // 축이 5종이므로 문구도 "미검수 대기"가 아니라 탭과 같은 "처리 필요"다.
  const backlogLine = agePart
    ? `• 처리 필요 백로그: ${count}건 · ${agePart}`
    : `• 처리 필요 백로그: ${count}건`;
  // dead_letter 는 0 이어도 한 줄을 남긴다 — 줄이 사라지면 "발생 없음"과 "섹션이 죽었다"가
  //   구분되지 않는다(실패 격리 폴백이 별도 문구를 쓰는 이유와 같다).
  const deadLetterLine = facts.deadLetterCount > 0
    ? `• 결과 메일 dead_letter: ${facts.deadLetterCount.toLocaleString("ko-KR")}건 ⚠️ 재발송 불가 — 수동 확인 필요`
    : "• 결과 메일 dead_letter: 없음";
  return ["*── 검수 백로그*", backlogLine, deadLetterLine].join("\n");
}

/**
 * 실패 격리: 이 섹션 산출이 죽어도 나머지 리포트는 그대로 나가야 한다(W118 과 같은 규약).
 * 스케줄은 retryCount:0 이라 한 번 던지면 그날 리포트가 통째로 사라진다.
 * 기본 source 생성도 try **안**에서 한다 — 밖에서 평가되면 팩토리 자체가 던질 때 격리가 무너진다.
 */
export async function buildVideoReviewBacklogSectionSafe(
  nowMs: number,
  source?: VideoReviewBacklogSource,
): Promise<string> {
  const startedAtMs = Date.now();
  try {
    const activeSource = source ?? createFirestoreVideoReviewBacklogSource();
    const facts = await collectVideoReviewBacklogFacts(nowMs, activeSource);
    // COST-P0-006: 건수만(SEC-P0-009). 집계 쿼리 3건은 문서를 읽지 않으므로 docsRead 에서 뺀다.
    console.log("[slack-scheduled-reports]", JSON.stringify({
      section: "video_review_backlog",
      docsRead: facts.docsRead,
      scanLimit: QUEUE_AGE_SCAN_LIMIT,
      aggregateQueries: 3,
      truncated: facts.ageSampleTruncated,
      durationMs: Date.now() - startedAtMs,
    }));
    return formatVideoReviewBacklogSection(facts);
  } catch {
    console.warn("[slack-scheduled-reports]", JSON.stringify({
      outcome: "source_unavailable",
      section: "video_review_backlog",
    }));
    return "*── 검수 백로그*\n• 검수 백로그: **측정 불가** — 백로그 섹션 산출 실패";
  }
}
