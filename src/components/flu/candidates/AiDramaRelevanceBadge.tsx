import { Badge, type Tone } from "@/components/ui/Badge";
import type { CandidateTableAiDramaRelevance } from "@/lib/data";
import { unknownStatusLabel } from "@/lib/statusLabels";

// Small, standalone component on purpose (헤세 2026-09-27: "keep your UI change a small badge
// component to avoid conflicts" while candidate-big-thumbs work is in flight on the same table).
// Never renders the raw JEV prompt/response — only the derived score/reason (SEC-P0-009).

const REASON_LABEL: Record<string, string> = {
  jev_ai_drama_relevant: "AI 드라마 콘텐츠로 판정",
  jev_not_ai_drama: "AI 드라마 아님으로 판정",
  jev_unavailable: "판정 불가(JEV 응답 없음)",
  jev_answer_missing: "판정 불가(응답 형식 오류)",
  jev_deadline_exceeded: "판정 보류(시간 초과)",
};

// 헤세 2026-09-27 후보 탭 가독성 개선: 이 판정 이유를 배지 툴팁이 아니라 행에 바로 보이는 텍스트로
// 쓴다(CandidateTable.tsx) — 사전에 없는 코드가 그대로 새면 운영자가 영문 코드를 보게 되므로,
// statusLabels.ts의 기존 관용구("확인 필요(<raw>)")로 감싸 raw 코드가 그대로 노출되지 않게 한다.
export function aiDramaRelevanceReasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? unknownStatusLabel(reason);
}

/** High/mid/low color coding for a 0-100 relevance percentage. */
export function aiDramaRelevanceTone(scorePercent: number): Tone {
  if (scorePercent >= 80) return "ok";
  if (scorePercent >= 60) return "warn";
  return "danger";
}

function formatJudgedAt(judgedAtIso: string): string {
  const parsed = new Date(judgedAtIso);
  return Number.isNaN(parsed.getTime()) ? judgedAtIso : parsed.toLocaleString("ko-KR");
}

/**
 * Percentage badge for an ai_drama candidate's JEV relevance score, color-coded high/mid/low.
 * Renders nothing when there is no relevance stamp yet (game-vertical rows, or an ai_drama candidate
 * materialized before this gate existed). The derived reason itself is rendered as visible text next
 * to this badge by the caller (CandidateTable.tsx, via aiDramaRelevanceReasonLabel) — the tooltip here
 * only adds the judged-at time, never the raw JEV state/answer (SEC-P0-009).
 */
export function AiDramaRelevanceBadge({
  relevance,
}: {
  relevance: CandidateTableAiDramaRelevance | null | undefined;
}) {
  if (!relevance) return null;
  const tone = aiDramaRelevanceTone(relevance.scorePercent);
  const title = `판정 시각 ${formatJudgedAt(relevance.judgedAtIso)} (JEV)`;
  // Aside 적대 리뷰(2026-09-27): title을 감싸는 별도 <span>이 아니라 Badge 자신에 직접 단다 —
  // 텍스트 노드를 바로 찾는 쿼리에서도 title이 보이도록(Badge.tsx가 이제 title을 받는다).
  return (
    <Badge tone={tone} title={title}>
      AI 드라마 관련성 {relevance.scorePercent}%
    </Badge>
  );
}
