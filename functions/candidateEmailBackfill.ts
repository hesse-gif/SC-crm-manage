/**
 * W84 — **기존 무이메일 후보의 설명란 이메일 보충.**
 *
 * ■ 왜 여기인가 (W77-④ 반려 사유를 정면으로 푼다)
 *   W77-④는 별도 백필 레인이었고 두 가지로 반려됐다:
 *     P0-B 마커를 `candidate_pool` 에 `set(merge)` 로 남겨 **스텁을 신규 생성**했다
 *          (마커가 닿는 채널은 정의상 pool 에 없으므로 항상 생성 → 승격 dedup 영구 오염).
 *     P0-C 캐낸 이메일이 `campaign_candidates` 에 닿을 경로가 0이라 **지표에도 발송에도** 안 갔다.
 *   이번에는 레인을 만들지 않는다. **hydration 시점**에 처리한다 — 그 자리는
 *     · 대상이 이미 pool 에 있는 문서다(스텁 생성 여지 자체가 없다 → P0-B 소멸)
 *     · 캠페인 스코프가 살아있다(campaign_candidates 주소를 계산할 수 있다 → P0-C 소멸)
 *     · 관측이 videoId 를 이미 들고 있다(추가 조회 0)
 *
 * ■ 실측 근거 (2026-08-15)
 *   고유 관측 채널 1,166 · 이미 이메일 보유 33 · 증분 대상 1,133
 *   [A] 보유 videoId 설명란: 19/250 = **7.6%**, 8유닛  → 이메일 1개당 0.42유닛
 *   [B] uploads 50개 확장 : 1/60  = 1.7%,  60유닛 → 이메일 1개당 60유닛 (**140배 비쌈**)
 *   그래서 확장은 하지 않는다. 관측이 이미 가진 videoId 범위 안에서만 캔다.
 *
 * ■ 재시도 마커 (W77 P0-4 재발 금지)
 *   같은 채널을 매 관측마다 다시 캐면 낭비다. 그래서 시도 시각·횟수를 남긴다 —
 *   단 **판정 필드로만** 쓴다. W77-④는 `pendingSince` 를 부등호 쿼리 축으로 써서 소진 문서가
 *   큐 머리를 영구 점유했다(신규 기아). 여기서는 쿼리하지 않는다: 대상은 언제나 "이번 관측에
 *   들어온 채널"이고, 마커는 그중 건너뛸 것을 고르는 데만 쓴다. 큐가 없으니 점유도 없다.
 */
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { campaignCandidateLinkId } from "./candidateScope";

export const CANDIDATE_EMAIL_BACKFILL_CAPS = Object.freeze({
  /** 한 배치에서 보충을 시도할 최대 채널 수(COST 상한). */
  channelsPerBatch: 200,
  /** 이만큼 시도했는데도 못 캤으면 더 안 캔다(설명란에 없다는 뜻이다). */
  maxAttempts: 3,
  /** 같은 채널을 다시 캐기까지의 최소 간격. 새 영상이 올라올 시간을 준다. */
  retryAfterMs: 14 * 24 * 60 * 60 * 1000,
});

export type CandidateEmailBackfillTarget = {
  readonly channelId: string;
  readonly videoIds: readonly string[];
};

export type CandidateEmailBackfillResult = {
  /** 실제로 설명란을 본 채널 수. */
  readonly examined: number;
  /** 이메일을 캐서 기존 문서에 merge 한 수. */
  readonly merged: number;
  /** 마커 때문에 건너뛴 수(시도 상한·재시도 간격). */
  readonly skipped: number;
};

function int(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 마커로 이번에 캘 대상을 고른다(순수 함수).
 *
 * 쿼리가 아니라 **판정**이다 — 대상 목록은 이미 이번 관측이 정했고, 여기서는 그중 건너뛸 것만
 * 고른다. 그래서 소진 문서가 무언가를 점유할 수 없다.
 */
export function shouldAttemptEmailBackfill(
  doc: Record<string, unknown>,
  nowMs: number,
  caps = CANDIDATE_EMAIL_BACKFILL_CAPS,
): boolean {
  if (int(doc.descriptionBackfillAttempts) >= caps.maxAttempts) return false;
  const lastMs = Date.parse(typeof doc.descriptionBackfillLastAttemptIso === "string"
    ? doc.descriptionBackfillLastAttemptIso
    : "");
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= caps.retryAfterMs;
}

export type CandidateEmailBackfillDependencies = {
  /** 관측이 가진 videoId 들의 설명란. 추가 조회 없이 hydration 이 이미 받아온 것을 넘긴다. */
  readonly descriptionByVideoId: ReadonlyMap<string, string>;
  /** 설명란 → 이메일. discovery 의 정본 추출기를 그대로 쓴다(규칙 복제 금지). */
  readonly mineEmail: (descriptions: string) => string | null;
  /** 이메일 → emailStatus 재판정. 기존 규칙을 그대로 쓴다. */
  readonly classifyEmail: (email: string) => string;
};

/**
 * 기존 후보 문서에 이메일을 **merge** 한다.
 *
 * ⚠️ **신규 문서를 절대 만들지 않는다.** 존재를 먼저 읽고, 없으면 건너뛴다.
 *   `set(merge)` 는 문서가 없으면 만들어 버리고, 그게 W77-④ P0-B 오염의 정체였다.
 *   `update()` 는 없는 문서에서 실패하므로 여기서는 그쪽을 쓴다 — 실패가 곧 안전이다.
 */
export async function backfillCandidateEmailsFromDescriptions(input: {
  readonly targets: readonly CandidateEmailBackfillTarget[];
  readonly campaignId: string;
  readonly canonicalProgramId: string;
  readonly nowIso: string;
  readonly dependencies: CandidateEmailBackfillDependencies;
  readonly caps?: typeof CANDIDATE_EMAIL_BACKFILL_CAPS;
}): Promise<CandidateEmailBackfillResult> {
  const caps = input.caps ?? CANDIDATE_EMAIL_BACKFILL_CAPS;
  const nowMs = Date.parse(input.nowIso);
  const targets = input.targets.slice(0, caps.channelsPerBatch);
  if (targets.length === 0) return { examined: 0, merged: 0, skipped: 0 };

  const refs = targets.map((target) => adminDb.collection("candidate_pool").doc(target.channelId));
  // R1-P2: 스코프 참여 문서도 **한 번에** 읽는다. 종전에는 merge 대상마다 get() 을 날려
  //   N+1 이었다(배치 200이면 최대 200 왕복). 두 컬렉션을 각각 배치로 읽는다.
  const scopedRefs = targets.map((target) => adminDb.collection("campaign_candidates").doc(
    campaignCandidateLinkId(input.canonicalProgramId, input.campaignId, target.channelId),
  ));
  const [snapshots, scopedSnapshots] = await Promise.all([
    adminDb.getAll(...refs),
    adminDb.getAll(...scopedRefs),
  ]);

  let examined = 0;
  let merged = 0;
  let skipped = 0;
  const writer = adminDb.batch();
  let writes = 0;

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const snapshot = snapshots[index];
    // 문서가 없으면 **아무것도 하지 않는다**(스텁 생성 금지).
    if (!snapshot?.exists) continue;
    const data = snapshot.data() ?? {};
    if (typeof data.email === "string" && data.email.includes("@")) continue;
    if (!shouldAttemptEmailBackfill(data, nowMs, caps)) {
      skipped += 1;
      continue;
    }

    const descriptions = target.videoIds
      .map((videoId) => input.dependencies.descriptionByVideoId.get(videoId) ?? "")
      .filter(Boolean)
      .join("\n");
    if (!descriptions) continue;
    examined += 1;

    const mined = input.dependencies.mineEmail(descriptions);
    if (!mined) {
      // 못 캔 것도 시도로 남긴다 — 안 그러면 같은 채널을 영원히 다시 캔다.
      writer.update(snapshot.ref, {
        descriptionBackfillAttempts: FieldValue.increment(1),
        descriptionBackfillLastAttemptIso: input.nowIso,
      });
      writes += 1;
      continue;
    }

    const emailStatus = input.dependencies.classifyEmail(mined);
    const emailFields = {
      email: mined,
      // 기존 규칙으로 재판정한다. 캐낸 이메일이라고 자격을 올려주지 않는다 —
      //   role-account 같은 부류는 뒤의 safety/quarantine 이 그대로 막는다(계약으로 고정).
      emailStatus,
      emailSource: "video_description",
      // W84 관측축: 설명란 출처를 분리해 바운스율을 따로 본다(소비자: 스윕 로그).
      descriptionSourced: true,
      updatedAtIso: input.nowIso,
    };
    writer.update(snapshot.ref, {
      ...emailFields,
      descriptionBackfillAttempts: FieldValue.increment(1),
      descriptionBackfillLastAttemptIso: input.nowIso,
    });
    writes += 1;

    // P0-C: **발송 가능 후보에 실제로 닿게 한다.** 전역 pool 만 고치면 지표(campaign_candidates)
    //   에도 발송 경로에도 아무 변화가 없다 — W77-④가 정확히 그래서 순효과 음수였다.
    //   스코프가 살아있는 지금 ccl_ 주소를 계산할 수 있다.
    const scopedSnapshot = scopedSnapshots[index];
    // 여기서도 신규 생성 금지 — 참여 문서가 없으면 이 캠페인 대상이 아니다.
    if (scopedSnapshot?.exists) {
      writer.update(scopedSnapshot.ref, emailFields);
      writes += 1;
    }
    merged += 1;
  }

  if (writes > 0) await writer.commit();
  return { examined, merged, skipped };
}
