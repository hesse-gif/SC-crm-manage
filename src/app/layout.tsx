import type { Metadata, Viewport } from "next";
import "./globals.css";
import { RoleProvider } from "@/lib/role";
import { ViewAsProvider } from "@/lib/viewAs";
import { ChunkErrorReloader } from "@/components/shell/ChunkErrorReloader";
import { APP_VERSION } from "@/lib/appVersion";

const RELEASE_MARKER_SCHEMA = "flu.production-release-marker.v1";
const RELEASE_VERSION = process.env.NEXT_PUBLIC_FLU_RELEASE_VERSION ?? "unbound";
const RELEASE_SOURCE_COMMIT = process.env.NEXT_PUBLIC_FLU_SOURCE_COMMIT ?? "unbound";
const RELEASE_RUNTIME_ENVIRONMENT = process.env.NEXT_PUBLIC_FLU_RUNTIME_ENV ?? "unbound";
const RELEASE_HOSTING_SITE = process.env.NEXT_PUBLIC_FLU_HOSTING_SITE ?? "unbound";

export const metadata: Metadata = {
  title: "Mixmax",
  description: "Mixmax 스타일의 AI 어시스트 커뮤니케이션 워크스페이스",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="ko"
      data-flu-release-schema={RELEASE_MARKER_SCHEMA}
      data-flu-app-version={APP_VERSION}
      data-flu-release-version={RELEASE_VERSION}
      data-flu-source-commit={RELEASE_SOURCE_COMMIT}
      data-flu-runtime-environment={RELEASE_RUNTIME_ENVIRONMENT}
      data-flu-hosting-site={RELEASE_HOSTING_SITE}
    >
      <body>
        <ChunkErrorReloader />
        <RoleProvider>
          <ViewAsProvider>{children}</ViewAsProvider>
        </RoleProvider>
      </body>
    </html>
  );
}
