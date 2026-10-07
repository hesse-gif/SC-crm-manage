"use client";

// Flu/Task-45: 후보 탭 상단의 전체/관심/히스토리 서브뷰 토글. 필터/정렬 로직은 candidateSubviews.ts
// 순수 함수에 전부 있고, 이 컴포넌트는 선택 UI만 그린다 — page.tsx가 URL(?view=)과 동기화한다.
// 파트너 탭도 같은 서브뷰 구조를 재사용할 수 있도록 CandidateTableRow에 결합하지 않는다(요구사항
// 원문의 "공용 컴포넌트로 분리").
import { CANDIDATE_SUBVIEWS, CANDIDATE_SUBVIEW_LABEL, type CandidateSubview } from "./candidateSubviews";

export function CandidateSubviewTabs({
  value,
  onChange,
  counts,
}: {
  value: CandidateSubview;
  onChange: (next: CandidateSubview) => void;
  counts?: Partial<Record<CandidateSubview, number>>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="후보 서브뷰">
      {CANDIDATE_SUBVIEWS.map((subview) => {
        const active = value === subview;
        const count = counts?.[subview];
        return (
          <button
            key={subview}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`candidate-subview-${subview}`}
            onClick={() => onChange(subview)}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors ${
              active
                ? "border-accent bg-accent-soft text-accent"
                : "border-line bg-fill text-ink-3 hover:border-ink-3"
            }`}
          >
            {CANDIDATE_SUBVIEW_LABEL[subview]}
            {typeof count === "number" ? <span className="text-ink-4">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
