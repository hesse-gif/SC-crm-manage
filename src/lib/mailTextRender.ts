// W96: Chat 타임라인의 메일 본문 표시용 토크나이저.
// 문제(실측 스크린샷): HTML 로 발송된 메일이 버블에는 text 판으로 찍혀 outreach 토큰이 붙은
// raw URL 이 수백 자 그대로 노출됐다. 여기서 마크다운 앵커·bare URL 을 세그먼트로 분해해
// UI 가 "표시 라벨 + 클릭 링크"로 렌더한다 (innerHTML 미사용 — XSS 안전은 호출부의 React 노드 조립).
// 데이터는 건드리지 않는 표시 계층 전용 — SEC-P0-009 불변.

export type MailTextSegment =
  | { type: "text"; value: string }
  | { type: "link"; label: string; href: string };

// 정본 링크 → 사람용 라벨. functions/mailReplyLinks.ts 의 4개 정본과 도메인 규칙을 미러링.
// 델타 리뷰 FINAL 처방: 호스트는 **정확 일치만** — startsWith 접두어 검사는
// scp-creator-portal.evil.tk / scp-creator-portal-fake.ru 같은 공격자 도메인에
// 신뢰 라벨을 부여한다 (리뷰어 실측 재현). 정본 호스트가 바뀌면 이 상수를 갱신할 것.
// W98(헤세): 라벨은 메일 콘텐츠 언어(영문)를 따른다 — 영문 초안에 한글 라벨이 떠서 정정.
const SCP_PORTAL_HOST = "creator.supercent.io";
// 정본 샘플 폴더 (functions/mailReplyLinks.ts REPLY_LINK_SAMPLE 미러) — Drive 는 멀티테넌트라
// 이 정확한 폴더일 때만 신뢰 라벨을 부여한다 (임의 Drive 폴더 = 공격자 콘텐츠일 수 있음).
const CANONICAL_SAMPLE_DRIVE_PATH = "/drive/folders/1szFSKPHUfUYufHoOPbECflTcgoKSOwyP";
const KNOWN_LINK_LABELS: ReadonlyArray<{ match: (url: URL) => boolean; label: string }> = [
  { match: (u) => u.hostname === SCP_PORTAL_HOST && u.pathname.startsWith("/apply"), label: "Apply to Super Creator Partners" },
  { match: (u) => u.hostname === SCP_PORTAL_HOST && u.pathname.startsWith("/submit-content"), label: "Submit your video" },
  { match: (u) => u.hostname === SCP_PORTAL_HOST && u.searchParams.get("view") === "guide", label: "Super Creator Partners Guide" },
  { match: (u) => u.hostname === SCP_PORTAL_HOST, label: "Super Creator Partners Portal" },
  { match: (u) => u.hostname === "drive.google.com" && u.pathname.startsWith(CANONICAL_SAMPLE_DRIVE_PATH), label: "Sample videos (Drive)" },
  { match: (u) => u.hostname === "studio.youtube.com", label: "YouTube Studio" },
];

// 원저자 라벨 패스스루 판정 — **우리가 실소유한 호스트(SCP 포털)만**.
// W98 델타 리뷰 FAIL 처방: drive.google.com/studio.youtube.com 은 멀티테넌트라 "목적지가
// 정본" 전제가 성립하지 않는다(공격자 소유 폴더 + 공격자 라벨 조합 실측 재현) — 그 호스트들은
// 항상 파생 라벨을 강제한다.
function isOwnedTrustedUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname === SCP_PORTAL_HOST;
  } catch {
    return false;
  }
}

function friendlyLinkLabel(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const known of KNOWN_LINK_LABELS) {
      if (known.match(url)) return known.label;
    }
    // 미지 링크: 호스트 + 경로 앞부분만 (쿼리/토큰은 표시에서 제거 — href 는 원본 유지)
    const path = url.pathname === "/" ? "" : url.pathname;
    const shortPath = path.length > 24 ? `${path.slice(0, 24)}…` : path;
    return `${url.hostname}${shortPath}`;
  } catch {
    return rawUrl.length > 42 ? `${rawUrl.slice(0, 42)}…` : rawUrl;
  }
}

// 마크다운 앵커 [label](url) 우선, 그다음 bare URL (<url> 자동링크 포함).
const SEGMENT_PATTERN = /\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>()\]]+)/g;

export function tokenizeMailText(text: string): MailTextSegment[] {
  const input = String(text ?? "");
  const segments: MailTextSegment[] = [];
  let cursor = 0;
  for (const match of input.matchAll(SEGMENT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ type: "text", value: input.slice(cursor, index) });
    if (match[1] && match[2]) {
      // 델타 리뷰 HIGH 처방 + W98 정밀화: 마크다운 라벨은 기본적으로 신뢰하지 않고 href 에서
      // 파생하되([정본위장라벨](피싱URL) 스푸핑 차단, 실측 재현됨), **href 가 정본 호스트에
      // 정확 일치하면 원저자 라벨을 그대로 보여준다** — 목적지가 정본이면 라벨은 피싱이
      // 될 수 없고, 초안이 쓴 언어(영문) 라벨이 그대로 유지된다.
      segments.push({
        type: "link",
        label: isOwnedTrustedUrl(match[2]) ? match[1] : friendlyLinkLabel(match[2]),
        href: match[2],
      });
    } else {
      const href = (match[3] || match[4] || "").replace(/[.,;:!?]+$/, "");
      const trailing = (match[3] || match[4] || "").slice(href.length);
      segments.push({ type: "link", label: friendlyLinkLabel(href), href });
      if (trailing) segments.push({ type: "text", value: trailing });
    }
    cursor = index + match[0].length;
  }
  if (cursor < input.length) segments.push({ type: "text", value: input.slice(cursor) });
  return segments;
}
