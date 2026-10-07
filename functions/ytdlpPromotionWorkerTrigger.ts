/**
 * W75 — 기존 60분 Functions 축에서 섀도 전용 Cloud Run Job을 깨우는 외부 호출 경계.
 *
 * 잡 생성은 Firestore의 durable queue이고 이 호출은 실행 신호일 뿐이다. 호출이 유실돼도 다음 60분
 * sweep이 다시 신호를 보내며, Phase 3 claim lease/attempt 경계가 중복 실행을 막는다. 토큰은 Secret이
 * 아니라 Functions 런타임 ADC의 cloud-platform access token이며 원문을 로그/문서에 남기지 않는다.
 */
import { applicationDefault } from "firebase-admin/app";
import { adminRuntimeEnvironment } from "./firebaseAdmin";

export const YTDLP_SHADOW_WORKER_TARGET = Object.freeze({
  projectId: "influchat-77db6",
  location: "asia-northeast3",
  jobId: "ytdlp-shadow-worker",
  timeoutMs: 10_000,
});

export type YtdlpShadowWorkerRunRequest = {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: "{}";
};

/** 값 기반 테스트용 순수 request builder. access token은 반환 객체 밖으로 복제·기록하지 않는다. */
export function buildYtdlpShadowWorkerRunRequest(accessToken: string): YtdlpShadowWorkerRunRequest {
  const token = accessToken.trim();
  if (!token) throw new Error("ytdlp_shadow_worker_access_token_missing");
  const name = `projects/${YTDLP_SHADOW_WORKER_TARGET.projectId}`
    + `/locations/${YTDLP_SHADOW_WORKER_TARGET.location}`
    + `/jobs/${YTDLP_SHADOW_WORKER_TARGET.jobId}`;
  return {
    url: `https://run.googleapis.com/v2/${name}:run`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  };
}

/** NET-P0-012: Cloud Run Admin API 외부 호출은 Firebase Functions 레이어 한 곳에서만 나간다. */
export async function dispatchYtdlpShadowWorker(): Promise<{ readonly httpStatus: number }> {
  if (adminRuntimeEnvironment.runtimeEnvironment !== "production") {
    throw new Error("ytdlp_shadow_worker_dispatch_production_only");
  }
  const credential = await applicationDefault().getAccessToken();
  const request = buildYtdlpShadowWorkerRunRequest(credential.access_token);
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(YTDLP_SHADOW_WORKER_TARGET.timeoutMs),
  });
  if (!response.ok) {
    throw Object.assign(
      new Error(`ytdlp_shadow_worker_dispatch_http_${response.status}`),
      { errorCode: `ytdlp_shadow_worker_dispatch_http_${response.status}` },
    );
  }
  return { httpStatus: response.status };
}
