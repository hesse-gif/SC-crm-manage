// 표시용 영상 제목·썸네일의 정본 해석기. 화면마다 규칙을 다시 쓰면 또 갈리므로 여기 하나만 둔다.
//
// 배경(2026-07-26 운영 실측): 같은 사실이 여러 컬렉션에 흩어져 있다.
//   - `scp_video_review_state.title` 118건 = **전부** 등록 시점 사내 라벨
//   - `video_performance_report_rows.video.title` = 리페어로 일부만 진짜 제목
//   - `videos.title` = 원천. 단 이 안에서도 출처가 두 종류다.
// 그래서 `videos` 를 읽을 때도 그냥 쓰면 안 되고 동기화 표식으로 갈라야 한다:
//   - `metricsSyncedAtIso` 있음 → 매시 :40 스냅샷이 YouTube snippet 으로 갱신한 값. 진짜 제목.
//   - 없음 → 등록 당시 사내 라벨. 원장이 든 값과 같아서 바꿔 봐야 의미가 없다.
//
// 제목을 다른 컬렉션에 복사하지 말고 읽는 시점에 조인해라. 복사본은 원본이 갱신될 때마다 어긋난다.

// ⚠️ 이 모듈은 **의존성이 없어야 한다.** tests/u7-read-source-convergence.test.mjs 가 이 .ts 를
//    컴파일 없이 raw node ESM 으로 직접 import 한다 — 상대 import 를 하나라도 넣으면
//    (확장자 없는 경로가 node 에서 해석되지 않아) 그 테스트가 통째로 죽는다.
//    그래서 레지스트리를 여기서 읽지 않고, **이름을 받아** 라벨을 조립한다(의존성 역전).

/**
 * 한 게임 타이틀 이름이 만들어 내는 사내 라벨 표기들.
 *
 * 2026-09-05 다타이틀 전환 전에는 이 판정이 `"Legacy XP Hero content"` 처럼 XP Hero 를 상수로
 * 들고 있었다. 그러면 Snake Clash 행의 `"Snake Clash content"` 가 **진짜 제목으로 승격**돼
 * 정산·검수 화면에 사내 라벨이 영상 제목인 양 박힌다. 라벨 모양은 타이틀과 무관하게 같으므로
 * 이름만 받아 조립한다 — 이름의 출처는 항상 프로그램 타이틀 레지스트리다.
 */
export function internalVideoTitleLabelsForName(name: string): string[] {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) return [];
  return [`${trimmedName} content`, `Legacy ${trimmedName} content`];
}

/**
 * 등록 시점에 붙는 사내 라벨 중 **타이틀 이름과 무관한 것들**. 정산·검수 화면에 실제 제목인 양
 * 박히면 안 된다. 타이틀에서 파생되는 라벨은 위 `internalVideoTitleLabelsForName` 이 만들고,
 * 레지스트리를 아는 호출부가 `titleNames` 로 넘긴다(아래 두 함수의 선택 인자).
 *
 * 역사적 리터럴 2종("Legacy XP Hero content" / "XP Hero content")도 그대로 남는다 — 그건 정책이
 * 아니라 **이미 저장된 데이터**다(운영 실측: `scp_video_review_state` 118건이 이 라벨).
 * 레지스트리에서 XP Hero 가 빠지더라도 그 행들은 계속 라벨로 인식돼야 한다.
 */
export const INTERNAL_VIDEO_TITLE_LABELS: ReadonlySet<string> = new Set([
  "Legacy XP Hero content",
  "XP Hero content",
  "SCP 합격 영상",
]);

export type VideoTitleSource = "youtube_snapshot" | "ledger" | "none";

export interface ResolvedVideoTitle {
  title: string | null;
  source: VideoTitleSource;
}

function trimmed(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * 사내 라벨이거나 빈 값이면 실제 제목으로 인정하지 않는다.
 *
 * `titleNames` 는 레지스트리를 아는 호출부(예: 검수 콜러블)가 넘기는 **등록된 게임 타이틀 이름들**
 * 이다. 넘기지 않으면 역사적 라벨만 본다 — 기존 호출부의 오늘 동작 그대로다.
 */
export function isInternalVideoTitleLabel(
  value: unknown,
  titleNames: readonly string[] = [],
): boolean {
  const text = trimmed(value);
  if (text === "") return true;
  if (INTERNAL_VIDEO_TITLE_LABELS.has(text)) return true;
  return titleNames.some((name) => internalVideoTitleLabelsForName(name).includes(text));
}

/**
 * 스냅샷이 확인해 준 제목만 승격하고, 아니면 원장 값을 출처 표시와 함께 그대로 둔다.
 * 붙지 않는 건 날조하지 않고 `none` 으로 남긴다.
 */
export function resolveVideoTitleProjection(
  ledgerTitle: unknown,
  videoDoc: Record<string, unknown> | null | undefined,
  /** 2026-09-05 다타이틀: 등록된 게임 타이틀 이름들(레지스트리). 생략하면 종전 동작. */
  titleNames: readonly string[] = [],
): ResolvedVideoTitle {
  const synced = trimmed(videoDoc?.metricsSyncedAtIso, 80);
  const fromVideo = trimmed(videoDoc?.title);
  if (synced && fromVideo && !isInternalVideoTitleLabel(fromVideo, titleNames)) {
    return { title: fromVideo, source: "youtube_snapshot" };
  }
  const fromLedger = trimmed(ledgerTitle);
  return fromLedger
    ? { title: fromLedger, source: "ledger" }
    : { title: null, source: "none" };
}

/**
 * 썸네일은 videoId 만 있으면 만들어지는 주소다 — 저장하거나 조인할 필요가 없다.
 * 원천이 준 URL 이 있으면 그걸 쓰고, 없으면 videoId 로 유도한다.
 */
export function resolveVideoThumbnailUrl(
  youtubeVideoId: unknown,
  storedThumbnailUrl?: unknown,
): string | null {
  const stored = trimmed(storedThumbnailUrl, 1_000);
  if (stored.startsWith("https://")) return stored;
  const id = trimmed(youtubeVideoId, 60);
  if (!id) return null;
  return `https://img.youtube.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

/**
 * U7 P2: 승인 영상 표시 제목의 공용 래퍼. 파트너 상세·관리 상세가 각자 다른 폴백 체인을 들고 있어
 * 같은 영상의 제목이 갈렸다(실측: "제목 미확인" vs 사내 라벨).
 *
 * 규칙은 `resolveVideoTitleProjection` 그대로다 — 스냅샷이 확인해 준 제목만 승격하고, 원장 후보는
 * **사내 라벨을 걸러낸 뒤** 앞선 것부터 쓴다. 남는 게 없으면 `none`(null)이며 화면이 "(제목 없음)"
 * 처럼 정직하게 표시한다. 기존 `resolveVideoTitleProjection` 은 4개 소비처가 그대로 쓰므로 남긴다.
 */
export function resolveApprovedVideoTitle(
  videoDoc: Record<string, unknown> | null | undefined,
  ...ledgerTitleCandidates: readonly unknown[]
): ResolvedVideoTitle {
  const ledgerTitle = ledgerTitleCandidates
    .map((candidate) => trimmed(candidate))
    .find((candidate) => candidate.length > 0 && !INTERNAL_VIDEO_TITLE_LABELS.has(candidate)) ?? "";
  return resolveVideoTitleProjection(ledgerTitle, videoDoc);
}
