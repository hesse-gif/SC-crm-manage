"use client";

// W91 [헤세 · 크리에이터 탭] — Portal(scp-creator-portal) admin/creators 화면의 액션을 장기적으로
// Flu 로 가져오는 작업.
//
// ■ P0 → P1/P2 로 확장
//   P0 는 Flu 가 이미 가진 데이터만으로 읽기 전용 테이블을 만들고, 실행은 전부 Portal 딥링크로
//   보냈다. P1/P2 는 admin-bridge 콜러블(listScpPortalCreators/scpPortalCreatorCommand)로 Portal
//   의 실계정을 조회하고, 지원서 승인/반려·상태 변경·Flu 매핑 편집을 Flu 화면에서 직접 수행한다.
//   포털 레포·포털 API 는 여전히 건드리지 않는다 — 클라이언트는 콜러블만 호출한다
//   (NET-P0-012 — 외부 IP 직접 호출 금지).
//
// ■ 두 모드
//   브리지가 구성돼 있으면(`configured:true`) 포털 실계정 테이블을 보여주고 이 화면에서 액션을
//   수행한다. 미구성이면(`configured:false`) 기존 P0 읽기 전용 디렉터리로 폴백하고 안내 배지를
//   보여준다 — 삭제·섀도 로그인 버튼은 어느 모드에도 없다(포털 전용 기능).
//
// ■ W93 개편(사용자 피드백): "액션 중심·핸들명·컬럼 최소화". 두 뷰 모두 크리에이터 칼럼을
//   UUID/applicationId 가 아니라 이름/핸들 우선으로 보여주고(채널 URL 있으면 그 링크로 감싼다),
//   승인/반려가 잘 보이도록 상태·프로그램/캠페인·Flu 매핑 칼럼을 걷어냈다(포털 뷰의 지원서 상태는
//   칼럼이 아니라 액션 버튼 노출 판단 + 완료된 행의 작은 배지 하나로만 남는다). 필터 토글도
//   제거하고 정렬만 유지한다(결정 대기 우선).
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { formatKst } from "@/lib/datetime";
import {
  listScpCreatorDirectory,
  listScpPortalCreators,
  scpPortalCreatorCommand,
  type ListScpPortalCreatorsResult,
  type ScpCreatorDirectoryEnvelope,
  type ScpCreatorDirectoryRow,
  type ScpPortalCreatorRow,
} from "@/lib/data";
import { publicCallableErrorMessage, requestDataKeys, useLivePrograms } from "@/lib/live";
import type { Program } from "@/modules/programs";
import { scpPortalAdminCreatorsHref } from "@/lib/scpPortalLinks";

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "요청을 처리하지 못했습니다.";
}

/** 긴 raw id(UUID/applicationId)를 그대로 노출하지 않고 축약한다 — 이름/핸들이 전혀 없을 때만 쓴다. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/** `.../@handle` 형태의 유튜브 채널 URL에서 @handle 만 뽑는다 — 채널 UC-ID 류 URL 은 null. */
function extractYoutubeHandle(channelUrl: string | undefined): string | null {
  if (!channelUrl) return null;
  const match = /youtube\.com\/@([^/?#]+)/i.exec(channelUrl);
  if (!match) return null;
  try {
    return `@${decodeURIComponent(match[1])}`;
  } catch {
    return `@${match[1]}`;
  }
}

/** 자가신고(declaredIdentity) 핸들은 "@x"/"x"/URL 셋 다 들어온다 — @핸들로 정규화, 못 읽으면 null. */
function declaredHandleText(declared: { handle?: string | null; channelUrl?: string | null } | null | undefined): string | null {
  if (!declared) return null;
  const raw = (declared.handle ?? "").trim();
  if (raw) {
    const fromUrl = extractYoutubeHandle(raw);
    if (fromUrl) return fromUrl;
    if (!/[\s/:?#]/.test(raw)) return raw.startsWith("@") ? raw : `@${raw}`;
  }
  return extractYoutubeHandle(declared.channelUrl ?? undefined);
}

// 2026-09-18 [헤세 · 검수 인박스 딥링크] — 인박스 신청자 행은
// `/flu/scp?tab=creators&applicationId=<id>` 로 이 디렉터리의 특정 지원서를 가리킨다.
// `applicationId` 는 review-route 가 예약한 레거시 딥링크 키라 탭 전환 시 자동으로 지워진다.
function useFocusedApplicationId(): string {
  return (useSearchParams().get("applicationId") ?? "").trim();
}

// management 문서 id 규칙 — functions/applicationManagementStore.ts 의 storeDocId 와 동일
// ([^A-Za-z0-9_-] → "_", 최대 180자). 인박스 딥링크의 applicationId 는 sanitize 된
// management doc id 인데 포털 행의 approvalApplicationId 는 원본 포털 id 라, `.`/`:` 같은
// charset-unsafe 문자가 들어간 지원서는 원본끼리 비교하면 절대 매칭되지 않는다 — 비교는
// 반드시 management id 공간으로 정규화한 값끼리 한다(이미 sanitize 된 값엔 무변경·멱등).
function toManagementDocId(applicationId: string): string {
  return applicationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
}

/** 포커스된 행을 뷰 중앙으로 스크롤한다 — 행 ref 로만 달아 마운트 시 1회 동작. */
function useFocusRowRef() {
  return useCallback((node: HTMLTableRowElement | null) => {
    node?.scrollIntoView({ block: "center" });
  }, []);
}

/** firebase functions client SDK 의 HttpsError.details.errorCode — 포털 커맨드 거부 사유 구분용. */
function bridgeErrorCode(error: unknown): string {
  const details = (error as { details?: unknown } | null | undefined)?.details;
  const code = details && typeof details === "object" ? (details as { errorCode?: unknown }).errorCode : undefined;
  return typeof code === "string" ? code : "";
}

const STALE_REVISION_MESSAGE = "다른 곳에서 먼저 변경됐습니다 — 새로고침 후 다시 시도해 주세요.";

function bridgeActionErrorMessage(error: unknown): string {
  const code = bridgeErrorCode(error);
  if (code === "stale_revision") return STALE_REVISION_MESSAGE;
  if (code === "flu_creator_mapping_conflict") return "이미 다른 크리에이터에 연결된 매핑입니다.";
  return publicCallableErrorMessage(error, errorText(error));
}

// ---- P0 폴백 뷰 --------------------------------------------------------------------------

/** ① 결정 대기(Manage inbox) 우선 ② Flu 매핑 미연결 우선 ③ 제출일 내림차순. */
function sortFallbackRows(rows: readonly ScpCreatorDirectoryRow[]): ScpCreatorDirectoryRow[] {
  return [...rows].sort((a, b) => {
    if (a.manageInboxPending !== b.manageInboxPending) return a.manageInboxPending ? -1 : 1;
    if (a.binding.linked !== b.binding.linked) return a.binding.linked ? 1 : -1;
    const bAt = b.submittedAtIso ? Date.parse(b.submittedAtIso) : 0;
    const aAt = a.submittedAtIso ? Date.parse(a.submittedAtIso) : 0;
    return (Number.isFinite(bAt) ? bAt : 0) - (Number.isFinite(aAt) ? aAt : 0);
  });
}

/** 핸들/표시명 → 지원서 자가신고(declaredIdentity) → applicationId 축약 순 — raw applicationId 를 그대로 보여주지 않는다. */
function fallbackCreatorLabel(row: ScpCreatorDirectoryRow): { label: string; handle: string | null } {
  const declaredHandle = declaredHandleText(row.declaredIdentity);
  const declaredName = (row.declaredIdentity?.name ?? "").trim();
  const declaredChannelUrl = (row.declaredIdentity?.channelUrl ?? "").trim();
  const label = row.creatorDisplayName
    || row.creatorHandle
    || declaredHandle
    || declaredName
    || declaredChannelUrl
    || shortId(row.applicationId);
  const handle = row.creatorHandle || declaredHandle;
  return { label, handle: handle && handle !== label ? handle : null };
}

function FallbackDirectoryView() {
  const focusApplicationId = useFocusedApplicationId();
  // 행 매칭은 management doc id 공간에서 — 이 뷰의 row.applicationId 자체가 storeDocId 값이다.
  const focusManagementId = toManagementDocId(focusApplicationId);
  const focusRowRef = useFocusRowRef();
  const [envelope, setEnvelope] = useState<ScpCreatorDirectoryEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    listScpCreatorDirectory({ limit: 100 })
      .then((result) => {
        if (!cancelled) setEnvelope(result);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => sortFallbackRows(envelope?.rows ?? []), [envelope]);
  // 딥링크로 지정된 지원서가 첫 페이지에 없으면 조용히 실패하지 않고 안내 + 포털 링크를 띄운다.
  const focusMiss = focusManagementId.length > 0
    && !loading
    && !loadError
    && !rows.some((row) => row.applicationId === focusManagementId);

  if (loading && !envelope) {
    return <LoadingStatus className="justify-center border-y border-line py-8">크리에이터 목록을 불러오는 중</LoadingStatus>;
  }
  if (loadError) {
    return (
      <div data-testid="scp-creator-directory-error" className="rounded-lg border border-line bg-paper p-4 text-sm text-ink-2">
        목록을 불러오지 못했습니다: {loadError}
      </div>
    );
  }

  return (
    <div data-testid="scp-creator-directory-fallback" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-paper p-4">
        <Badge tone="warn">브리지 미구성 — 읽기 전용</Badge>
        <p className="text-xs text-ink-3">
          실행은 액션 칸의 포털 링크에서 처리하세요.{envelope?.truncated ? " (일부 생략됨)" : ""}
        </p>
      </div>

      {focusMiss ? (
        <div data-testid="scp-creator-directory-focus-miss" className="rounded-lg border border-line bg-paper p-4 text-xs text-ink-2">
          인박스에서 연 지원서(<span className="font-mono">{shortId(focusApplicationId)}</span>)를 이 목록에서 찾지 못했습니다.{" "}
          <a
            href={scpPortalAdminCreatorsHref({ applicationId: focusApplicationId })}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-ink underline"
          >
            포털 지원서 탭에서 열기
          </a>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-paper p-6 text-center text-sm text-ink-2">
          해당하는 크리에이터가 없습니다.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full min-w-[520px] text-left text-xs" data-testid="scp-creator-directory-table">
            <thead className="border-b border-line text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">크리에이터</th>
                <th scope="col" className="px-3 py-2 font-semibold">제출일</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">액션</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const { label, handle } = fallbackCreatorLabel(row);
                const focused = focusManagementId.length > 0 && row.applicationId === focusManagementId;
                return (
                  <tr
                    key={row.applicationId}
                    ref={focused ? focusRowRef : undefined}
                    data-testid="scp-creator-directory-row"
                    className={`border-b border-line last:border-b-0 align-top${focused ? " bg-fill/60" : ""}`}
                  >
                    <td className="px-3 py-2">
                      <span className="block max-w-[240px] truncate font-semibold text-ink">{label}</span>
                      {handle ? <span className="mt-0.5 block text-[11px] text-ink-3">{handle}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-ink-2">{formatKst(row.submittedAtIso)}</td>
                    <td className="px-3 py-2 text-right">
                      <a
                        href={scpPortalAdminCreatorsHref({ applicationId: row.applicationId })}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-9 items-center rounded-md border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-fill"
                      >
                        포털에서 열기
                      </a>
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

// ---- P1/P2 포털 실계정 뷰 ------------------------------------------------------------------

const PORTAL_STATUS_TONE: Record<string, Tone> = {
  approved: "ok",
  active: "ok",
  submitted: "info",
  in_review: "info",
  under_review: "info",
  rejected: "danger",
  suspended: "danger",
  pending: "warn",
};

// W91 정정(HIGH-②): 포털 AdminCreatorsPage 와 같은 조건 — 지원서가 이미 종결(approved/rejected)
// 되면 승인/반려 버튼을 다시 보여주지 않는다.
const TERMINAL_APPLICATION_STATUSES: ReadonlySet<string> = new Set(["approved", "rejected"]);

function portalStatusLabel(row: ScpPortalCreatorRow): string {
  return row.approvalApplication ? row.approvalApplication.status : row.status;
}

function PortalStatusBadge({ row }: { row: ScpPortalCreatorRow }) {
  const status = portalStatusLabel(row);
  const tone = PORTAL_STATUS_TONE[status] ?? "neutral";
  return <Badge tone={tone}>{status || "미지정"}</Badge>;
}

/** 이름 → 표시명 → 채널 핸들 → 축약 id 순 — UUID/applicationId 를 그대로 보여주지 않는다. */
function portalCreatorLabel(row: ScpPortalCreatorRow): { label: string; handle: string | null } {
  const handle = extractYoutubeHandle(row.profile.channelUrl);
  const label = row.name || row.profile.displayName || handle || shortId(row.id);
  return { label, handle: handle && handle !== label ? handle : null };
}

type ProgramEnrollmentStatus = "invited" | "active" | "paused" | "ended";

const ENROLLMENT_STATUS_OPTIONS: readonly ProgramEnrollmentStatus[] = ["invited", "active", "paused", "ended"];

// 포털 정본 스키마(scp.flu.admin-bridge.v1 creator.data-link): programEnrollments 는 풀 객체
// 배열이다 — programId 목록만으로는 부족하다. id/programId/guideReleaseId/policyVersion 은 전부
// 안정 식별자(`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`)이고, guideReleaseId/policyVersion 은
// 포털 super admin 이 관리하는 값이라 Flu 가 지어내면 안 된다 — 운영자가 포털 화면에서 확인한
// 값을 그대로 입력해야 한다(헬프텍스트로 안내).
//
// W91 정정(적대적 리뷰 CRITICAL): 포털 creator.data-link 는 **full-replace** 다(포털
// updateCreatorDataLink 확인 완료 — 제출한 programEnrollments 배열이 기존 배열 전체를 대체한다,
// append 가 아니다). 이 디렉터리 행(ScpPortalCreatorRow.dataLink)은 enrollmentCount 숫자만 갖고
// 있고 실제 기존 배열 내용을 모른다 — 그래서 이 에디터는 **이미 참여가 있는 크리에이터
// (enrollmentCount > 0)에는 절대 열리지 않는다**(아래 테이블 렌더에서 미연결 행에만 "매핑 편집"
// 버튼을 보여준다 — 연결된 행은 "포털에서 편집" 안내로 대체). 이 에디터가 실제로 여는 유스케이스는
// **신규 연결**(아직 참여가 하나도 없는 크리에이터에 처음 매핑을 붙이는 것)뿐이다 — 그래서 기존
// 배열을 미리 채워 보여줄 필요가 없다(빈 배열이 시작점이라도 안전하다). 기존 배열을 조회해 편집
// 화면에 미리 채우는 것은 포털 쪽에 조회 API 가 추가된 뒤의 후속 작업으로 미룬다.
type ProgramEnrollmentFormRow = {
  id: string;
  programId: string;
  guideReleaseId: string;
  policyVersion: string;
  status: ProgramEnrollmentStatus;
  validFrom: string;
  validTo: string;
  isDefault: boolean;
};

type MappingFormState = {
  fluCreatorId: string;
  partnerId: string;
  enrollments: ProgramEnrollmentFormRow[];
};

/** `enr_` + 16 lowercase-hex — matches the pinned stable-identifier pattern. */
function generateEnrollmentId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return `enr_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function newEnrollmentRow(isDefault: boolean): ProgramEnrollmentFormRow {
  return {
    id: generateEnrollmentId(),
    programId: "",
    guideReleaseId: "",
    policyVersion: "",
    status: "active",
    validFrom: new Date().toISOString(),
    validTo: "",
    isDefault,
  };
}

function MappingEditor({
  row,
  onCancel,
  onSaved,
}: {
  row: ScpPortalCreatorRow;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<MappingFormState>({
    fluCreatorId: row.dataLink.fluCreatorId ?? "",
    partnerId: row.dataLink.partnerId ?? "",
    enrollments: [newEnrollmentRow(true)],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const programs = useLivePrograms<Program>([]);

  useEffect(() => {
    requestDataKeys(["programs"], true);
  }, []);

  const updateEnrollment = (id: string, patch: Partial<ProgramEnrollmentFormRow>) => {
    setForm((prev) => ({
      ...prev,
      enrollments: prev.enrollments.map((enrollment) => (enrollment.id === id ? { ...enrollment, ...patch } : enrollment)),
    }));
  };

  // isDefault 는 active 중 최대 1개(포털 규칙) — 하나를 고르면 나머지는 자동으로 해제한다.
  const setDefaultEnrollment = (id: string) => {
    setForm((prev) => ({
      ...prev,
      enrollments: prev.enrollments.map((enrollment) => ({ ...enrollment, isDefault: enrollment.id === id })),
    }));
  };

  const addEnrollment = () => {
    setForm((prev) => ({ ...prev, enrollments: [...prev.enrollments, newEnrollmentRow(prev.enrollments.length === 0)] }));
  };

  const removeEnrollment = (id: string) => {
    setForm((prev) => ({ ...prev, enrollments: prev.enrollments.filter((enrollment) => enrollment.id !== id) }));
  };

  const save = async () => {
    if (form.enrollments.length === 0) {
      setError("참여 프로그램을 1개 이상 추가하세요.");
      return;
    }
    for (const enrollment of form.enrollments) {
      if (!enrollment.programId || !enrollment.guideReleaseId.trim() || !enrollment.policyVersion.trim()) {
        setError("모든 참여 항목의 프로그램 · Guide Release ID · Policy Version 을 입력하세요.");
        return;
      }
    }
    const activeDefaultCount = form.enrollments.filter((enrollment) => enrollment.status === "active" && enrollment.isDefault).length;
    if (activeDefaultCount > 1) {
      setError("기본(isDefault) 참여는 active 상태 중 1개만 지정할 수 있습니다.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await scpPortalCreatorCommand({
        command: "creator.data-link",
        targetId: row.id,
        expectedUpdatedAt: row.updatedAt,
        params: {
          fluCreatorId: form.fluCreatorId.trim(),
          partnerId: form.partnerId.trim(),
          programEnrollments: form.enrollments.map((enrollment) => ({
            id: enrollment.id,
            programId: enrollment.programId,
            guideReleaseId: enrollment.guideReleaseId.trim(),
            policyVersion: enrollment.policyVersion.trim(),
            status: enrollment.status,
            validFrom: enrollment.validFrom,
            ...(enrollment.validTo ? { validTo: enrollment.validTo } : {}),
            ...(enrollment.isDefault ? { isDefault: true as const } : {}),
          })),
        },
      });
      await onSaved();
    } catch (submitError) {
      const code = bridgeErrorCode(submitError);
      if (code === "stale_revision") {
        setError(STALE_REVISION_MESSAGE);
        await onSaved();
        return;
      }
      setError(bridgeActionErrorMessage(submitError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid={`scp-portal-mapping-editor-${row.id}`}
      className="mt-2 space-y-3 rounded-md border border-line bg-fill/40 p-3"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-ink-2">
          Flu Creator ID
          <input
            type="text"
            value={form.fluCreatorId}
            onChange={(e) => setForm((prev) => ({ ...prev, fluCreatorId: e.target.value }))}
            className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5 text-xs"
            placeholder="creator-..."
          />
        </label>
        <label className="text-xs text-ink-2">
          Partner ID
          <input
            type="text"
            value={form.partnerId}
            onChange={(e) => setForm((prev) => ({ ...prev, partnerId: e.target.value }))}
            className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5 text-xs"
            placeholder="partner-..."
          />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-2">참여 프로그램(1개 이상)</span>
          <Button size="sm" variant="ghost" type="button" onClick={addEnrollment}>
            + 참여 추가
          </Button>
        </div>
        {programs.length === 0 ? (
          <p className="text-[11px] text-ink-3">프로그램 목록을 불러오는 중…</p>
        ) : null}
        <div className="space-y-2">
          {form.enrollments.map((enrollment) => (
            <div key={enrollment.id} className="space-y-2 rounded border border-line bg-paper p-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-[11px] text-ink-2">
                  프로그램
                  <select
                    value={enrollment.programId}
                    onChange={(e) => updateEnrollment(enrollment.id, { programId: e.target.value })}
                    className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5 text-xs"
                  >
                    <option value="">선택</option>
                    {programs.map((program) => (
                      <option key={program.id} value={program.id}>
                        {program.title || program.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[11px] text-ink-2">
                  상태
                  <select
                    value={enrollment.status}
                    onChange={(e) => updateEnrollment(enrollment.id, { status: e.target.value as ProgramEnrollmentStatus })}
                    className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5 text-xs"
                  >
                    {ENROLLMENT_STATUS_OPTIONS.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-[11px] text-ink-2">
                  Guide Release ID
                  <input
                    type="text"
                    value={enrollment.guideReleaseId}
                    onChange={(e) => updateEnrollment(enrollment.id, { guideReleaseId: e.target.value })}
                    className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5 text-xs"
                    placeholder="포털 admin 화면의 값을 그대로 입력"
                  />
                </label>
                <label className="text-[11px] text-ink-2">
                  Policy Version
                  <input
                    type="text"
                    value={enrollment.policyVersion}
                    onChange={(e) => updateEnrollment(enrollment.id, { policyVersion: e.target.value })}
                    className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5 text-xs"
                    placeholder="포털 admin 화면의 값을 그대로 입력"
                  />
                </label>
              </div>
              <p className="text-[10px] text-ink-3">
                Guide Release ID · Policy Version 은 포털 super admin 이 관리하는 값입니다 — Flu 가
                임의로 지어내지 않습니다. 반드시 포털 admin 화면에서 확인한 정확한 값을 입력하세요.
              </p>
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
                  <input
                    type="checkbox"
                    checked={enrollment.isDefault}
                    onChange={() => setDefaultEnrollment(enrollment.id)}
                  />
                  기본 참여로 지정
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  disabled={form.enrollments.length <= 1}
                  onClick={() => removeEnrollment(enrollment.id)}
                >
                  제거
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          취소
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? "저장 중…" : "매핑 저장"}
        </Button>
      </div>
    </div>
  );
}

type PortalActionKind = "approve-application" | "reject-application" | "approve-status" | "reject-status";

// 반려 사유 3종(헤세 확정, 26-08-27). 앞 2개는 사유별 반려 안내 메일이 자동 발송되고,
// "기타"는 종전 not_eligible 그대로 메일 없이 반려만 된다. reasonCode 는 포털이 패턴
// (snake_case)만 검증하고 버리므로, 메일 트리거·감사 기록은 flu 서버가 정확 일치로 처리한다.
const REJECT_REASON_OPTIONS: readonly { code: string; label: string; sendsMail: boolean }[] = [
  { code: "subscriber_below_minimum", label: "구독자 100명 미만", sendsMail: true },
  { code: "channel_not_found", label: "채널 확인 불가", sendsMail: true },
  { code: "not_eligible", label: "기타 (메일 없음)", sendsMail: false },
];

// 116차 디렉터리 보강(channelStats)의 구독자 수 — 보강 실패 행엔 없다(fail-open). 반려 시점
// 값은 구독자 미달 사유의 판단 근거로 서버에 올라가 outbox 행에 남는다.
function rowSubscriberCount(row: ScpPortalCreatorRow): number | undefined {
  const value = Number(row.channelStats?.subscriberCount);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// 포털 뷰 행의 지원서 id — approvalApplicationId(브리지 요약)가 없으면 approvalApplication.id.
// **원본 포털 id** 다 — management 문서는 이 값을 storeDocId 로 sanitize 해 doc id 로 쓰므로
// 인박스 딥링크의 applicationId 와 비교할 때는 반드시 toManagementDocId 를 거쳐야 한다.
function portalApplicationIdFor(row: ScpPortalCreatorRow): string {
  return (row.approvalApplicationId || row.approvalApplication?.id || "").trim();
}

function PortalDirectoryView({
  initial,
  onUnconfigured,
}: {
  initial: ListScpPortalCreatorsResult & { configured: true };
  onUnconfigured: () => void;
}) {
  const focusApplicationId = useFocusedApplicationId();
  // 딥링크의 applicationId 는 sanitize 된 management doc id — 포털 원본 id 와 비교하려면
  // 같은 id 공간으로 정규화해야 한다(charset-unsafe 한 포털 id 도 포커스되게).
  const focusManagementId = toManagementDocId(focusApplicationId);
  const focusRowRef = useFocusRowRef();
  const [rows, setRows] = useState<ScpPortalCreatorRow[]>(initial.rows);
  const [generatedAtIso, setGeneratedAtIso] = useState(initial.generatedAtIso);
  const [reloading, setReloading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  // 헤세 요청(26-08-27): 체크박스 다중 선택 승인 + 대기 전원 승인.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setReloading(true);
    setLoadError("");
    try {
      const result = await listScpPortalCreators({ limit: 100 });
      if (!result.configured) {
        onUnconfigured();
        return;
      }
      setRows(result.rows);
      setGeneratedAtIso(result.generatedAtIso);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setReloading(false);
    }
  }, [onUnconfigured]);

  // 승인 시퀀스(검토시작→승인)를 단건 함수로 분리 — 단건 버튼과 벌크 루프가 같은 경로를 탄다.
  const approveApplicationOnce = useCallback(async (row: ScpPortalCreatorRow) => {
    const application = row.approvalApplication;
    if (!application) throw new Error("지원서 정보가 없습니다.");
    let expectedRevision = application.revision;
    if (application.status === "submitted") {
      const started = await scpPortalCreatorCommand({
        command: "application.start-review",
        targetId: application.id,
        expectedRevision,
      });
      const startedApprovalApplication = (started.result as Record<string, unknown> | undefined)?.approvalApplication as
        | Record<string, unknown>
        | undefined;
      const nextRevision = Number(startedApprovalApplication?.revision);
      expectedRevision = Number.isFinite(nextRevision) ? nextRevision : expectedRevision + 1;
    }
    await scpPortalCreatorCommand({
      command: "application.approve",
      targetId: application.id,
      expectedRevision,
    });
  }, []);

  // 벌크 승인: 순차 실행(브릿지 CAS 계약 — 병렬이면 revision 경합·포털 부하). 개별 실패는 행
  // 에러로 남기고 다음으로 진행하며, reload 는 마지막에 1회만 한다.
  const runBulkApprove = useCallback(async (targets: ScpPortalCreatorRow[]) => {
    if (!targets.length || bulkProgress) return;
    setBulkProgress({ done: 0, total: targets.length });
    setRowErrors({});
    let done = 0;
    for (const row of targets) {
      try {
        await approveApplicationOnce(row);
      } catch (error) {
        setRowErrors((prev) => ({ ...prev, [row.id]: bridgeActionErrorMessage(error) }));
      }
      done += 1;
      setBulkProgress({ done, total: targets.length });
    }
    setSelectedIds(new Set());
    setBulkProgress(null);
    await reload();
  }, [approveApplicationOnce, bulkProgress, reload]);

  const runAction = useCallback(
    async (kind: PortalActionKind, row: ScpPortalCreatorRow, rejectReasonCode?: string) => {
      setBusyRowId(row.id);
      setRowErrors((prev) => ({ ...prev, [row.id]: "" }));
      try {
        if (kind === "approve-application" || kind === "reject-application") {
          const application = row.approvalApplication;
          if (!application) throw new Error("지원서 정보가 없습니다.");
          if (kind === "approve-application") {
            await scpPortalCreatorCommand({
              command: "application.approve",
              targetId: application.id,
              expectedRevision: application.revision,
            });
          } else {
            let expectedRevision = application.revision;
            // 포털 AdminCreatorsPage 의 commandApplication 시퀀스와 동일: submitted 상태는
            // 먼저 검토 시작을 거쳐야 반려 커맨드가 통과한다.
            if (application.status === "submitted") {
              const started = await scpPortalCreatorCommand({
                command: "application.start-review",
                targetId: application.id,
                expectedRevision,
              });
              // result is a CREATOR row projection (not an application projection) — the updated
              // application revision lives at result.approvalApplication.revision, not result.revision.
              const startedApprovalApplication = (started.result as Record<string, unknown> | undefined)?.approvalApplication as
                | Record<string, unknown>
                | undefined;
              const nextRevision = Number(startedApprovalApplication?.revision);
              expectedRevision = Number.isFinite(nextRevision) ? nextRevision : expectedRevision + 1;
            }
            const subscriberCount = rowSubscriberCount(row);
            await scpPortalCreatorCommand({
              command: "application.reject",
              targetId: application.id,
              expectedRevision,
              params: {
                reasonCode: rejectReasonCode ?? "not_eligible",
                // 반려 시점 판단 근거(구독자 미달 사유의 감사 증거). 포털 바디로는 나가지 않고
                // flu 서버가 outbox 행에만 보관한다.
                ...(subscriberCount !== undefined ? { subscriberCount } : {}),
              },
            });
          }
        } else {
          await scpPortalCreatorCommand({
            command: "creator.set-status",
            targetId: row.id,
            expectedUpdatedAt: row.updatedAt,
            params: { status: kind === "approve-status" ? "approved" : "rejected" },
          });
        }
        await reload();
      } catch (error) {
        const code = bridgeErrorCode(error);
        setRowErrors((prev) => ({ ...prev, [row.id]: bridgeActionErrorMessage(error) }));
        if (code === "stale_revision") await reload();
      } finally {
        setBusyRowId(null);
      }
    },
    [reload],
  );

  // 딥링크로 지정된 지원서가 첫 페이지에 없으면 조용히 실패하지 않고 안내 + 포털 링크를 띄운다.
  const focusMiss = focusManagementId.length > 0
    && !reloading
    && !loadError
    && !rows.some((row) => toManagementDocId(portalApplicationIdFor(row)) === focusManagementId);

  return (
    <div data-testid="scp-portal-creator-table" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-paper p-4">
        <p className="text-xs text-ink-3">
          Portal 실계정을 직접 조회·조작합니다. 승인·반려·상태 변경·Flu 매핑 편집은 이 화면에서
          바로 처리되고 Portal 에 즉시 반영됩니다. 조회 시각 {formatKst(generatedAtIso)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {(() => {
            const approvable = rows.filter(
              (row) => row.approvalApplication && !TERMINAL_APPLICATION_STATUSES.has(row.approvalApplication.status),
            );
            const selected = approvable.filter((row) => selectedIds.has(row.id));
            return (
              <>
                {bulkProgress ? (
                  <span className="text-xs font-semibold text-ink-2">승인 중 {bulkProgress.done}/{bulkProgress.total}…</span>
                ) : null}
                <Button
                  size="sm"
                  disabled={Boolean(bulkProgress) || selected.length === 0}
                  onClick={() => void runBulkApprove(selected)}
                  data-testid="scp-bulk-approve-selected"
                >
                  선택 승인{selected.length ? ` (${selected.length})` : ""}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={Boolean(bulkProgress) || approvable.length === 0}
                  onClick={() => {
                    // 실수 방지: 대기 전원 승인은 브라우저 확인 한 번을 거친다.
                    if (window.confirm(`대기 중인 지원서 ${approvable.length}건을 전부 승인합니다. 진행할까요?`)) {
                      void runBulkApprove(approvable);
                    }
                  }}
                  data-testid="scp-bulk-approve-all"
                >
                  대기 전원 승인{approvable.length ? ` (${approvable.length})` : ""}
                </Button>
              </>
            );
          })()}
          <Button size="sm" variant="secondary" disabled={reloading} onClick={() => void reload()}>
            {reloading ? "새로고침 중…" : "새로고침"}
          </Button>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-line bg-paper p-4 text-sm text-danger">{loadError}</div>
      ) : null}

      {focusMiss ? (
        <div data-testid="scp-portal-creator-focus-miss" className="rounded-lg border border-line bg-paper p-4 text-xs text-ink-2">
          인박스에서 연 지원서(<span className="font-mono">{shortId(focusApplicationId)}</span>)를 이 목록에서 찾지 못했습니다.{" "}
          <a
            href={scpPortalAdminCreatorsHref({ applicationId: focusApplicationId })}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-ink underline"
          >
            포털 지원서 탭에서 열기
          </a>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-paper p-6 text-center text-sm text-ink-2">
          해당하는 크리에이터가 없습니다.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full min-w-[640px] text-left text-xs" data-testid="scp-portal-creator-table-inner">
            <thead className="border-b border-line text-ink-3">
              <tr>
                <th scope="col" className="w-8 px-3 py-2">
                  {(() => {
                    const approvable = rows.filter(
                      (row) => row.approvalApplication && !TERMINAL_APPLICATION_STATUSES.has(row.approvalApplication.status),
                    );
                    const allSelected = approvable.length > 0 && approvable.every((row) => selectedIds.has(row.id));
                    return (
                      <input
                        type="checkbox"
                        aria-label="대기 전원 선택"
                        checked={allSelected}
                        disabled={approvable.length === 0 || Boolean(bulkProgress)}
                        onChange={() => setSelectedIds(allSelected ? new Set() : new Set(approvable.map((row) => row.id)))}
                      />
                    );
                  })()}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">크리에이터</th>
                <th scope="col" className="px-3 py-2 font-semibold">이메일</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">구독자</th>
                <th scope="col" className="px-3 py-2 font-semibold">가입일</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">액션</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = busyRowId === row.id;
                const rowError = rowErrors[row.id];
                const { label, handle } = portalCreatorLabel(row);
                const creatorNode = row.profile.channelUrl ? (
                  <a
                    href={row.profile.channelUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block max-w-[220px] truncate font-semibold text-ink hover:underline"
                  >
                    {label}
                  </a>
                ) : (
                  <span className="block max-w-[220px] truncate font-semibold text-ink">{label}</span>
                );
                const focused = focusManagementId.length > 0
                  && toManagementDocId(portalApplicationIdFor(row)) === focusManagementId;
                return (
                  <Fragment key={row.id}>
                    <tr
                      ref={focused ? focusRowRef : undefined}
                      data-testid="scp-portal-creator-row"
                      className={`border-b border-line last:border-b-0 align-top${focused ? " bg-fill/60" : ""}`}
                    >
                      <td className="px-3 py-2">
                        {row.approvalApplication && !TERMINAL_APPLICATION_STATUSES.has(row.approvalApplication.status) ? (
                          <input
                            type="checkbox"
                            aria-label={`${label} 선택`}
                            checked={selectedIds.has(row.id)}
                            disabled={Boolean(bulkProgress)}
                            onChange={() =>
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                                return next;
                              })
                            }
                          />
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {creatorNode}
                        {handle ? <span className="mt-0.5 block text-[11px] text-ink-3">{handle}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-ink-2">{row.emailMasked}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-2">
                        {typeof row.channelStats?.subscriberCount === "number"
                          ? row.channelStats.subscriberCount.toLocaleString("en-US")
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-ink-2">{formatKst(row.createdAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {row.approvalApplication ? (
                            // W91 정정(HIGH-②): 포털 AdminCreatorsPage 와 같은 조건 — 지원서가 이미
                            // approved/rejected 로 종결됐으면 승인/반려 버튼을 다시 보여주지 않는다.
                            // W93: 상태 칼럼을 걷어낸 대신, 버튼이 사라지는 이 자리에 작은 배지로
                            // 종결 상태를 남긴다(행 배지 하나로만 상태를 쓴다).
                            !TERMINAL_APPLICATION_STATUSES.has(row.approvalApplication.status) ? (
                              rejectingId === row.id ? (
                                // 반려 사유 선택 — 앞 2개는 사유별 반려 안내 메일이 자동 발송된다.
                                <>
                                  {REJECT_REASON_OPTIONS.map((option) => {
                                    const subscriberCount = rowSubscriberCount(row);
                                    const label =
                                      option.code === "subscriber_below_minimum" && subscriberCount !== undefined
                                        ? `${option.label} (현재 ${subscriberCount.toLocaleString()}명)`
                                        : option.label;
                                    return (
                                      <Button
                                        key={option.code}
                                        size="sm"
                                        variant="secondary"
                                        disabled={busy}
                                        data-testid={`scp-portal-reject-reason-${option.code}-${row.id}`}
                                        title={
                                          option.sendsMail
                                            ? "이 사유로 반려하면 크리에이터에게 반려 안내 메일이 자동 발송됩니다."
                                            : "메일 발송 없이 반려만 합니다."
                                        }
                                        onClick={() => {
                                          setRejectingId(null);
                                          void runAction("reject-application", row, option.code);
                                        }}
                                      >
                                        {label}
                                      </Button>
                                    );
                                  })}
                                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejectingId(null)}>
                                    취소
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button
                                    size="sm"
                                    disabled={busy}
                                    data-testid={`scp-portal-approve-application-${row.id}`}
                                    onClick={() => void runAction("approve-application", row)}
                                  >
                                    승인
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy}
                                    data-testid={`scp-portal-reject-application-${row.id}`}
                                    onClick={() => setRejectingId(row.id)}
                                  >
                                    반려
                                  </Button>
                                </>
                              )
                            ) : (
                              <PortalStatusBadge row={row} />
                            )
                          ) : (
                            <>
                              <Button
                                size="sm"
                                disabled={busy}
                                data-testid={`scp-portal-approve-status-${row.id}`}
                                onClick={() => void runAction("approve-status", row)}
                              >
                                승인
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                data-testid={`scp-portal-reject-status-${row.id}`}
                                onClick={() => void runAction("reject-status", row)}
                              >
                                반려
                              </Button>
                            </>
                          )}
                          {row.dataLink.enrollmentCount > 0 ? (
                            // W91 정정(CRITICAL): 포털 creator.data-link 는 **full-replace** 다
                            // (updateCreatorDataLink 확인 — 제출한 programEnrollments 배열이 기존
                            // 배열을 통째로 교체한다). 이 디렉터리 행은 enrollmentCount 만 알고 기존
                            // 배열 내용을 볼 수 없으므로, 여기서 편집을 열면 운영자가 모르는 기존
                            // 참여 항목을 조용히 지울 수 있다 — 이미 연결된 행은 편집 버튼을 아예
                            // 숨기고 포털 딥링크로만 보낸다. 신규 연결(미연결 행)만 이 화면에서 만든다
                            // (그게 W91 의 실제 유스케이스다). 기존 배열을 읽어와 보여주는 것은
                            // 포털 후속 작업으로 미룬다.
                            <span
                              className="inline-flex min-h-8 items-center rounded-md border border-line bg-fill px-3 py-1 text-[11px] text-ink-3"
                              title="포털이 매핑을 통째로 교체하는 방식이라 기존 참여 항목을 Flu 화면에서 안전하게 편집할 수 없습니다 — 포털에서 편집하세요."
                            >
                              포털에서 편집
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setEditingId(editingId === row.id ? null : row.id)}
                            >
                              매핑 편집
                            </Button>
                          )}
                          <a
                            href={scpPortalAdminCreatorsHref({
                              applicationId: row.approvalApplicationId ?? row.approvalApplication?.id ?? null,
                            })}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-8 items-center rounded-md border border-line bg-paper px-3 py-1 text-xs font-semibold text-ink-2 transition-colors hover:bg-fill"
                          >
                            포털에서 열기
                          </a>
                        </div>
                        {rowError ? <p className="mt-1 text-right text-[11px] text-danger">{rowError}</p> : null}
                      </td>
                    </tr>
                    {editingId === row.id ? (
                      <tr className="border-b border-line last:border-b-0">
                        <td colSpan={6} className="px-3 pb-3">
                          <MappingEditor
                            row={row}
                            onCancel={() => setEditingId(null)}
                            onSaved={async () => {
                              setEditingId(null);
                              await reload();
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- 진입점 ---------------------------------------------------------------------------------

export function ScpCreatorDirectoryPanel() {
  const [bridge, setBridge] = useState<ListScpPortalCreatorsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    listScpPortalCreators({ limit: 100 })
      .then((result) => {
        if (!cancelled) setBridge(result);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && !bridge && !loadError) {
    return <LoadingStatus className="justify-center border-y border-line py-8">크리에이터 목록을 불러오는 중</LoadingStatus>;
  }
  if (loadError) {
    return (
      <div data-testid="scp-creator-directory-error" className="rounded-lg border border-line bg-paper p-4 text-sm text-ink-2">
        목록을 불러오지 못했습니다: {loadError}
      </div>
    );
  }
  if (bridge?.configured) {
    return (
      <PortalDirectoryView
        initial={bridge as ListScpPortalCreatorsResult & { configured: true }}
        onUnconfigured={() => setBridge({ configured: false, rows: [] })}
      />
    );
  }
  return <FallbackDirectoryView />;
}
