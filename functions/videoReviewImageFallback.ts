// S6(P6) 이미지 제출 fallback 체인 — 인터뷰 #4 확정.
//   업로드 파일이 실제로는 이미지(mime/확장자)인 제출물은 멀티모달 "영상" 판정 대상이
//   아니다. 확정 순서: (1) sheet row URL 컬럼(C, = ScpVideoReviewSheetRow.youtubeUrl/
//   submission.youtubeUrl) → (2) 채널 최신 업로드 영상 1건(비용 상한 — 후보 1개만 시도,
//   PM-2) → (3) 그래도 없으면 needs-review로 명시 귀결(silent no-op 금지).
//   순수 판별 로직만 여기 둔다 — Firestore/YouTube API 호출은 주입받은 콜백을 통해서만
//   수행해 유닛 테스트 가능하게 유지한다(creatorLanguageGate.ts 패턴과 동일).
import { extractYouTubeVideoId } from "./videoViewSnapshots";
import type { YouTubeApiClient } from "./youtubeEnrichmentService";

const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "tiff", "tif", "svg", "avif",
]);

export type ImageFallbackStatus = "video_found" | "exhausted";
export type ImageFallbackSource = "sheet_column_c" | "channel_latest";

export interface ImageFallbackResult {
  status: ImageFallbackStatus;
  videoId?: string;
  youtubeUrl?: string;
  source?: ImageFallbackSource;
  // 소진(exhausted) 시 UI/outbox가 "AI 미생성" 사유로 노출할 구체적 이유.
  reason?: "no_column_c_video" | "channel_lookup_failed" | "no_channel_reference" | "no_recent_video";
}

// mime/확장자 감지 — 둘 중 하나라도 이미지면 이미지로 판정한다(모델 실패보다 사전 분류가 안전).
export function isImageSubmission(input: { uploadedFileUrl?: string | null; contentType?: string | null }): boolean {
  const contentType = (input.contentType || "").trim().toLowerCase();
  if (contentType.startsWith("image/")) return true;
  const url = (input.uploadedFileUrl || "").trim();
  if (!url) return false;
  const withoutQuery = url.split(/[?#]/)[0];
  const match = withoutQuery.match(/\.([a-zA-Z0-9]+)$/);
  const ext = match ? match[1].toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(ext);
}

export interface RecentUploadFetcher {
  (api: YouTubeApiClient, youtubeUrl: string, limit?: number): Promise<{ channelId: string | null; videoIds: string[] }>;
}

export interface ResolveImageFallbackOptions {
  // (1) sheet row URL column C — 보통 submission.youtubeUrl과 동일 필드(scpSheetReviewService.ts
  // buildScpVideoReviewSheetRows: row.cells.C → youtubeUrl).
  sheetColumnCUrl?: string | null;
  // (2) 크리에이터의 알려진 채널 URL(있을 때만 시도) — 호출부가 미리 조회해서 주입한다.
  channelYoutubeUrl?: string | null;
  youtubeApi?: YouTubeApiClient;
  recentUploadFetcher?: RecentUploadFetcher;
}

// 후보 1개만 시도(PM-2 비용 상한) — 채널 조회가 성공해도 최신 영상 1건 이상은 확인하지 않는다.
const CHANNEL_FALLBACK_CANDIDATE_LIMIT = 1;

export async function resolveVideoReviewImageFallback(options: ResolveImageFallbackOptions): Promise<ImageFallbackResult> {
  const columnCVideoId = options.sheetColumnCUrl ? extractYouTubeVideoId(options.sheetColumnCUrl) : null;
  if (columnCVideoId) {
    return {
      status: "video_found",
      videoId: columnCVideoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${columnCVideoId}`,
      source: "sheet_column_c",
    };
  }

  if (!options.channelYoutubeUrl || !options.youtubeApi) {
    return { status: "exhausted", reason: "no_channel_reference" };
  }

  try {
    const fetchRecent = options.recentUploadFetcher;
    if (!fetchRecent) return { status: "exhausted", reason: "no_channel_reference" };
    const { videoIds } = await fetchRecent(options.youtubeApi, options.channelYoutubeUrl, CHANNEL_FALLBACK_CANDIDATE_LIMIT);
    const latest = videoIds[0];
    if (!latest) return { status: "exhausted", reason: "no_recent_video" };
    return {
      status: "video_found",
      videoId: latest,
      youtubeUrl: `https://www.youtube.com/watch?v=${latest}`,
      source: "channel_latest",
    };
  } catch {
    return { status: "exhausted", reason: "channel_lookup_failed" };
  }
}
