"use client";

// Flu/Task-55 — 목록형 화면(후보 탭 등)에서 "로딩 중"과 "결과 없음"이 같은 순간에 같은 문구로
// 보이던 결함의 공용 수리 지점. 개별 화면은 이미 서로 다른 방식으로 loading/rows를 들고 있어
// 하나의 만능 래퍼(phase 판정까지 대신하는 컴포넌트)로 묶으면 화면마다 있던 세부 규칙(예:
// 에러가 나도 이전에 불러온 데이터는 계속 보여준다)이 깨질 위험이 있다 — 그래서 여기서는 세
// 조각(로딩/빈 상태/에러)만 순수 프레젠테이션으로 떼어 두고, 언제 어느 조각을 그릴지는 각 화면이
// 기존 조건문 그대로 고른다.
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { LoadingStatus } from "@/components/ui/LoadingStatus";

/** 목록 영역이 아직 첫 데이터를 기다리는 중일 때. */
export function AsyncListLoading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <div className="flex justify-center p-8">
        <LoadingStatus>{children}</LoadingStatus>
      </div>
    </Card>
  );
}

/** 로딩이 끝난 뒤 실제로 결과가 0건일 때 — 다음 행동(action)을 함께 보여줄 수 있다. */
export function AsyncListEmpty({
  message,
  action,
  className,
}: {
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <div className="space-y-1.5 p-8 text-center text-sm text-ink-3">
        <p>{message}</p>
        {action ? <p className="text-xs text-ink-4">{action}</p> : null}
      </div>
    </Card>
  );
}

/**
 * 조회 자체가 실패했을 때 — 재시도 버튼은 선택.
 * prop 이름은 onRetry가 아니라 onRetryAction이다(lint) — 이 컴포넌트 자체는 클라이언트
 * 전용("use client")이라 서버 액션은 아니지만, 콜백 prop을 *Action으로 끝내는 이 저장소 lint
 * 규칙을 그대로 따른다.
 */
export function AsyncListError({
  message,
  onRetryAction,
  className,
}: {
  message: ReactNode;
  onRetryAction?: () => void;
  className?: string;
}) {
  return (
    <Card className={className}>
      <div className="space-y-3 p-8 text-center text-sm text-danger">
        <p>{message}</p>
        {onRetryAction ? (
          <Button variant="secondary" size="sm" onClick={onRetryAction}>
            다시 시도
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
