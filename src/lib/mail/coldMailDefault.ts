// W8-8: 1차 콜드메일 **기본 본문** — 사용자가 지정한 정본(다크 600px, XP Hero 리크루팅 히어로 ·
// $2,000+/mo · 보너스 카드 · Apply CTA · fine print)이다.
//
// 정본 경로: functions/mailTemplates/src/scp_coldmail_1st_en.html
//   (83,585 bytes / 83,445 chars · base64 JPEG 키비주얼 1개 44,433B · `{{}}` 변수 0개 = 순수 정적 HTML)
// 이 바이트는 리더가 운영 위저드 HTML 모드에 실제로 주입해 **서버 컴파일 미리보기 통과**를 확인한
// 것과 동일하다. 기존 마스터 2종과 같은 방식으로 관리한다: .html 소스 1개 →
// scripts/build-mail-templates.mjs 가 functions/ 와 src/ 양쪽 상수를 생성(사본 손편집 금지).
//
// bodyFormat 은 항상 "html" 이다 — markdown 기본값이면 저장 경로가 8,000자 상한으로 잘라 템플릿이
// 조용히 깨진다(html 은 256KB 상한). base64 키비주얼은 저장·발송 시 compileMailArtifact 의
// extractInlineImageAssets 가 `cid:flu-asset-<sha256>` 공식 자산으로 바꿔 인라인 첨부로 나간다
// (W8-1 과 같은 배선 — data: 원문이 와이어에 남지 않는다).
import { SCP_COLDMAIL_1ST_EN_HTML } from "./mailMastersGenerated";

export const DEFAULT_CAMPAIGN_MAIL_BODY_FORMAT = "html" as const;
export const DEFAULT_CAMPAIGN_MAIL_BODY_HTML = SCP_COLDMAIL_1ST_EN_HTML;
