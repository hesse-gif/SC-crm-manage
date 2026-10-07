"use client";

// W72 C-1 — 코호트 × 회차 문안 매핑 (검수 > 메일 템플릿)
//
// ■ 이 카드가 정하는 것
//   "코호트 N 의 M회차에 어떤 템플릿이 나가는가" 하나다. 문안 자체는 위 카드들이 편집한다.
//   매핑과 문안을 한 카드에 섞으면 같은 문안을 여러 회차에 쓸 때 어디를 고쳐야 하는지가 흐려진다.
//
// ■ 화면이 상한을 지어내지 않는다
//   3/10/5·250·실발송 여부는 **서버가 내려주는 코드 천장**을 그대로 쓴다(envelope.cohorts).
//   여기에 상수를 복제하면 코드 천장이 바뀌었을 때 화면만 옛 값을 말한다.
//
// ■ 미설정 회차는 "0" 이 아니라 "없음"이다
//   빈 칸은 발송되지 않는다는 뜻이고, 그 사실을 회차마다 명시한다 — 비어 있는 것과 0회 발송은 다르다.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import {
  getScpNudgeSequenceConfig,
  saveScpNudgeProgramOverride,
  saveScpNudgeSequenceConfig,
  type NudgeSequenceConfigEnvelope,
} from "@/lib/data";

const COHORT_LABELS: Record<string, { title: string; desc: string }> = {
  cohort1_read_no_reply: {
    title: "① 읽었는데 회신·Apply 안 함",
    desc: "메일은 열었지만 아무 행동이 없는 대상",
  },
  cohort2_applied_no_video: {
    title: "② Apply 했지만 영상 미제출",
    desc: "지원은 마쳤고 콘텐츠만 안 낸 대상",
  },
  cohort3_unread_no_reply: {
    title: "③ 안 읽고 회신도 안 함",
    desc: "직전 메일을 열지 않은 대상",
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 0.6.110 — 프로그램/캠페인별 오버라이드. 코호트4(재제출 독려)는 별도 발송기라 대상이 아니다.
const OVERRIDE_COHORTS = ["cohort1_read_no_reply", "cohort2_applied_no_video", "cohort3_unread_no_reply"];

function ProgramOverrideSection({
  envelope,
  onSaved,
}: {
  envelope: NudgeSequenceConfigEnvelope;
  onSaved: () => Promise<void>;
}) {
  const [programKey, setProgramKey] = useState("");
  const [overrideEnabled, setOverrideEnabled] = useState(true);
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const existing = envelope.programOverrides.find((item) => item.id === programKey);

  function selectProgram(next: string) {
    setProgramKey(next);
    setMessage("");
    setFailed(false);
    const found = envelope.programOverrides.find((item) => item.id === next);
    setOverrideEnabled(found ? found.enabled : true);
    setDraft(Object.fromEntries(
      OVERRIDE_COHORTS.map((cohort) => [cohort, { ...(found?.cohorts[cohort] ?? {}) }]),
    ));
  }

  async function submit(remove: boolean) {
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      const cohorts: Record<string, { sequence: Record<string, string> }> = {};
      for (const cohort of OVERRIDE_COHORTS) {
        const sequence = Object.fromEntries(
          Object.entries(draft[cohort] ?? {}).filter(([, value]) => value),
        );
        if (Object.keys(sequence).length > 0) cohorts[cohort] = { sequence };
      }
      const result = await saveScpNudgeProgramOverride({
        programKey: programKey.trim(),
        enabled: overrideEnabled,
        remove,
        expectedUpdatedAtIso: envelope.updatedAtIso,
        cohorts,
      });
      setMessage(
        result.removed
          ? "오버라이드를 삭제했습니다(전역 매핑으로 돌아갑니다)"
          : `저장했습니다 · 매핑 ${result.mappedSequences}개${result.globalEnabled ? "" : " · 전역이 비활성이라 아직 적용되지 않습니다"}`,
      );
      await onSaved();
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="nudge-program-override" className="space-y-3 rounded-lg border border-line bg-paper p-4">
      <div>
        <div className="text-sm font-semibold text-ink">프로그램·캠페인별 문안 오버라이드</div>
        <div className="mt-0.5 text-xs text-ink-3">
          선택한 프로그램/캠페인의 수신자에게만 아래 문안이 나가고, 지원 링크는 그 캠페인의 서명 링크로 바뀝니다.
          지정하지 않은 대상은 위 전역 매핑 그대로입니다. 오버라이드가 있는 코호트에서 비운 회차는 발송되지 않습니다(전역 문안으로 폴백하지 않음).
        </div>
        {envelope.programOverrides.length > 0 ? (
          <div className="mt-1 text-xs text-ink-3">
            저장됨: {envelope.programOverrides.map((item) => `${item.id}${item.enabled ? "" : "(꺼짐)"}`).join(", ")}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select
          data-testid="nudge-program-override-select"
          value={envelope.programOptions.some((option) => option.id === programKey) ? programKey : ""}
          onChange={(event) => selectProgram(event.target.value)}
          className="min-h-9 rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink"
        >
          <option value="">— 프로그램/캠페인 선택 —</option>
          {envelope.programOptions.map((option) => (
            <option key={`${option.kind}:${option.id}`} value={option.id}>
              {option.kind === "program" ? "프로그램" : "캠페인"} · {option.label} ({option.id})
              {envelope.programOverrides.some((item) => item.id === option.id) ? " · 오버라이드 있음" : ""}
            </option>
          ))}
        </select>
        <input
          data-testid="nudge-program-override-key"
          value={programKey}
          placeholder="또는 ID 직접 입력"
          onChange={(event) => selectProgram(event.target.value)}
          className="w-64 rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink"
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="nudge-program-override-enabled"
            checked={overrideEnabled}
            onChange={(event) => setOverrideEnabled(event.target.checked)}
          />
          <span className="text-ink">활성</span>
        </label>
      </div>
      {programKey ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {envelope.cohorts.filter((cohort) => OVERRIDE_COHORTS.includes(cohort.cohort)).map((cohort) => {
            const label = COHORT_LABELS[cohort.cohort] ?? { title: cohort.cohort, desc: "" };
            const options = envelope.templateOptions.filter(
              (item) => item.key.includes(cohort.cohort) || (cohort.cohort === "cohort2_applied_no_video" && item.key === "application_video_reminder"),
            );
            return (
              <div key={cohort.cohort} className="rounded-lg border border-line p-3">
                <div className="text-xs font-semibold text-ink">{label.title}</div>
                <div className="mt-2 space-y-2">
                  {Array.from({ length: cohort.maxSends }, (_, index) => String(index + 1)).map((seq) => (
                    <div key={seq} className="flex items-center gap-2">
                      <span className="w-10 shrink-0 text-xs font-semibold text-ink-2">{seq}회차</span>
                      <select
                        data-testid={`nudge-program-override-select-${cohort.cohort}-${seq}`}
                        value={draft[cohort.cohort]?.[seq] ?? ""}
                        onChange={(event) => setDraft((prev) => ({
                          ...prev,
                          [cohort.cohort]: { ...(prev[cohort.cohort] ?? {}), [seq]: event.target.value },
                        }))}
                        className="min-h-9 w-full rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink"
                      >
                        <option value="">— 미설정(발송 안 함) —</option>
                        {options.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.key}{item.sendable ? "" : ` (${item.status} · 발송 불가)`}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="nudge-program-override-save"
          disabled={saving || !programKey.trim()}
          onClick={() => void submit(false)}
          className="min-h-10 rounded-md border border-line bg-paper px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-fill disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "저장 중…" : "오버라이드 저장"}
        </button>
        {existing ? (
          <button
            type="button"
            data-testid="nudge-program-override-remove"
            disabled={saving}
            onClick={() => void submit(true)}
            className="min-h-10 rounded-md border border-line bg-paper px-4 py-2 text-sm font-semibold text-danger transition-colors hover:bg-fill disabled:cursor-not-allowed disabled:opacity-60"
          >
            오버라이드 삭제
          </button>
        ) : null}
        {message ? <span className={`text-xs ${failed ? "text-danger" : "text-ink-3"}`}>{message}</span> : null}
      </div>
    </div>
  );
}

export function NudgeSequenceMappingCard() {
  const [envelope, setEnvelope] = useState<NudgeSequenceConfigEnvelope | null>(null);
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
  const [enabled, setEnabled] = useState(false);
  const [cadenceDays, setCadenceDays] = useState(7);
  // [헤세 2026-09-03] 빈 문자열 = 미설정(무제한, 코호트별 캡만 적용) — 숫자 0 과 구분한다.
  const [totalDailyCapInput, setTotalDailyCapInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    setFailed(false);
    try {
      const result = await getScpNudgeSequenceConfig();
      setEnvelope(result);
      setEnabled(result.enabled);
      setCadenceDays(result.cadenceDays || 7);
      setTotalDailyCapInput(
        typeof result.totalDailyCap === "number" ? String(result.totalDailyCap) : "",
      );
      const next: Record<string, Record<string, string>> = {};
      for (const cohort of result.cohorts) next[cohort.cohort] = { ...cohort.sequence };
      setDraft(next);
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mappedCount = useMemo(
    () => Object.values(draft).reduce(
      (total, sequence) => total + Object.values(sequence).filter(Boolean).length,
      0,
    ),
    [draft],
  );

  const totalSlots = useMemo(
    () => (envelope?.cohorts ?? []).reduce((total, cohort) => total + cohort.maxSends, 0),
    [envelope],
  );

  async function handleSave() {
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      const cohorts: Record<string, { sequence: Record<string, string> }> = {};
      for (const [cohort, sequence] of Object.entries(draft)) cohorts[cohort] = { sequence };
      const trimmedTotalCap = totalDailyCapInput.trim();
      const totalDailyCap = trimmedTotalCap === "" ? null : Number(trimmedTotalCap);
      const result = await saveScpNudgeSequenceConfig({ enabled, cadenceDays, cohorts, totalDailyCap });
      setMessage(`저장했습니다 · 매핑 ${result.mappedSequences}개 · ${result.enabled ? "활성" : "비활성"}`);
      await load();
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !envelope) {
    return <LoadingStatus className="justify-center border-y border-line py-8">회차 매핑을 불러오는 중</LoadingStatus>;
  }

  return (
    <Card data-testid="nudge-sequence-mapping-card">
      <CardHeader
        title="독려 메일 회차 매핑"
        desc="코호트별로 몇 회차에 어떤 문안이 나갈지 지정합니다. 비어 있는 회차는 발송되지 않습니다."
        action={<Badge tone={enabled ? "ok" : "neutral"}>{enabled ? "활성" : "비활성"}</Badge>}
      />
      <div className="space-y-4 px-5 pb-5">
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-fill p-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="nudge-sequence-enabled"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span className="font-semibold text-ink">전체 활성화</span>
          </label>
          <label className="flex items-center gap-2 text-ink-2">
            주기(일)
            <input
              type="number"
              min={1}
              max={365}
              value={cadenceDays}
              data-testid="nudge-sequence-cadence"
              onChange={(event) => setCadenceDays(Number(event.target.value))}
              className="w-20 rounded-md border border-line bg-paper px-2 py-1 text-ink"
            />
          </label>
          <label className="flex items-center gap-2 text-ink-2" title="세 코호트 합산. 비우면 코호트별 캡만 적용됩니다.">
            전체 일 발송 상한
            <input
              type="number"
              min={0}
              max={envelope?.totalDailyCapCeiling ?? undefined}
              placeholder="무제한"
              value={totalDailyCapInput}
              data-testid="nudge-sequence-total-daily-cap"
              onChange={(event) => setTotalDailyCapInput(event.target.value)}
              className="w-24 rounded-md border border-line bg-paper px-2 py-1 text-ink"
            />
          </label>
          <span className="text-xs text-ink-3">
            세 코호트 합산. 비우면 코호트별 캡만 적용(천장 {envelope?.totalDailyCapCeiling ?? "—"})
          </span>
          <span className="text-xs text-ink-3">
            매핑 {mappedCount} / {totalSlots} 슬롯
          </span>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {(envelope?.cohorts ?? []).map((cohort) => {
            const label = COHORT_LABELS[cohort.cohort] ?? { title: cohort.cohort, desc: "" };
            const sequence = draft[cohort.cohort] ?? {};
            return (
              <div
                key={cohort.cohort}
                data-testid="nudge-sequence-cohort"
                className="rounded-lg border border-line bg-paper p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink">{label.title}</div>
                    <div className="mt-0.5 text-xs text-ink-3">{label.desc}</div>
                  </div>
                  {/* 실발송/초안은 코드 천장이 정한다 — 화면에서 바꿀 수 없다는 사실을 배지로 보인다. */}
                  <Badge tone={cohort.liveSend ? "danger" : "neutral"}>
                    {cohort.liveSend ? "실발송" : "초안만"}
                  </Badge>
                </div>
                <div className="mt-2 text-xs text-ink-3">
                  최대 {cohort.maxSends}회 · 일캡 {cohort.dailyCap} · 주기 {cohort.cadenceDays}일
                </div>
                <div className="mt-3 space-y-2">
                  {Array.from({ length: cohort.maxSends }, (_, index) => String(index + 1)).map((seq) => {
                    const value = sequence[seq] ?? "";
                    const option = envelope?.templateOptions.find((item) => item.key === value);
                    return (
                      <div key={seq} className="flex items-center gap-2">
                        <span className="w-10 shrink-0 text-xs font-semibold text-ink-2">{seq}회차</span>
                        <select
                          data-testid={`nudge-sequence-select-${cohort.cohort}-${seq}`}
                          value={value}
                          onChange={(event) => setDraft((prev) => ({
                            ...prev,
                            [cohort.cohort]: { ...(prev[cohort.cohort] ?? {}), [seq]: event.target.value },
                          }))}
                          className="min-h-9 w-full rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink"
                        >
                          <option value="">— 미설정(발송 안 함) —</option>
                          {(envelope?.templateOptions ?? []).map((item) => (
                            <option key={item.key} value={item.key}>
                              {item.key}
                              {item.sendable ? "" : ` (${item.status} · 발송 불가)`}
                            </option>
                          ))}
                        </select>
                        {value && option && !option.sendable ? (
                          // 발행되지 않은 문서를 고르면 발송 시점에 대기로 빠진다 — 그 사실을 지금 말한다.
                          <span className="shrink-0 text-[11px] text-danger">미발행</span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="nudge-sequence-save"
            onClick={() => void handleSave()}
            disabled={saving}
            className="min-h-10 rounded-md border border-line bg-paper px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-fill disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "저장 중…" : "매핑 저장"}
          </button>
          {message ? (
            <span className={`text-xs ${failed ? "text-danger" : "text-ink-3"}`}>{message}</span>
          ) : null}
        </div>

        {envelope ? <ProgramOverrideSection envelope={envelope} onSaved={load} /> : null}
      </div>
    </Card>
  );
}
