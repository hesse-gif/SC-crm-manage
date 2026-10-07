"use client";

// W62-2 [헤세 · 지원 관리 탭] — apply 완료 · 영상 미제출자 트래킹 + 조치
//
// ■ 1차 범위가 왜 이런가 (리더 판정 L2026-0810-04 (1) — (a)안)
//   프로드 실측에서 미제출 56건 중 **54건은 크리에이터 신원이 해석되지 않는다**(썸네일·핸들 없음).
//   사진을 기다리며 탭을 미루는 대신, 헤세의 핵심 니즈(누가 안 냈나 + 조치)를 먼저 낸다.
//   해석된 신원이 있으면 그 자리에 표시하고, 없으면 applicationId 를 정체로 쓴다. 백필은 W63.
//
// ■ 버튼이 둘인 이유 (판정 (2) — 모수 분리)
//   확인 메일이 실제로 전달된 사람(실측 26)만 "재촉" 대상이다. dead_letter 로 죽은 사람(실측 28)은
//   **처음 안내를 받은 적이 없어서** 재촉이 아니라 확인 메일 재발송이 맞다.
//   화면은 그 구분을 배지로 보여주고, 실제 강제는 서버가 한다(화면만 막으면 뚫린다).
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import {
  enqueueApplicationVideoReminderMail,
  listApplicationVideoPending,
  type ApplicationVideoPendingEnvelope,
  type ApplicationVideoPendingRow,
} from "@/lib/data";

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "요청을 처리하지 못했습니다.";
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toISOString().slice(0, 10);
}

/** 미제출 경과일 — 헤세가 실제로 보고 싶어 한 축이다. 오래된 순으로 눈에 띄어야 한다. */
function elapsedTone(days: number | null): "warn" | "danger" | "neutral" {
  if (days === null) return "neutral";
  if (days >= 14) return "danger";
  if (days >= 7) return "warn";
  return "neutral";
}

function DeliveryBadge({ row }: { row: ApplicationVideoPendingRow }) {
  if (row.confirmationDelivery === "delivered") return <Badge tone="ok">안내 전달됨</Badge>;
  // dead_letter 를 "실패"라고만 쓰면 운영자가 재촉을 눌러도 되는 줄 안다. 무엇이 필요한지를 쓴다.
  if (row.confirmationDelivery === "dead_letter") return <Badge tone="danger">안내 미전달 · 재발송 필요</Badge>;
  if (row.confirmationDelivery === "pending") return <Badge tone="warn">안내 발송 중</Badge>;
  return <Badge tone="neutral">안내 기록 없음</Badge>;
}

/** W72 C-1: 브리프 §3 의 3꼭지. 서버 코호트 키와 같은 문자열을 쓴다(화면 전용 별칭을 만들지 않는다). */
type CohortKey = "cohort1_read_no_reply" | "cohort2_applied_no_video" | "cohort3_unread_no_reply";

export function ApplicationVideoPendingPanel() {
  const [envelope, setEnvelope] = useState<ApplicationVideoPendingEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // 기본 선택은 **정본이 있는** 코호트2 다 — 빈 화면으로 시작하지 않는다.
  const [cohort, setCohort] = useState<CohortKey>("cohort2_applied_no_video");
  const [actionByApplication, setActionByApplication] = useState<
    Record<string, { status: "idle" | "loading" | "done" | "error"; message: string }>
  >({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await listApplicationVideoPending({ limit: 200 });
      setEnvelope(result);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const list = envelope?.rows ?? [];
    // 오래 밀린 사람이 위로 온다 — 이 화면의 목적이 "누가 오래 안 냈나"다.
    return [...list].sort((a, b) => (b.daysSinceApply ?? -1) - (a.daysSinceApply ?? -1));
  }, [envelope]);

  async function handleNudge(row: ApplicationVideoPendingRow) {
    const key = row.applicationId;
    setActionByApplication((prev) => ({ ...prev, [key]: { status: "loading", message: "재촉 메일 예약 중…" } }));
    try {
      const result = await enqueueApplicationVideoReminderMail({ applicationId: key });
      setActionByApplication((prev) => ({
        ...prev,
        // "발송됨"이 아니라 "예약됨"이다 — 실제 발송은 승인·쿼터 게이트가 걸린 드레인이 한다.
        // 여기서 "발송 완료"라고 쓰면 아직 안 나간 메일을 나갔다고 보고하는 것이다.
        [key]: { status: "done", message: `재촉 메일을 예약했습니다. 다음 재촉 가능: ${formatDate(result.cooldownUntilIso)}` },
      }));
      await load();
    } catch (error) {
      setActionByApplication((prev) => ({ ...prev, [key]: { status: "error", message: errorText(error) } }));
    }
  }

  if (loading && !envelope) {
    return <LoadingStatus className="justify-center border-y border-line py-8">지원 목록을 불러오는 중</LoadingStatus>;
  }
  if (loadError) {
    return (
      <div data-testid="scp-application-pending-error" className="rounded-lg border border-line bg-paper p-4 text-sm text-ink-2">
        목록을 불러오지 못했습니다: {loadError}
      </div>
    );
  }

  const counts = envelope?.counts;

  // W72 C-1 [브리프 §3 계약]: 건수는 **집계 정본에서 읽는다. 화면에서 새로 계산하지 않는다.**
  //   코호트2 는 이 콜러블의 counts 가 정본이다.
  //   코호트1·3 은 "읽었는데 무행동" / "안 읽고 무회신"의 **인원 수 정본이 아직 없다**
  //   (아웃리치 스냅샷은 발송일 코호트별 sent/open/reply 합계이지 이 교집합의 인원 수가 아니다).
  //   → 0 으로 채우지 않는다. `null` 은 "측정 불가"로 표시한다(W68 계약).
  const cohorts: Array<{
    key: CohortKey;
    label: string;
    count: number | null;
    unmeasuredReason: string;
  }> = [
    {
      key: "cohort1_read_no_reply",
      label: "① 읽음·무행동",
      count: null,
      unmeasuredReason: "집계 정본 없음 — 오픈∩무회신∩무지원 인원 수 축이 아직 없습니다",
    },
    {
      key: "cohort2_applied_no_video",
      label: "② Apply·영상 미제출",
      count: counts?.nudgeEligible ?? null,
      unmeasuredReason: "",
    },
    {
      key: "cohort3_unread_no_reply",
      label: "③ 미열람·무회신",
      count: null,
      unmeasuredReason: "집계 정본 없음 — 미오픈∩무회신 인원 수 축이 아직 없습니다",
    },
  ];
  const activeCohort = cohorts.find((item) => item.key === cohort) ?? cohorts[1];

  return (
    <div data-testid="scp-application-pending-panel" className="space-y-4">
      {/* W72 C-1: 3꼭지 버튼. 누르면 그 코호트만 테이블에 남는다(브리프 §3). */}
      <div className="flex flex-wrap gap-2" data-testid="scp-cohort-buttons">
        {cohorts.map((item) => {
          const selected = item.key === cohort;
          return (
            <button
              key={item.key}
              type="button"
              data-testid={`scp-cohort-button-${item.key}`}
              // 선택 상태를 CSS 로만 표현하면 스크린리더도 테스트도 못 읽는다 — 사실로 노출한다.
              aria-pressed={selected}
              onClick={() => setCohort(item.key)}
              className={`min-h-10 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                selected
                  ? "border-ink bg-fill font-semibold text-ink"
                  : "border-line bg-paper text-ink-2 hover:bg-fill"
              }`}
            >
              <span className="block">{item.label}</span>
              <span className="mt-0.5 block text-[11px] text-ink-3">
                {item.count === null ? "측정 불가" : `${item.count}명`}
              </span>
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-line bg-paper p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
          <span className="font-semibold text-ink">영상 미제출 {counts?.pending ?? 0}명</span>
          <span>재촉 가능 {counts?.nudgeEligible ?? 0}</span>
          <span>안내 재발송 필요 {counts?.resendEligible ?? 0}</span>
          {counts?.blocked ? <span>판단 보류 {counts.blocked}</span> : null}
          {counts?.inCooldown ? <span>쿨다운 중 {counts.inCooldown}</span> : null}
        </div>
        <p className="mt-2 text-xs text-ink-3">
          재촉은 확인 메일이 <strong>실제로 전달된</strong> 지원자에게만 보냅니다. 안내가 전달되지 않은 지원자는
          재촉이 아니라 확인 메일 재발송 대상입니다(처음 안내를 받은 적이 없습니다).
          연타 방지를 위해 재촉은 {envelope?.cooldownDays ?? 3}일 쿨다운이 걸립니다.
        </p>
      </div>

      {activeCohort.count === null ? (
        // W68 계약: 정본이 없는 축을 0 으로 채우지 않는다. **왜 못 세는지**를 그 자리에 쓴다.
        <div
          data-testid="scp-cohort-unmeasured"
          className="rounded-lg border border-line bg-paper p-6 text-center text-sm text-ink-2"
        >
          <div className="font-semibold text-ink">측정 불가</div>
          <p className="mt-1 text-xs text-ink-3">{activeCohort.unmeasuredReason}</p>
          <p className="mt-1 text-xs text-ink-3">
            이 코호트의 발송 레인은 아직 구현 전입니다(W72 작업 A). 건수를 0 으로 표시하지 않습니다.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-paper p-6 text-center text-sm text-ink-2">
          영상 미제출 지원자가 없습니다.
        </div>
      ) : (
        // W72 C-1 [브리프 §3]: 카드 나열이 아니라 **테이블뷰**다. 열이 고정돼야 "누가 오래 안 냈나"를
        //   위에서 아래로 훑을 수 있다 — 헤세가 이 화면에서 실제로 하는 일이 그것이다.
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full min-w-[720px] text-left text-xs" data-testid="scp-application-pending-table">
            <thead className="border-b border-line text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">지원자</th>
                <th scope="col" className="px-3 py-2 font-semibold">안내 상태</th>
                <th scope="col" className="px-3 py-2 font-semibold">미제출</th>
                <th scope="col" className="px-3 py-2 font-semibold">지원일</th>
                <th scope="col" className="px-3 py-2 font-semibold">재촉</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">조치</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const action = actionByApplication[row.applicationId] ?? { status: "idle" as const, message: "" };
                const inCooldown = Boolean(row.cooldownUntilIso);
                const tone = elapsedTone(row.daysSinceApply);
                return (
                  <tr
                    key={row.applicationId}
                    data-testid="scp-application-pending-row"
                    className="border-b border-line last:border-b-0 align-top"
                  >
                    <td className="px-3 py-2">
                      <span className="block max-w-[220px] truncate font-semibold text-ink">
                        {row.creatorDisplayName || row.creatorHandle || row.applicationId}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-3">
                        프로그램 {row.programId || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2"><DeliveryBadge row={row} /></td>
                    <td className="px-3 py-2">
                      {row.daysSinceApply !== null ? (
                        <Badge tone={tone}>{row.daysSinceApply}일</Badge>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-2">{formatDate(row.appliedAtIso)}</td>
                    <td className="px-3 py-2 text-ink-2">
                      {/* W72 [R1 P2-8]: 이 값은 **받은 통수**다(적재 횟수가 아니다). */}
                      {row.reminderCount > 0
                        ? `${row.reminderCount}회 · 마지막 ${formatDate(row.lastReminderAtIso)}`
                        : "없음"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-end gap-1">
                        {row.availableAction === "nudge" && envelope?.reminderSendEnabled ? (
                          <button
                            type="button"
                            onClick={() => void handleNudge(row)}
                            disabled={action.status === "loading" || inCooldown}
                            className="min-h-9 rounded-md border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-fill disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {action.status === "loading"
                              ? "예약 중…"
                              : inCooldown
                                ? `쿨다운 · ${formatDate(row.cooldownUntilIso)}까지`
                                : "재촉하기"}
                          </button>
                        ) : null}
                        {row.availableAction === "resend_confirmation" ? (
                          // 아직 실행 경로가 열리지 않았다(수리 A 이후 리더 승인 대기 — 지금 보내면 같은
                          // 이유로 또 죽는다). 눌리지 않는 버튼 대신 이유를 그 자리에 쓴다.
                          <span className="text-right text-[11px] text-ink-3">
                            확인 메일 재발송 대기
                            <br />
                            (발송 경로 수리 후 승인 시 일괄)
                          </span>
                        ) : null}
                        {/* W62c-C3: 워커 미배선이면 버튼을 내지 않는다 — 누르면 이력·쿨다운만 타고
                            "보냈다고 표시되는데 아무도 안 받는" 상태가 된다. */}
                        {row.availableAction === "nudge" && !envelope?.reminderSendEnabled ? (
                          <span className="text-right text-[11px] text-ink-3">재촉 대기 · 발송 워커 배선 후 활성화</span>
                        ) : null}
                        {row.availableAction === "blocked" ? (
                          <span className="text-right text-[11px] text-ink-3">안내 기록 확인 필요</span>
                        ) : null}
                        {action.message ? (
                          <span
                            className={`text-right text-[11px] ${action.status === "error" ? "text-danger" : "text-ink-3"}`}
                          >
                            {action.message}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
