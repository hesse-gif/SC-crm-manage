import { SCP_PORTAL_APPLY_LINK } from "./admin";

// W31 F-2: 정본 URL 4개 — 회신 레인엔 placeholder fail-closed 가드가 없다(콜드메일 레인 전용).
// 완성된 마크다운 [라벨](URL) 상수로만 다뤄 미치환 리터럴 발송을 원천 차단한다.
export const REPLY_LINK_GUIDE =
  "https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm#guide-overview";
export const REPLY_LINK_APPLY = SCP_PORTAL_APPLY_LINK;
export const REPLY_LINK_SUBMIT =
  "https://creator.supercent.io/submit-content";
// 계약(2026-08-28, 포털 보안 리뷰 M3): flu 가 **포털 지원서 관리 링크를 발송하게 되면** 토큰은
// 쿼리가 아니라 프래그먼트로 싣는다 — `.../apply/manage?locale=ko#token=<token>`.
// 쿼리스트링은 최초 GET 의 요청 라인에 실려 GFE·Cloud Run 액세스 로그에 평문으로 기록되고,
// 화면이 replaceState 로 지워도 그건 이미 기록된 뒤다. 프래그먼트는 브라우저가 서버로 전송하지
// 않아 어떤 로그에도 남지 않는다. 포털 수신부는 프래그먼트 우선 + 쿼리 폴백으로 배선돼 있다
// (portal PR #120). **현재 flu 에는 이 링크를 만드는 코드가 없다** — 레포 전수 실측상
// `apply/manage`·`scp_application_access_grants` 참조 0건, 메일 템플릿 10종에도 없다.
// 이 주석은 그 레인이 생길 때를 위한 선행 계약이다.
export const REPLY_LINK_SAMPLE =
  "https://drive.google.com/drive/folders/1szFSKPHUfUYufHoOPbECflTcgoKSOwyP";
