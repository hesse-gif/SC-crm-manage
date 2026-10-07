export type ManagementProfileImageSource = "youtube_oauth" | "flu_channel" | "youtube_data_api" | "missing";

export interface ManagementProfileImageInputs {
  youtubeOauthVerifiedThumbnailUrl?: string | null;
  fluCanonicalChannelImageUrl?: string | null;
  youtubeDataApiPublicThumbnailUrl?: string | null;
  profileImageRevision?: number | null;
  profileImageVerifiedAt?: string | null;
}

export interface ManagementProfileImageProjection {
  url: string | null;
  source: ManagementProfileImageSource;
  statusLabel: string;
  disconnectedLabel: string;
  recoveryLabel: string;
  imageRevision: number;
  verifiedAt?: string;
}

function nonEmptyUrl(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveManagementProfileImage(input: ManagementProfileImageInputs): ManagementProfileImageProjection {
  const imageRevision = typeof input.profileImageRevision === "number" && Number.isFinite(input.profileImageRevision)
    ? input.profileImageRevision
    : 0;
  const verifiedAt = typeof input.profileImageVerifiedAt === "string" && input.profileImageVerifiedAt.trim().length > 0
    ? input.profileImageVerifiedAt.trim()
    : undefined;
  const oauth = nonEmptyUrl(input.youtubeOauthVerifiedThumbnailUrl);
  if (oauth) {
    return {
      url: oauth,
      source: "youtube_oauth",
      statusLabel: "이미지 연결됨 · YouTube OAuth",
      disconnectedLabel: "이미지 미연결",
      recoveryLabel: "이미지 복구 필요 · YouTube OAuth 썸네일을 다시 확인하세요",
      imageRevision,
      verifiedAt,
    };
  }
  const flu = nonEmptyUrl(input.fluCanonicalChannelImageUrl);
  if (flu) {
    return {
      url: flu,
      source: "flu_channel",
      statusLabel: "이미지 연결됨 · Flu 채널",
      disconnectedLabel: "이미지 미연결",
      recoveryLabel: "이미지 복구 필요 · Flu 채널 이미지를 다시 확인하세요",
      imageRevision,
      verifiedAt,
    };
  }
  const youtubeData = nonEmptyUrl(input.youtubeDataApiPublicThumbnailUrl);
  if (youtubeData) {
    return {
      url: youtubeData,
      source: "youtube_data_api",
      statusLabel: "이미지 연결됨 · YouTube Data API",
      disconnectedLabel: "이미지 미연결",
      recoveryLabel: "이미지 복구 필요 · YouTube Data API 썸네일을 다시 확인하세요",
      imageRevision,
      verifiedAt,
    };
  }
  return {
    url: null,
    source: "missing",
    statusLabel: "이미지 미연결 · 복구 필요",
    disconnectedLabel: "이미지 미연결",
    recoveryLabel: "이미지 복구 필요 · canonical thumbnail source 없음",
    imageRevision,
    verifiedAt,
  };
}
