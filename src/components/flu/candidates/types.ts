// Flu/Task-43: 후보 탭 UI 전용 타입/상수. 서버 프로젝션 타입(CandidateTableRow 등)은 전부
// src/lib/data.ts(functions/candidateTable.ts 응답 타입과 1:1)에서 가져와 재사용한다 — 여기서는
// 중복 정의하지 않는다.
//
// 후속 티켓(44 발송·독려 카운트, 45 서브뷰/즐겨찾기/캘린더, 46 파트너 전환)이 이 위에 얹힐 것이므로
// 행 액션은 좁은 콜백 타입으로 분리해 둔다(과설계 없이 최소 확장 지점만).
import type {
  CandidateContactStatus,
  CandidateTableOutreachEvent,
  CandidateTableOutreachStats,
  CandidateTableRow,
} from "@/lib/data";

export type { CandidateContactStatus, CandidateTableOutreachEvent, CandidateTableOutreachStats, CandidateTableRow };

// Task-43 적대 리뷰 P0④: contactStatus는 이제 campaign_outreach/scp_coldmail_history 원장에서
// 파생된 5개 값이다(functions/candidateTable.ts hydrateContactStatus) — "발송"은 실제 발송일 때만.
// Task-46: "회신"/"수락 후보"/"협의 중"/"수락" 4개는 인바운드 회신 분류·파트너 전환 오버레이
// (functions/candidateTable.ts hydrateReplyAcceptance)에서 온다.
export const CONTACT_STATUS: Record<CandidateContactStatus, { label: string; tone: "neutral" | "info" | "ok" | "warn" | "danger" }> = {
  미연락: { label: "미연락", tone: "neutral" },
  "검수 대기": { label: "검수 대기", tone: "warn" },
  "발송 예정": { label: "발송 예정", tone: "info" },
  발송: { label: "발송", tone: "ok" },
  차단: { label: "차단", tone: "danger" },
  회신: { label: "회신", tone: "info" },
  "수락 후보": { label: "수락 후보", tone: "ok" },
  "협의 중": { label: "협의 중", tone: "warn" },
  수락: { label: "수락", tone: "ok" },
};

export interface CandidateTableRowActions {
  onSend: (row: CandidateTableRow) => void | Promise<void>;
  onHold: (row: CandidateTableRow) => void | Promise<void>;
  onToggleFavorite: (row: CandidateTableRow) => void | Promise<void>;
  // Task-43 적대 리뷰 P0①: 메일 발송은 캠페인에 귀속되므로 선택된 캠페인이 없으면 버튼을 비활성화한다.
  sendDisabledReason?: (row: CandidateTableRow) => string | null;
  // Task-44: 후보별 독려 주기 편집. cadenceDays=null은 오버라이드 해제(전역 기본으로 폴백).
  // 재리뷰 MED-HIGH-1: 같은 이메일을 공유하는 다른 후보에도 함께 적용됐을 때, 그 id 목록을
  // 돌려주면 상세 패널이 "N건에 함께 적용" 안내를 띄울 수 있다.
  onSetNudgeCadence: (
    row: CandidateTableRow,
    cadenceDays: number | null,
  ) => void | { appliedCandidateIds?: string[] } | Promise<void | { appliedCandidateIds?: string[] }>;
  // Task-46: "수락 후보"일 때만 CandidateTable이 버튼을 활성화한다 — 옵션이라 이 액션을 넘기지
  // 않는 기존 호출부(있다면)는 그대로 동작한다.
  onConvertToPartner?: (row: CandidateTableRow) => void | Promise<void>;
  // Flu/Task-50 적대 리뷰 P1 — super_admin "대신 보기" 등 읽기 전용 프리뷰가 활성일 때 값을
  // 넣으면 즐겨찾기·보류·발송·파트너 전환·독려 주기 편집 버튼 전부가 비활성화되고, 이 문자열이
  // 각 버튼의 title/안내 문구로 쓰인다. null/undefined면 평소대로 각 행의 조건만 적용된다.
  readOnlyReason?: string | null;
}
