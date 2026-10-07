import type { ConsoleMessage } from "@playwright/test";

// Playwright는 모든 프레임(sandbox 포함)에 하네스 스크립트를 주입하고, 빈
// sandbox="" srcdoc iframe은 이를 정상 차단하며 콘솔 오류를 남긴다. 최소 재현:
// <iframe sandbox="" srcdoc="<b>hi</b>">만으로도 동일 오류 발생(앱 마크업 무관).
// 실제 script 혼입 회귀는 g002 프리뷰 계약 테스트와 CSP script-src 'none'이 잡으므로
// 콘솔 스윕에서 이 하네스 아티팩트만 이중 조건(문구+발생 프레임)으로 걸러낸다.
export function isSandboxHarnessArtifact(message: ConsoleMessage): boolean {
  return (
    message.text().includes("Blocked script execution in 'about:srcdoc'")
    && (message.location().url ?? "").startsWith("about:srcdoc")
  );
}
