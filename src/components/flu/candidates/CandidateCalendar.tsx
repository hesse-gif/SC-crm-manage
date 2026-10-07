"use client";

// Flu/Task-45: 월간 달력에 날짜별 신규 유입 후보 수를 보여주고, 날짜 클릭으로 그 날 유입 후보만
// 테이블에 남긴다. 라이브러리 없이 순수 CSS grid로 그린다(요구사항 원문). 날짜 집계는
// candidateSubviews.ts의 buildCandidateCalendarCounts(순수 함수, node --test로 검증됨)를 그대로
// 쓴다 — 이 컴포넌트는 월 이동 상태와 그리드 렌더링만 맡는다.
//
// 달력 그리드(주/요일/월 경계) 자체는 Date.UTC로 계산한다 — buildMonthGrid/shiftYearMonth는 이미
// 확정된 "YYYY-MM" 문자열을 받아 그 달력월의 요일·일수만 구하므로(실제 타임스탬프 변환이 아니다)
// 브라우저 로컬 타임존이 끼어들 일이 없다.
//
// P2-1(2026-09-11 적대 리뷰): 다만 "기본으로 어느 달을 열지" 판단은 실제 타임스탬프(지금 이 순간)
// 기준이라 얘기가 다르다 — candidateDateKey(candidateSubviews.ts)가 KST(+9h) 버킷으로 유입일을
// 잡는 이상, 기본 진입 월도 같은 KST 오프셋으로 "오늘"을 판단해야 자정 전후로 한 달 어긋나지 않는다
// (예: KST 09-01 00:30 = UTC 08-31 15:30 — UTC 기준이면 아직 8월로 열려 9월 1일 유입이 안 보인다).
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { buildCandidateCalendarCounts } from "./candidateSubviews";
import type { CandidateTableRow } from "@/lib/data";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function currentYearMonthKst(): string {
  const kstNow = new Date(Date.now() + KST_OFFSET_MS);
  return `${kstNow.getUTCFullYear()}-${pad2(kstNow.getUTCMonth() + 1)}`;
}

function shiftYearMonth(yearMonth: string, delta: number): string {
  const [year, month] = yearMonth.split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}`;
}

// 주 단위(일~토) 그리드. 월 시작 전/월 종료 후 칸은 null(빈 셀)로 채운다.
function buildMonthGrid(yearMonth: string): (string | null)[][] {
  const [year, month] = yearMonth.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => `${yearMonth}-${pad2(index + 1)}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

export function CandidateCalendar({
  rows,
  selectedDate,
  onSelectDate,
}: {
  rows: CandidateTableRow[];
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
}) {
  const [yearMonth, setYearMonth] = useState(() => selectedDate?.slice(0, 7) || currentYearMonthKst());
  const counts = useMemo(() => buildCandidateCalendarCounts(rows, yearMonth), [rows, yearMonth]);
  const weeks = useMemo(() => buildMonthGrid(yearMonth), [yearMonth]);

  return (
    <Card className="mb-5 p-4" data-testid="candidate-calendar">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setYearMonth((month) => shiftYearMonth(month, -1))}
          className="text-xs font-semibold text-ink-3 hover:text-ink"
          aria-label="이전 달"
        >
          ← 이전
        </button>
        <span className="text-sm font-bold text-ink">{yearMonth}</span>
        <button
          type="button"
          onClick={() => setYearMonth((month) => shiftYearMonth(month, 1))}
          className="text-xs font-semibold text-ink-3 hover:text-ink"
          aria-label="다음 달"
        >
          다음 →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-ink-4">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {weeks.flatMap((week, weekIndex) =>
          week.map((dateKey, dayIndex) => {
            if (!dateKey) return <span key={`${weekIndex}-${dayIndex}`} aria-hidden="true" />;
            const count = counts[dateKey] ?? 0;
            const active = selectedDate === dateKey;
            return (
              <button
                key={dateKey}
                type="button"
                data-testid="candidate-calendar-day"
                data-date={dateKey}
                aria-pressed={active}
                onClick={() => onSelectDate(active ? null : dateKey)}
                className={`flex h-12 flex-col items-center justify-center rounded-md border text-[11px] transition-colors ${
                  active
                    ? "border-accent bg-accent-soft text-accent"
                    : count > 0
                      ? "border-line bg-fill text-ink-2 hover:border-ink-3"
                      : "border-transparent text-ink-4"
                }`}
              >
                <span className="font-semibold">{Number(dateKey.slice(8, 10))}</span>
                {count > 0 ? <span className="text-[10px]">{count}</span> : null}
              </button>
            );
          }),
        )}
      </div>
      {selectedDate ? (
        <button
          type="button"
          data-testid="candidate-calendar-clear-date"
          onClick={() => onSelectDate(null)}
          className="mt-2 text-[11px] font-semibold text-accent hover:underline"
        >
          날짜 필터 해제 ({selectedDate})
        </button>
      ) : null}
    </Card>
  );
}
