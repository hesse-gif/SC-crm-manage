"use client";

import { useEffect } from "react";

// 배포 시 Next.js 정적 청크 해시가 바뀌면, 캐시된 옛 HTML이 사라진 청크를 가리켜
// ChunkLoadError("Loading chunk N failed", 404) → "Application error" 크래시가 발생한다.
// 이 가드는 청크 로드 실패를 감지하면 1회 자동 새로고침해 최신 HTML/청크로 복구한다(루프 방지 타임스탬프).
export function ChunkErrorReloader() {
  useEffect(() => {
    const KEY = "flu:chunk-reload-at";
    const isChunkError = (msg: string, name: string) =>
      /ChunkLoadError/i.test(name) ||
      /Loading chunk [\w-]+ failed/i.test(msg) ||
      /Loading CSS chunk/i.test(msg) ||
      /Failed to fetch dynamically imported module/i.test(msg);
    const isNextStaticChunkUrl = (value: string) => /\/_next\/static\/(?:chunks|css)\//.test(value);
    const targetUrl = (target: EventTarget | null) => {
      if (target instanceof HTMLScriptElement) return target.src;
      if (target instanceof HTMLLinkElement) return target.href;
      return "";
    };
    const warnStorageFailure = (storageError: unknown) => {
      if (!(storageError instanceof DOMException && storageError.name === "SecurityError")) {
        console.warn("Chunk recovery could not persist reload guard", storageError);
      }
    };
    const lastReloadAt = () => {
      try {
        return Number(window.sessionStorage.getItem(KEY) || "0");
      } catch (storageError) {
        warnStorageFailure(storageError);
        return 0;
      }
    };

    const recover = () => {
      // 10초 내 재발이면 재로드하지 않음(무한 새로고침 루프 차단).
      const last = lastReloadAt();
      if (Date.now() - last < 10000) return;
      try {
        window.sessionStorage.setItem(KEY, String(Date.now()));
      } catch (storageError) {
        warnStorageFailure(storageError);
      }
      // 캐시 우회 강제: 이미 캐시된 옛 HTML이 죽은 청크를 가리키면 plain reload는 같은 캐시를 다시 받는다.
      // 쿼리 캐시버스터로 새 HTML(=현재 청크 해시)을 강제로 가져온다(라우팅은 쿼리 무시 → 화면 동일).
      const url = new URL(window.location.href);
      url.searchParams.set("_cb", String(Date.now()));
      window.location.replace(url.toString());
    };

    const onError = (e: ErrorEvent) => {
      const name = (e.error && (e.error as { name?: string }).name) || "";
      if (isChunkError(e.message || "", name) || isNextStaticChunkUrl(e.filename || "") || isNextStaticChunkUrl(targetUrl(e.target))) recover();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { filename?: string; message?: string; name?: string } | undefined;
      if (isChunkError(reason?.message || "", reason?.name || "") || isNextStaticChunkUrl(reason?.filename || "")) recover();
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
