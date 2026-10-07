"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  getEmailMode,
  getScpNudgeSequenceConfig,
  getSettings,
  saveScpNudgeSequenceConfig,
  setEmailMode,
  updateSettings,
  type EmailModeCountState,
  type EmailModeEnvelope,
  type EmailModeMailAdminStatus,
  type NudgeSequenceConfigEnvelope,
  type SettingsEnvelope,
} from "@/lib/data";
import { callableErrorCode, publicCallableErrorMessage, requestDataRefresh } from "@/lib/live";
import { useRole } from "@/lib/role";


const NUDGE_COHORT_CAP_LABELS: Record<string, string> = {
  cohort1_read_no_reply: "독려 1종 일 상한",
  cohort2_applied_no_video: "독려 2종 일 상한",
  cohort3_unread_no_reply: "독려 3종 일 상한",
};

type ControlDraft = {
  coldDailyCap: string;
  providerDailyCap: string;
  providerHourlyCap: string;
  providerWeeklyCap: string;
  providerUniqueRecipientDailyCap: string;
  nudgeCohortDailyCaps: Record<string, string>;
  nudgeTotalDailyCap: string;
};

function formatInt(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("ko-KR") : "확인 불가";
}

function formatCount(count: EmailModeCountState | undefined): string {
  if (!count) return "확인 불가";
  if (count.state === "unavailable") return "확인 불가";
  return formatInt(count.value);
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "확인 불가";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "확인 불가";
  return new Date(ms).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function parseCap(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label}은 0 이상의 정수여야 합니다.`);
  return parsed;
}

function draftFrom(settings: SettingsEnvelope, nudge: NudgeSequenceConfigEnvelope, status: EmailModeMailAdminStatus | null = null): ControlDraft {
  return {
    coldDailyCap: String(settings.settings.automation.maxDailyOutreachSends),
    providerDailyCap: String(settings.settings.mailSafety.outboundPolicy.dailyCap),
    providerHourlyCap: String(settings.settings.mailSafety.outboundPolicy.hourlyCap),
    providerWeeklyCap: String(settings.settings.mailSafety.outboundPolicy.weeklyTotalCap),
    providerUniqueRecipientDailyCap: String(status?.providerQuota.uniqueRecipients.cap ?? settings.settings.mailSafety.outboundPolicy.uniqueRecipientDailyCap),
    nudgeCohortDailyCaps: Object.fromEntries(nudge.cohorts.map((cohort) => [cohort.cohort, String(cohort.dailyCap)])),
    nudgeTotalDailyCap: nudge.totalDailyCap === null ? "" : String(nudge.totalDailyCap),
  };
}

function StatusNumber({ label, value, desc, pausedNote }: { label: string; value: string; desc?: string; pausedNote?: string | null }) {
  return (
    <div className="rounded-md border border-line bg-fill px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-ink-3">{label}</div>
        {pausedNote ? <Badge tone="warn" dot>레인 정지 중</Badge> : null}
      </div>
      <div className="mt-1 text-lg font-bold leading-none text-ink">{value}</div>
      {pausedNote ? <div className="mt-1 text-[11px] text-warn">{pausedNote}</div> : desc ? <div className="mt-1 text-[11px] text-ink-3">{desc}</div> : null}
    </div>
  );
}

// W118: getEmailMode 응답의 레인 스위치가 꺼져 있으면 "내일 가능 상한"은 그 레인 몫이 이미 0으로
// 클램프된 숫자다 — 배지 없이 숫자만 보이면 운영자가 "정지 중인데 왜 숫자가 있지"로 오해한다.
function tomorrowUpperBoundPausedNote(mode: EmailModeEnvelope | null): string | null {
  if (!mode) return null;
  const outreachPaused = mode.outreachSendingEnabled !== true;
  const nudgePaused = mode.nudgeSendingEnabled !== true;
  if (outreachPaused && nudgePaused) return "아웃리치·독려 레인 모두 정지 중 — 두 레인 몫 모두 0으로 반영됨";
  if (outreachPaused) return "아웃리치 레인 정지 중 — 콜드메일 몫은 0으로 반영됨";
  if (nudgePaused) return "독려 레인 정지 중 — 독려 몫은 0으로 반영됨";
  return null;
}

function CapInput({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix: string;
}) {
  return (
    <label className="flex min-w-[170px] flex-1 items-center justify-between gap-3 rounded-md border border-line bg-paper px-3 py-2">
      <span className="text-xs font-semibold text-ink-2">{label}</span>
      <span className="flex items-center gap-1">
        <input
          className="h-8 w-20 rounded-md border border-line bg-fill px-2 text-right text-sm font-semibold text-ink outline-none focus:border-accent"
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ""))}
        />
        <span className="text-xs text-ink-3">{suffix}</span>
      </span>
    </label>
  );
}

export default function MailAdminControlsCard() {
  const { role } = useRole();
  const isSuperAdmin = role === "super_admin";
  const canEditCaps = role === "super_admin" || role === "admin" || role === "manager";
  const [mode, setMode] = useState<EmailModeEnvelope | null>(null);
  const [settings, setSettings] = useState<SettingsEnvelope | null>(null);
  const [nudge, setNudge] = useState<NudgeSequenceConfigEnvelope | null>(null);
  const [draft, setDraft] = useState<ControlDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status: EmailModeMailAdminStatus | null = mode?.mailAdminStatus ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextMode, nextSettings, nextNudge] = await Promise.all([
        getEmailMode(),
        getSettings(),
        getScpNudgeSequenceConfig(),
      ]);
      setMode(nextMode);
      setSettings(nextSettings);
      setNudge(nextNudge);
      setDraft(draftFrom(nextSettings, nextNudge, nextMode.mailAdminStatus ?? null));
    } catch (caught) {
      setError(publicCallableErrorMessage(caught, "메일 운영 상태를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!settings || !nudge || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(draftFrom(settings, nudge, status));
  }, [draft, nudge, settings, status]);

  async function togglePracticeMode() {
    if (!mode || practiceBusy || !isSuperAdmin) return;
    setPracticeBusy(true);
    setError(null);
    try {
      const updated = await setEmailMode({ practiceMode: !mode.practiceMode });
      setMode(updated);
    } catch (caught) {
      setError(publicCallableErrorMessage(caught, "이메일 모드를 변경하지 못했습니다."));
    } finally {
      setPracticeBusy(false);
    }
  }

  async function saveCaps() {
    if (!settings || !nudge || !draft || !canEditCaps) return;
    setSaving(true);
    setError(null);
    try {
      const baseline = draftFrom(settings, nudge);
      const settingsChanged =
        draft.coldDailyCap !== baseline.coldDailyCap
        || draft.providerDailyCap !== baseline.providerDailyCap
        || draft.providerHourlyCap !== baseline.providerHourlyCap
        || draft.providerWeeklyCap !== baseline.providerWeeklyCap
        || draft.providerUniqueRecipientDailyCap !== baseline.providerUniqueRecipientDailyCap;
      const nudgeChanged = draft.nudgeTotalDailyCap !== baseline.nudgeTotalDailyCap
        || JSON.stringify(draft.nudgeCohortDailyCaps) !== JSON.stringify(baseline.nudgeCohortDailyCaps);
      if (!settingsChanged && !nudgeChanged) return;
      const coldDailyCap = parseCap(draft.coldDailyCap, "콜드메일 일 상한") ?? 0;
      const providerDailyCap = parseCap(draft.providerDailyCap, "UTC 일일 제공자 제한") ?? 0;
      const providerHourlyCap = parseCap(draft.providerHourlyCap, "UTC 시간당 제공자 제한") ?? 0;
      const providerWeeklyCap = parseCap(draft.providerWeeklyCap, "UTC 주간 제공자 제한") ?? 0;
      const providerUniqueRecipientDailyCap = parseCap(draft.providerUniqueRecipientDailyCap, "고유 수신자 일 상한") ?? 0;
      const nudgeCohortDailyCaps = Object.fromEntries(
        Object.entries(draft.nudgeCohortDailyCaps).map(([cohort, value]) => [cohort, parseCap(value, "독려 코호트 일 상한") ?? 0]),
      );
      const nudgeTotalDailyCap = parseCap(draft.nudgeTotalDailyCap, "독려 전체 일 상한");
      let latestSettings = settings;
      let latestNudge = nudge;
      if (settingsChanged) {
        const previousPolicy = settings.settings.mailSafety.outboundPolicy;
        const nextPolicy = {
          ...previousPolicy,
          dailyCap: providerDailyCap,
          hourlyCap: providerHourlyCap,
          weeklyTotalCap: providerWeeklyCap,
          uniqueRecipientDailyCap: providerUniqueRecipientDailyCap,
        };
        const requiresHighRiskConfirm = providerDailyCap >= 500 && providerDailyCap !== previousPolicy.dailyCap;
        latestSettings = await updateSettings({
          expectedRevision: settings.revision,
          patch: {
            automation: { maxDailyOutreachSends: coldDailyCap },
            mailSafety: { outboundPolicy: nextPolicy },
          },
          ...(requiresHighRiskConfirm ? { confirm: true } : {}),
        });
      }
      if (nudgeChanged) {
        await saveScpNudgeSequenceConfig({
          totalDailyCapOnly: true,
          expectedUpdatedAtIso: nudge.updatedAtIso,
          cohortDailyCaps: nudgeCohortDailyCaps,
          totalDailyCap: nudgeTotalDailyCap,
        });
        latestNudge = await getScpNudgeSequenceConfig();
      }
      const latestMode = await getEmailMode();
      setSettings(latestSettings);
      setNudge(latestNudge);
      setMode(latestMode);
      setDraft(draftFrom(latestSettings, latestNudge, latestMode.mailAdminStatus ?? null));
      requestDataRefresh();
    } catch (caught) {
      await load().catch(() => undefined);
      if (callableErrorCode(caught) === "aborted") {
        setError("다른 운영자가 먼저 변경했습니다. 서버 최신값을 다시 불러왔습니다.");
      } else {
        setError(publicCallableErrorMessage(caught, caught instanceof Error ? caught.message : "메일 상한을 저장하지 못했습니다."));
      }
    } finally {
      setSaving(false);
    }
  }


  function applyNudge950Preset() {
    if (!draft || !nudge) return;
    setDraft({
      ...draft,
      providerUniqueRecipientDailyCap: "950",
      nudgeTotalDailyCap: "750",
      nudgeCohortDailyCaps: Object.fromEntries(nudge.cohorts.map((cohort) => [cohort.cohort, "250"])),
    });
  }

  return (
    <Card className={mode?.practiceMode === false ? "border-danger/40" : undefined}>
      <CardHeader
        title="메일 운영 상태와 상한"
        desc="콜드메일·독려·제공자 발송 제한을 같은 관리자 화면에서 확인하고 조정합니다"
        action={
          loading ? (
            <Badge tone="neutral">불러오는 중</Badge>
          ) : mode?.practiceMode === false ? (
            <Badge tone="danger" dot>실발송</Badge>
          ) : (
            <Badge tone="ok" dot>연습모드</Badge>
          )
        }
      />

      {mode ? (
        <div className="space-y-4 px-5 py-4">
          {status ? (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <StatusNumber label="오늘 콜드메일 발송" value={formatCount(status.coldOutreach.todaySent)} desc={`하루 상한 ${formatInt(status.coldOutreach.effectiveDailyCap)}건`} />
                <StatusNumber label="승인 큐" value={formatInt(status.approvedQueue.count)} desc={status.approvedQueue.truncated ? "표본 목록은 잘림" : "전체 확인"} />
                <StatusNumber label="설정상 하루 합계" value={formatInt(status.configuredDailyCombinedCap.value)} desc="콜드메일+독려 1일 기준" />
                <StatusNumber
                  label="내일 가능 상한"
                  value={formatInt(status.tomorrowPotentialUpperBound.value)}
                  desc="09시 리셋 반영, 보장 수량 아님"
                  pausedNote={tomorrowUpperBoundPausedNote(mode)}
                />
                <StatusNumber label="비거래성 전체 사용" value={formatCount(status.providerQuota.globalDaily.sent)} desc={`하루 상한 ${formatInt(status.providerQuota.globalDaily.cap)}건`} />
              </div>

          <div className="grid gap-3 text-xs text-ink-2 lg:grid-cols-2">
            <div className="rounded-md border border-line bg-paper p-3">
              <div className="mb-2 font-semibold text-ink">리셋</div>
              <div>콜드메일 하루 기준: {formatDateTime(status.resets.kstOutreachDayResetIso)} (한국시간 자정)</div>
              <div>제공자 하루 제한: {formatDateTime(status.resets.utcQuotaDayResetIso)} (한국시간 09시)</div>
              <div>제공자 시간 제한: {formatDateTime(status.resets.utcQuotaHourResetIso)}</div>
              <div>제공자 주간 제한: {formatDateTime(status.resets.utcQuotaWeekResetIso)}</div>
            </div>
            <div className="rounded-md border border-line bg-paper p-3">
              <div className="mb-2 font-semibold text-ink">상한 제약</div>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {status.tomorrowPotentialUpperBound.constraints.map((constraint) => (
                  <div key={constraint.key} className="flex justify-between gap-2">
                    <span className="truncate">{constraint.label}</span>
                    <span className={constraint.state === "unavailable" ? "font-semibold text-danger" : "font-semibold text-ink"}>
                      {constraint.state === "unavailable" ? "확인 불가" : formatInt(constraint.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
              </div>
            </>
          ) : (
            <div className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-2">
              기본 발송 모드는 확인했습니다. 상세 운영 상태는 지금 확인할 수 없지만 모드와 상한은 조정할 수 있습니다.
            </div>
          )}

          {draft && (
            <div className="space-y-3 rounded-md border border-line bg-fill p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-ink">상한 편집</div>
                  <div className="text-xs text-ink-3">변경한 항목만 서버 최신값 기준으로 저장합니다.</div>
                </div>
                {canEditCaps ? <Badge tone="neutral">편집 가능</Badge> : <Badge tone="neutral">편집 권한 없음</Badge>}
              </div>
              <div className="flex flex-wrap gap-2">
                <CapInput label="콜드메일 일 상한" value={draft.coldDailyCap} suffix="건/하루" onChange={(value) => setDraft({ ...draft, coldDailyCap: value })} />
                <CapInput label="제공자 일 상한" value={draft.providerDailyCap} suffix="건/하루" onChange={(value) => setDraft({ ...draft, providerDailyCap: value })} />
                <CapInput label="제공자 시간 상한" value={draft.providerHourlyCap} suffix="건/시간" onChange={(value) => setDraft({ ...draft, providerHourlyCap: value })} />
                <CapInput label="제공자 주간 상한" value={draft.providerWeeklyCap} suffix="건/주 · 0=제한 없음" onChange={(value) => setDraft({ ...draft, providerWeeklyCap: value })} />
                <CapInput label="고유 수신자 일 상한" value={draft.providerUniqueRecipientDailyCap} suffix="건/하루" onChange={(value) => setDraft({ ...draft, providerUniqueRecipientDailyCap: value })} />
                {(nudge?.cohorts ?? []).map((cohort) => (
                  <CapInput
                    key={cohort.cohort}
                    label={NUDGE_COHORT_CAP_LABELS[cohort.cohort] ?? "독려 일 상한"}
                    value={draft.nudgeCohortDailyCaps[cohort.cohort] ?? ""}
                    suffix="건/하루"
                    onChange={(value) => setDraft({
                      ...draft,
                      nudgeCohortDailyCaps: { ...draft.nudgeCohortDailyCaps, [cohort.cohort]: value },
                    })}
                  />
                ))}
                <CapInput label="독려 전체 일 상한" value={draft.nudgeTotalDailyCap} suffix="건/하루 · 빈칸=코호트별만" onChange={(value) => setDraft({ ...draft, nudgeTotalDailyCap: value })} />
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" disabled={!canEditCaps || saving} onClick={applyNudge950Preset}>
                  독려 250×3 · 전체 750 적용
                </Button>
                <Button size="sm" disabled={!canEditCaps || !dirty || saving} onClick={saveCaps}>
                  {saving ? "저장 중…" : "상한 저장"}
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="text-sm text-ink-2">
              {mode?.practiceMode === false ? (
                <span className="font-semibold text-danger">현재 실발송 모드입니다.</span>
              ) : (
                "현재 연습모드입니다."
              )}
            </div>
            {isSuperAdmin ? (
              <Button
                variant={mode?.practiceMode === false ? "secondary" : "danger"}
                size="sm"
                disabled={!mode || practiceBusy}
                onClick={togglePracticeMode}
              >
                {practiceBusy ? "변경 중…" : mode?.practiceMode === false ? "연습모드로 전환" : "실발송으로 전환"}
              </Button>
            ) : (
              <Badge tone="neutral">모드 전환은 Super Admin 전용</Badge>
            )}
          </div>
        </div>
      ) : (
        <div className="px-5 py-4 text-sm text-ink-2">
          {loading ? "메일 운영 상태를 불러오는 중입니다." : "메일 운영 상태를 확인할 수 없습니다."}
        </div>
      )}

      {error && <div className="border-t border-line px-5 py-3 text-xs text-danger">{error}</div>}
    </Card>
  );
}
