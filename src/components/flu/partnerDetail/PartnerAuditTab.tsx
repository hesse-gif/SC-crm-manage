"use client";

// Audit tab (spec_partner_profile_tabs/spec.md §4.5) — append-only evidence trail. Never repeats
// ordinary operational info already shown elsewhere; never shows raw email/UID/token/secret.
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatKst } from "@/lib/datetime";
import type { PartnerAuditEvent, PartnerAuditEventType } from "@/lib/partnerData";

const EVENT_LABELS: Record<PartnerAuditEventType, string> = {
  "application.received": "지원 접수",
  "application.materialized": "지원 구체화",
  "application.assigned": "지원 배정",
  "onboarding.observed": "온보딩 관측",
  "video.revision.received": "영상 revision 수신",
  "video.revision.superseded": "영상 revision superseded",
  "analysis.completed": "분석 완료",
  "analysis.failed": "분석 실패",
  "review.decision.changed": "검수 판정 변경",
  "partner.activated": "Partner 활성화",
  "partner.revoked": "Partner 해제",
  "callback.queued": "콜백 대기",
  "callback.delivered": "콜백 전달됨",
  "callback.dead_letter": "콜백 dead-letter",
  "feed_report.projection.changed": "Feed/Report 반영 변경",
  "tracking.snapshot.recorded": "조회수 snapshot 기록",
  "settlement.estimate.changed": "정산 예상치 변경",
  "settlement.payment.changed": "지급 상태 변경",
  "profile_image.source.changed": "프로필 사진 원천 변경",
};

function resultTone(result: PartnerAuditEvent["result"]): "ok" | "warn" | "danger" {
  if (result === "success") return "ok";
  if (result === "rejected") return "warn";
  return "danger";
}

const RESULT_LABEL: Record<PartnerAuditEvent["result"], string> = {
  success: "완료",
  rejected: "거절",
  failed: "실패",
};

const ACTOR_LABEL: Record<PartnerAuditEvent["actor"]["kind"], string> = {
  human: "사람",
  ai: "AI",
  system: "시스템",
};

export function PartnerAuditTab({ events, hasMore, onLoadMore }: { events: PartnerAuditEvent[]; hasMore: boolean; onLoadMore?: () => void }) {
  if (events.length === 0) {
    return (
      <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-5 py-8 text-center text-sm text-danger">
        active Partner의 감사 event가 0건입니다 — 데이터 무결성 오류.
      </div>
    );
  }

  return (
    <Card>
      <CardHeader title="감사" desc={`${events.length}건 · append-only`} />
      <ul className="divide-y divide-line">
        {events.map((event) => {
          const actorKind = event.actor?.kind ?? "system";
          const evidenceRefs = Array.isArray(event.evidenceRefs) ? event.evidenceRefs : [];
          return (
          <li key={event.eventId} className="px-5 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">{EVENT_LABELS[event.eventType] ?? "Partner 운영 이벤트"}</p>
              <div className="flex items-center gap-1.5">
                <Badge tone="neutral">{ACTOR_LABEL[actorKind]}</Badge>
                <Badge tone={resultTone(event.result)}>{RESULT_LABEL[event.result] ?? "확인 필요"}</Badge>
              </div>
            </div>
            <p className="mt-0.5 text-xs text-ink-4">{formatKst(event.occurredAtIso, "—")} · {event.source}</p>
            {evidenceRefs.length > 0 ? (
              <p className="mt-1 text-[11px] text-ink-4">근거 원장 {evidenceRefs.length}건 연결</p>
            ) : null}
          </li>
          );
        })}
      </ul>
      {hasMore && onLoadMore ? (
        <div className="px-5 pb-4">
          <button type="button" onClick={onLoadMore} className="rounded-full border border-line bg-fill px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-fill/70">
            더 보기
          </button>
        </div>
      ) : null}
    </Card>
  );
}
