"use client";

/**
 * W118 — **레인별 메일 킬스위치 카드.**
 *
 * 왜 두 개인가: 종전에는 스위치가 하나(`outreachSendingEnabled`)뿐이라 운영자가 "1차 콜드메일을
 * 멈춘다"고 누른 것이 독려 메일과 지원확인·로그인승인 같은 거래성 메일까지 함께 멈췄다.
 * 이 카드는 운영자가 실제로 구분하는 두 축을 그대로 노출한다 — 거래성 메일은 이 스위치의
 * 대상이 아니며(본인 행동이 유발한 확인 메일), 그 사실을 화면에서 명시한다.
 *
 * 자동 하드락(반송 임계 초과 등)은 레인과 무관하게 **전 레인**을 막는다. 그래서 토글이 켜져
 * 있어도 안 나갈 수 있고, 그 이유를 배너로 먼저 말한다("토글은 켰는데 왜 안 나가나"를 없앤다).
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  getEmailMode,
  setEmailMode,
  type EmailModeOutboundLock,
} from "@/lib/data";
import { useRole } from "@/lib/role";

type LaneKey = "outreach" | "nudge";

type LaneCopy = {
  readonly key: LaneKey;
  readonly title: string;
  readonly desc: string;
  readonly enabledText: string;
  readonly pausedText: string;
  readonly confirmPause: string;
  readonly confirmResume: string;
};

const LANES: readonly LaneCopy[] = [
  {
    key: "outreach",
    title: "1차 콜드메일(캠페인 아웃리치) 발송",
    desc: "프로그램 > 캠페인에서 승인된 첫 접촉 메일",
    enabledText: "발송이 허용되어 있습니다. 승인된 캠페인 메일은 한도와 일정에 따라 발송됩니다.",
    pausedText: "정지 중입니다. 캠페인 메일은 큐에 쌓이기만 하고 나가지 않습니다.",
    confirmPause: "1차 콜드메일 발송을 정지합니다. 승인된 캠페인 메일이 나가지 않습니다. 계속할까요?",
    confirmResume: "1차 콜드메일 발송을 재개합니다. 승인된 캠페인 메일이 즉시 나가기 시작합니다. 계속할까요?",
  },
  {
    key: "nudge",
    title: "독려 메일 발송",
    desc: "읽음·무응답 / 지원·미제출 / 미열람 3개 코호트 재촉 메일",
    enabledText: "발송이 허용되어 있습니다. 독려 3종은 대상 조건과 한도에 따라 발송됩니다.",
    pausedText: "정지 중입니다. 드레인이 대상을 집지 않으므로 차단 기록도 남지 않습니다.",
    confirmPause: "독려 메일 발송을 정지합니다. 세 코호트 재촉 메일이 나가지 않습니다. 계속할까요?",
    confirmResume: "독려 메일 발송을 재개합니다. 대기 중인 독려 대상에게 즉시 나가기 시작합니다. 계속할까요?",
  },
];

function formatChangedAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

/** 하드락은 `blockedUntilIso` 가 미래일 때만 유효하다 — 만료된 값이 남아 있어도 잠금이 아니다. */
function hardLockActive(lock: EmailModeOutboundLock | null): boolean {
  if (!lock) return false;
  const untilMs = Date.parse(lock.blockedUntilIso ?? "");
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

function laneAudit(lock: EmailModeOutboundLock | null, lane: LaneKey): { changedBy: string | null; changedAt: string } {
  if (!lock) return { changedBy: null, changedAt: "" };
  if (lane === "nudge") {
    return {
      changedBy: lock.nudgeUpdatedBy ?? null,
      changedAt: formatChangedAt(lock.nudgeUpdatedAtIso),
    };
  }
  return {
    changedBy: lock.updatedBy ?? null,
    changedAt: formatChangedAt(lock.updatedAtIso),
  };
}

function globalDailyTotalCapText(cap: number | null): string {
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
    return "비거래성 메일 합산 일일 상한: 조회미확인. 기존 발송 간격과 개별 레인 한도는 계속 적용됩니다.";
  }
  return `비거래성 메일 합산 하루 최대 ${Math.round(cap).toLocaleString("ko-KR")}건. 기존 발송 간격과 개별 레인 한도도 적용됩니다.`;
}

export default function MailLaneSwitchesCard() {
  const { role } = useRole();
  const isSuperAdmin = role === "super_admin";

  const [enabled, setEnabled] = useState<Record<LaneKey, boolean> | null>(null);
  const [lock, setLock] = useState<EmailModeOutboundLock | null>(null);
  const [globalDailyTotalCap, setGlobalDailyTotalCap] = useState<number | null>(null);
  const [busyLane, setBusyLane] = useState<LaneKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getEmailMode()
      .then((res) => {
        if (!active) return;
        setEnabled({
          outreach: res.outreachSendingEnabled === true,
          nudge: res.nudgeSendingEnabled === true,
        });
        setLock(res.outboundLock ?? null);
        setGlobalDailyTotalCap(
          typeof res.globalDailyTotalCap === "number" && Number.isFinite(res.globalDailyTotalCap)
            ? res.globalDailyTotalCap
            : null,
        );
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "메일 발송 상태 조회 실패");
      });
    return () => {
      active = false;
    };
  }, []);

  const toggle = useCallback(
    async (lane: LaneCopy) => {
      if (!enabled || busyLane) return;
      const next = !enabled[lane.key];
      if (!window.confirm(next ? lane.confirmResume : lane.confirmPause)) return;

      const previous = enabled;
      // 옵티미스틱: 먼저 바꾸고, 실패하면 되돌린다.
      setEnabled({ ...previous, [lane.key]: next });
      setBusyLane(lane.key);
      setError(null);
      try {
        const res = await setEmailMode(
          lane.key === "nudge" ? { nudgeSendingEnabled: next } : { outreachSendingEnabled: next },
        );
        setEnabled({
          outreach: res.outreachSendingEnabled === true,
          nudge: res.nudgeSendingEnabled === true,
        });
        setLock(res.outboundLock ?? null);
        setGlobalDailyTotalCap(
          typeof res.globalDailyTotalCap === "number" && Number.isFinite(res.globalDailyTotalCap)
            ? res.globalDailyTotalCap
            : null,
        );
      } catch (err: unknown) {
        setEnabled(previous);
        setError(err instanceof Error ? err.message : "메일 발송 스위치 변경 실패");
      } finally {
        setBusyLane(null);
      }
    },
    [busyLane, enabled],
  );

  const locked = hardLockActive(lock);

  return (
    <Card className={enabled && (!enabled.outreach || !enabled.nudge) ? "border-warn/40" : undefined}>
      <CardHeader
        title="메일 발송 스위치 (레인별)"
        desc="1차 콜드메일과 독려 메일을 따로 켜고 끕니다 — 거래성 메일(지원확인·로그인승인·콘텐츠접수 등)은 이 스위치의 대상이 아닙니다"
        action={
          enabled === null ? (
            <Badge tone="neutral">불러오는 중</Badge>
          ) : locked ? (
            <Badge tone="danger" dot>
              자동 잠금
            </Badge>
          ) : enabled.outreach && enabled.nudge ? (
            <Badge tone="ok" dot>
              두 종류 발송 허용
            </Badge>
          ) : (
            <Badge tone="warn" dot>
              일부 정지
            </Badge>
          )
        }
      />

      {locked && (
        <div className="border-b border-line bg-danger-soft px-5 py-3 text-[13px] text-danger">
          <span className="font-semibold">자동 잠금이 활성화되어 있습니다.</span> 아래 토글과 무관하게
          모든 레인의 발송이 차단됩니다
          {lock?.blockedUntilIso ? ` (해제 예정: ${formatChangedAt(lock.blockedUntilIso)})` : ""}.
          {lock?.ruleId ? <span className="ml-1 opacity-80">[{lock.ruleId}]</span> : null}
        </div>
      )}

      <div className="border-b border-line px-5 py-3 text-xs text-ink-2">
        {globalDailyTotalCapText(globalDailyTotalCap)}
      </div>

      <ul className="divide-y divide-line">
        {LANES.map((lane) => {
          const laneEnabled = enabled?.[lane.key] ?? null;
          const { changedBy, changedAt } = laneAudit(lock, lane.key);
          return (
            <li key={lane.key} className="flex items-start justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{lane.title}</span>
                  {laneEnabled === null ? (
                    <Badge tone="neutral">확인 중</Badge>
                  ) : laneEnabled ? (
                    <Badge tone="ok" dot>
                      발송 허용
                    </Badge>
                  ) : (
                    <Badge tone="warn" dot>
                      정지
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-3">{lane.desc}</p>
                <p className="mt-1.5 text-[13px] text-ink-2">
                  {laneEnabled === null
                    ? "현재 상태를 불러오는 중입니다."
                    : laneEnabled
                      ? lane.enabledText
                      : lane.pausedText}
                </p>
                {(changedBy || changedAt) && (
                  <p className="mt-1 text-xs text-ink-3">
                    최근 변경{changedAt ? `: ${changedAt}` : ""}
                    {changedBy ? ` · ${changedBy}` : ""}
                  </p>
                )}
              </div>
              {isSuperAdmin ? (
                <Button
                  variant={laneEnabled === false ? "secondary" : "danger"}
                  size="sm"
                  className="shrink-0"
                  disabled={laneEnabled === null || busyLane !== null}
                  onClick={() => void toggle(lane)}
                >
                  {busyLane === lane.key
                    ? "변경 중…"
                    : laneEnabled === false
                      ? "발송 재개"
                      : "발송 중지"}
                </Button>
              ) : (
                // 서버가 super_admin 을 최종 검증한다(AUTH-P0). 화면은 그 사실을 미리 알린다.
                <Badge tone="neutral" className="shrink-0">
                  Super Admin 전용
                </Badge>
              )}
            </li>
          );
        })}
      </ul>

      {error && <div className="border-t border-line px-5 py-3 text-xs text-danger">{error}</div>}
    </Card>
  );
}
