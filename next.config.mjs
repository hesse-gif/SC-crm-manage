import { fileURLToPath } from "node:url";

// (app) 라우트 그룹(src/app/(app)/**)의 URL 최상위 세그먼트 — admin/chat/flu/gallery.
// 라우트 그룹은 URL에 나타나지 않으므로 각 세그먼트를 개별 glob으로 나열해야 한다.
// 새 최상위 세그먼트가 (app) 밑에 추가되면 여기도 같이 갱신할 것.
const AUTHENTICATED_APP_ROUTE_PREFIXES = ["/admin", "/chat", "/flu", "/gallery"];

// SSR 응답이 인증된 화면을 CDN/브라우저에 캐시하지 않도록, 그리고 RSC 협상 헤더로 응답이
// 달라진다는 걸 중간 캐시에 알리도록 강제한다 (2026-09-27, (app) force-dynamic 전환과 짝).
const AUTHENTICATED_APP_ROUTE_HEADERS = [
  { key: "Cache-Control", value: "private, no-store" },
  { key: "Vary", value: "RSC, Next-Router-State-Tree, Next-Router-Prefetch" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.MIXMAX_STATIC_EXPORT === "1" ? { output: "export" } : {}),
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  reactStrictMode: true,
  distDir: process.env.MIXMAX_NEXT_DIST_DIR || ".next",
  devIndicators: false, // 개발 배지 숨김 (사이드바 하단 가림 방지)
  images: {
    unoptimized: true,
    qualities: [75, 100],
  },
  async headers() {
    if (process.env.MIXMAX_STATIC_EXPORT === "1") return [];
    return AUTHENTICATED_APP_ROUTE_PREFIXES.map((prefix) => ({
      source: `${prefix}/:path*`,
      headers: AUTHENTICATED_APP_ROUTE_HEADERS,
    }));
  },
};

export default nextConfig;
