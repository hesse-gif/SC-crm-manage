"use client";

// SCP 자동화 · 메일 템플릿 탭 (W7-3a).
//
// 신축이 아니라 이설이다: 카드/미리보기/Publish 배선은 설정 화면의 ScpReceiptTemplatesSection 을
// 그대로 옮겨 왔다(dryRun 미리보기 → CAS Publish · iframe 안전 미리보기 · 변수 칩 동일).
// 달라진 것 두 가지뿐:
//   ① 편집 레인 노출 — application_confirmed · content_submitted ·
//      video_result_mail(문서 없으면 코드 fallback) + onboarding(제네릭 kind 상태 조망).
// W8-2(사용자 결정): uid_guide 편집 카드는 제거했다. 발송 쪽(resolveScpMailTemplateOverride
// ("uid_guide") · URL 스킴 사전 검증)은 그대로 살아 있고 운영에 문서가 0건이라 코드 기본 문안으로
// 계속 발송된다 — fail-closed 동작 무변경. 편집 표면만 없앤 것이다.
//   ② 저장 전 경고 2종(W7-3f)을 서버 응답(lints)에서 받아 그대로 표시.
//
// ⚠️ 편집 대상은 계속 기존 컬렉션 `scp_mail_templates/{kind}` 문서다(새 컬렉션 없음).
// ⚠️ 게이트(펜스/GA/분류기)는 구조화 메타만 보므로 템플릿 편집으로 발송 게이트가 바뀌지 않는다.
// ⚠️ onboarding 레인은 편집기를 복제하지 않는다 — 제네릭 kind 의 정본 편집 위치로 딥링크만 준다
//    (진실 단일화: 플로우 인벤토리와 같은 규칙).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  buildSafeMailPreviewDocument,
  listScpVideoReviewStates,
  upsertScpMailTemplate,
  type ScpEditableMailTemplateKind,
  type ScpMailTemplateEnvelope,
  type ScpVideoReviewTitleOption,
} from "@/lib/data";
import { callableErrorCode, publicCallableErrorMessage, requestDataRefresh, useLiveScpMailTemplates } from "@/lib/live";
import { mailTemplateKindLabel } from "@/lib/statusLabels";
import { ScpColdMailProgramCard } from "./ScpColdMailProgramCard";
import { NudgeSequenceMappingCard } from "./NudgeSequenceMappingCard";
import { buildReviewQueueHref } from "@/lib/review-route";
import { SCP_CANONICAL_PROGRAM_ID, resolveCanonicalProgramId } from "@/lib/program-canonical";
import { clientProgramTitles, type ClientProgramTitle } from "@/lib/programTitlesClient";
import {
  CONTENT_SUBMITTED_EMAIL_EN_HTML,
  SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML,
} from "../../../../functions/mailTemplatesGenerated";
import {
  SCP_APPLICATION_CONFIRMED_SUBJECT,
  SCP_CONTENT_SUBMITTED_RECEIPT_SUBJECT,
  SCP_CONTENT_SUBMITTED_RECEIPT_TEXT,
} from "../../../../functions/scpReceiptMailContracts";


const cachedTemplateTitleOptions = new Map<string, Promise<ScpVideoReviewTitleOption[]>>();
function fetchTemplateTitleOptionsOnce(programId: string): Promise<ScpVideoReviewTitleOption[]> {
  const cacheKey = resolveCanonicalProgramId(programId || SCP_CANONICAL_PROGRAM_ID);
  const cached = cachedTemplateTitleOptions.get(cacheKey);
  if (cached) return cached;
  const request = listScpVideoReviewStates({ limit: 1, programId: cacheKey })
    .then((envelope) => (envelope as { titleOptions?: ScpVideoReviewTitleOption[] }).titleOptions ?? [])
    .catch((error) => {
      cachedTemplateTitleOptions.delete(cacheKey);
      throw error;
    });
  cachedTemplateTitleOptions.set(cacheKey, request);
  return request;
}

function templateTitleOptionText(option: ScpVideoReviewTitleOption, key: keyof ScpVideoReviewTitleOption): string {
  const value = option[key];
  return typeof value === "string" ? value : "";
}

function mergeTemplateServerProgramTitleOptions(
  seedTitles: readonly ClientProgramTitle[],
  serverOptions: readonly ScpVideoReviewTitleOption[],
): readonly ClientProgramTitle[] {
  const byId = new Map(seedTitles.map((title) => [title.id, title]));
  return serverOptions.map((option) => {
    const seeded = byId.get(option.id);
    const merged: ClientProgramTitle = {
      id: option.id,
      name: option.name || seeded?.name || option.id,
      storeUrl: templateTitleOptionText(option, "storeUrl"),
      requiredHashtag: templateTitleOptionText(option, "requiredHashtag"),
      default: option.default === true,
    };
    if (typeof option.guidebookUrl === "string") merged.guidebookUrl = option.guidebookUrl;
    if (typeof option.driveFolderUrl === "string") (merged as ClientProgramTitle & { driveFolderUrl?: string }).driveFolderUrl = option.driveFolderUrl;
    return merged;
  });
}

type TemplateBodyFormat = "html" | "text";

type TemplateDraft = {
  subject: string;
  html: string;
  text: string;
  // R7: bodyFormat is sent to the server as an explicit field — the client no longer empties
  // `html` to signal "text only" (that used to destroy the operator's saved HTML on publish; see
  // draftHtmlPayload removal). The server (functions/scpMail.ts normalizeReceiptTemplate) decides
  // the send representation and preserves the authored draft separately (htmlDraft).
  bodyFormat: TemplateBodyFormat;
};

type TemplateDefinition = {
  kind: ScpEditableMailTemplateKind;
  title: string;
  lane: string;
  desc: string;
  vars: string[];
  required: string[];
  defaults: TemplateDraft;
  /** 발행 문서가 없을 때의 기본 형식. */
  defaultBodyFormat: TemplateBodyFormat;
};

// 허용 변수·필수 변수는 서버 계약(functions/scpReceiptMailTemplates.ts RECEIPT_TEMPLATE_RULES)과
// 같은 값이어야 한다 — 다르면 저장이 invalid-argument 로 떨어진다(테스트로 고정).
const TEMPLATE_DEFS: TemplateDefinition[] = [
  {
    kind: "application_confirmed",
    title: "신청 확인 메일",
    lane: "접수",
    desc: "Portal 신청 접수 직후 발송. 포털 링크를 포함해야 합니다. 기본 서식은 그대로 미리볼 수 있습니다.",
    vars: ["application_id", "program_name", "portal_link", "apply_link", "reference_code", "supercent_brand"],
    required: ["supercent_brand"],
    defaultBodyFormat: "html",
    defaults: {
      subject: SCP_APPLICATION_CONFIRMED_SUBJECT,
      html: SCP_APPLICATION_CONFIRMED_EMAIL_EN_HTML,
      text: [
        "Hello from Super Creator Partners,",
        "",
        "Your application is confirmed. You can start creating and submit your content through the SCP Creator Portal.",
        "",
        "We're excited to create with you.",
      ].join("\n"),
      bodyFormat: "html",
    },
  },
  {
    kind: "content_submitted",
    title: "콘텐츠 제출 확인 메일",
    lane: "제출",
    desc: "영상 제출(리비전) 접수 직후 발송. 문서가 없으면 브랜디드 정본 HTML 이 발송됩니다.",
    vars: ["application_id", "video_submission_id", "video_revision", "program_name", "portal_link", "guide_link", "supercent_brand"],
    required: ["portal_link", "guide_link", "supercent_brand"],
    defaultBodyFormat: "html",
    defaults: {
      subject: SCP_CONTENT_SUBMITTED_RECEIPT_SUBJECT,
      html: CONTENT_SUBMITTED_EMAIL_EN_HTML,
      text: SCP_CONTENT_SUBMITTED_RECEIPT_TEXT,
      bodyFormat: "html",
    },
  },
  {
    kind: "video_result_mail",
    title: "영상 검수 결과 메일",
    lane: "검수 결과",
    desc: "승인·변경 요청·반려 결과 안내. 안내 문구는 고정 코드 지도 결과가 변수로 들어옵니다(자유 문장 불가).",
    // 2026-09-05 다타이틀: 게임명·스토어 링크·해시태그는 프로그램 타이틀 레지스트리에서만
    // 온다(functions/programTitles.seed.json). 서버 허용/주입 계약(RECEIPT_TEMPLATE_RULES)에는
    // 이미 있었는데 편집기 칩 목록에 없어서 운영자가 손으로 타이핑해야만 쓸 수 있었다.
    vars: ["video_result_state", "video_result_message", "correction_link", "game_title", "game_store_link", "game_hashtags", "program_name", "portal_link", "supercent_brand"],
    required: [],
    // W8-3(사용자): 검수 결과 메일은 텍스트로 운영한다. 문서가 없으면 기존 코드 fallback 이 그대로
    // 발송되므로(HTML 포함) 이 기본값은 **편집기 초기 토글**만 바꾼다.
    defaultBodyFormat: "text",
    // F3: 기본 초안은 **판정 중립**이다. 승인·변경 요청·반려 세 판정이 이 문서 하나를 공유하므로,
    // 기본값에 재제출 CTA 나 조건부 변수({{correction_link}})를 넣으면 승인 메일에 재제출 문구와
    // 빈 앵커가 그대로 나간다(운영 실측 결함). 조건부 변수는 운영자가 의도적으로 넣을 때만 쓰고,
    // 그때는 편집기가 빨간 경고를 띄운다.
    defaults: {
      subject: "[SCP] Update on your video submission",
      html: [
        "<p>Review result: {{video_result_state}}</p>",
        "<p>{{video_result_message}}</p>",
      ].join("\n"),
      text: [
        "Review result: {{video_result_state}}",
        "{{video_result_message}}",
      ].join("\n"),
      bodyFormat: "text",
    },
  },
];

// onboarding 레인은 제네릭(텍스트) kind 를 쓴다 — 이 탭에서는 발행 상태만 조망하고 편집은 정본
// 위치로 보낸다. 편집 화면을 복제하면 같은 문서를 두 곳에서 쓰게 된다.
const ONBOARDING_GENERIC_KINDS = [
  "qualification_pass",
  "qualification_fail",
  "re_guide",
  "gem_paid_submission_request",
  "video_submission_reminder",
] as const;

const BODY_FORMAT_OPTIONS: ReadonlyArray<{ value: TemplateBodyFormat; label: string }> = [
  { value: "html", label: "HTML+텍스트" },
  { value: "text", label: "텍스트만" },
];

const GENERIC_TEMPLATE_EDIT_HREF = buildReviewQueueHref("mail", { basePath: "/flu/scp" });

function templateRowMatches(row: Record<string, unknown>, kind: string): boolean {
  return row.kind === kind || row.id === kind;
}

function liveRowFor(kind: string, rows: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return rows.find((item) => templateRowMatches(item, kind));
}

/** 발행 신원 비교용 — 문자열/숫자 어느 쪽으로 저장돼 있어도 같은 값이면 같은 키가 된다. */
function asRowString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/**
 * R7: 발행본의 형식은 저장된 `bodyFormat` 명시 필드가 진실이다 — html 유무로 추론하지 않는다
 * (html 유무 추론은 "아직 초안 없음"과 "운영자가 텍스트 전용을 골랐음"을 구분하지 못한다).
 * 이 필드가 없는 레거시 문서만 예전 추론(html 유무)으로 내려간다.
 */
function liveBodyFormat(
  liveRow: Record<string, unknown> | undefined,
  fallback: TemplateBodyFormat,
): TemplateBodyFormat {
  if (!liveRow) return fallback;
  if (liveRow.bodyFormat === "text" || liveRow.bodyFormat === "html") return liveRow.bodyFormat;
  return typeof liveRow.html === "string" && liveRow.html ? "html" : "text";
}

function draftFromLive(
  definition: TemplateDefinition,
  liveRow: Record<string, unknown> | undefined,
): TemplateDraft {
  const text = typeof liveRow?.text === "string" ? liveRow.text : liveRow?.body;
  const bodyFormat = liveBodyFormat(liveRow, definition.defaultBodyFormat);
  // R7a: htmlDraft is the operator's authored HTML, preserved server-side even while bodyFormat is
  // "text" (functions/scpMail.ts normalizeReceiptTemplate). Reload must restore exactly that — never
  // fall back to the code's built-in master HTML when a published doc exists, or a toggle-back +
  // Publish would ship the code default to real recipients disguised as the operator's own text.
  const preservedHtml = liveRow
    ? (typeof liveRow.htmlDraft === "string" && liveRow.htmlDraft
      ? liveRow.htmlDraft
      : (typeof liveRow.html === "string" ? liveRow.html : ""))
    : definition.defaults.html;
  return {
    subject: typeof liveRow?.subject === "string" ? liveRow.subject : definition.defaults.subject,
    html: preservedHtml,
    text: typeof text === "string" ? text : definition.defaults.text,
    bodyFormat,
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line py-3 last:border-0">
      <span className="text-xs font-semibold text-ink-2">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function TemplateLintWarnings({ lints }: { lints: ScpMailTemplateEnvelope["lints"] }) {
  if (!lints) return null;
  const safety = lints.safetyKeywordMatches ?? [];
  const conditional = lints.conditionallyInjectedVariables ?? [];
  if (safety.length === 0 && conditional.length === 0) {
    return (
      <p data-testid="template-lints-clean" className="mt-2 text-[11px] text-ink-4">
        위험 문구 매치 없음 · 조건부 변수 없음
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1.5" data-testid="template-lints">
      {safety.length > 0 ? (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-[11px] font-semibold text-danger">
          위험 문구 {safety.join(", ")} 가 본문에 있습니다 — 이 문구가 매치되면 메일 안전 정책이 발송을 전면 차단합니다.
        </p>
      ) : null}
      {conditional.length > 0 ? (
        // F3: 조건부 변수는 회색 안내가 아니라 **경고**다. 값이 없는 판정에서는 빈 문자열이 되고,
        // 앵커 href 에 쓰면 죽은 링크가 그대로 수신자에게 나간다(승인 메일의 재제출 링크 사고).
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-[11px] font-semibold text-danger">
          일부 경로에서만 주입되는 변수 {conditional.map((name) => `{{${name}}}`).join(", ")} — 값이 없는 판정(예: 승인)에서는 빈 칸·죽은 링크가 됩니다.
        </p>
      ) : null}
    </div>
  );
}

function titleFact(title: ClientProgramTitle, key: string): string {
  const row = title as unknown as Record<string, unknown>;
  const text = typeof row[key] === "string" ? row[key].trim() : "";
  return text;
}

function titlePreviewValue(title: ClientProgramTitle, variable: string): string {
  switch (variable) {
    case "application_id": return `preview-${title.id}`;
    case "video_submission_id": return `vsub-preview-${title.id}`;
    case "video_revision": return "1";
    case "program_name": return "Super Creator Partners";
    case "portal_link": return "https://creator.supercent.io";
    case "apply_link": return "https://creator.supercent.io/apply";
    case "guide_link": return titleFact(title, "guidebookUrl") || title.storeUrl;
    case "reference_code": return title.id;
    case "supercent_brand": return "Super Creator Partners";
    case "video_result_state": return "changes_requested";
    case "video_result_message": return `Please make sure your ${title.name} content follows the guide.`;
    case "correction_link": return "https://creator.supercent.io/submissions/preview";
    case "game_title": return title.name;
    case "game_store_link": return title.storeUrl;
    case "game_hashtags": return title.requiredHashtag;
    default: return "";
  }
}

function titlePreviewValues(definition: TemplateDefinition, title: ClientProgramTitle): Record<string, string> {
  return Object.fromEntries(
    definition.vars
      .map((variable) => [variable, titlePreviewValue(title, variable)] as const)
      .filter((entry) => entry[1] !== ""),
  );
}

function ScpMailTemplateCard({
  definition,
  liveTemplates,
}: {
  definition: TemplateDefinition;
  liveTemplates: Record<string, unknown>[];
}) {
  const liveRow = liveRowFor(definition.kind, liveTemplates);
  // W8-1d: 리셋 판정은 **발행본이 실제로 바뀌었을 때**만 참이어야 한다. 예전 훅은 liveRow 객체
  // 참조에 의존해서, 백그라운드 refresh 가 같은 내용의 새 배열을 커밋할 때마다 작성 중인 초안을
  // 통째로 날렸다(긴 마스터 HTML 붙여넣던 중 유실). 발행 신원(hash+version)만 본다.
  const publishedIdentity = `${asRowString(liveRow?.contentHash)}:${asRowString(liveRow?.version)}`;
  const [draft, setDraft] = useState<TemplateDraft>(() => draftFromLive(definition, liveRow));
  const [preview, setPreview] = useState<ScpMailTemplateEnvelope | null>(null);
  const [titlePreview, setTitlePreview] = useState<ScpMailTemplateEnvelope | null>(null);
  const [titlePreviewId, setTitlePreviewId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const appliedIdentityRef = useRef(publishedIdentity);
  const [serverTitleOptions, setServerTitleOptions] = useState<ScpVideoReviewTitleOption[]>([]);
  const [serverTitleOptionsState, setServerTitleOptionsState] = useState<"loading" | "loaded" | "error">("loading");
  const [serverTitleOptionsError, setServerTitleOptionsError] = useState("");
  const loadServerTitleOptions = useCallback(() => {
    setServerTitleOptionsState("loading");
    setServerTitleOptionsError("");
    fetchTemplateTitleOptionsOnce(SCP_CANONICAL_PROGRAM_ID)
      .then((options) => {
        setServerTitleOptions(options);
        setServerTitleOptionsState("loaded");
      })
      .catch((caught) => {
        setServerTitleOptions([]);
        setServerTitleOptionsState("error");
        setServerTitleOptionsError(publicCallableErrorMessage(caught, "타이틀 레지스트리를 불러오지 못했습니다."));
      });
  }, []);
  useEffect(() => {
    loadServerTitleOptions();
  }, [loadServerTitleOptions]);
  const programTitles = useMemo(
    () => serverTitleOptionsState === "loaded" ? mergeTemplateServerProgramTitleOptions(clientProgramTitles(SCP_CANONICAL_PROGRAM_ID), serverTitleOptions) : [],
    [serverTitleOptions, serverTitleOptionsState],
  );
  const titleRegistryReady = serverTitleOptionsState === "loaded" && programTitles.length > 0;
  const titleRegistryMessage = serverTitleOptionsState === "error"
    ? serverTitleOptionsError || "타이틀 레지스트리를 불러오지 못했습니다."
    : serverTitleOptionsState === "loading"
      ? "타이틀 레지스트리를 확인하고 있습니다."
      : programTitles.length === 0
        ? "타이틀 레지스트리가 비어 있습니다."
        : "";
  const showsTitleSamples = definition.kind === "application_confirmed" || definition.vars.includes("game_title");

  useEffect(() => {
    if (!liveRow) return;
    if (appliedIdentityRef.current === publishedIdentity) return;
    appliedIdentityRef.current = publishedIdentity;
    setDraft(draftFromLive(definition, liveRow));
    setPreview(null);
    setMessage("");
    setError("");
    // liveRow 는 같은 발행본이면 리셋 대상이 아니므로 의존성에서 제외한다(참조 변경 무시).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, publishedIdentity]);

  function patch(partial: Partial<TemplateDraft>) {
    setDraft((previous) => ({ ...previous, ...partial }));
    setPreview(null);
    setTitlePreview(null);
    setTitlePreviewId("");
    setMessage("");
    setError("");
  }

  async function previewTemplate() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const envelope = await upsertScpMailTemplate({
        kind: definition.kind,
        title: definition.title,
        subject: draft.subject,
        html: draft.html,
        bodyFormat: draft.bodyFormat,
        text: draft.text,
        dryRun: true,
      });
      setPreview(envelope);
      setMessage("미리보기 완료");
    } catch (caught) {
      setError(publicCallableErrorMessage(caught, "메일 템플릿 미리보기에 실패했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function previewTitleSample(title: ClientProgramTitle) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const envelope = await upsertScpMailTemplate({
        kind: definition.kind,
        title: definition.title,
        subject: draft.subject,
        html: draft.html,
        bodyFormat: draft.bodyFormat,
        text: draft.text,
        dryRun: true,
        previewValues: titlePreviewValues(definition, title),
      });
      setTitlePreview(envelope);
      setTitlePreviewId(title.id);
      setPreview(envelope);
      setMessage(`${title.name} 미리보기 완료`);
    } catch (caught) {
      setError(publicCallableErrorMessage(caught, "타이틀별 미리보기에 실패했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function publishTemplate() {
    if (!preview) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const envelope = await upsertScpMailTemplate({
        kind: definition.kind,
        title: definition.title,
        subject: draft.subject,
        html: draft.html,
        bodyFormat: draft.bodyFormat,
        text: draft.text,
        expectedVersion: preview.currentVersion,
        expectedHash: preview.currentHash,
      });
      setPreview(null);
      setMessage(envelope.noop ? "동일한 템플릿입니다" : `Publish 완료 · version ${envelope.version ?? "-"}`);
      requestDataRefresh();
    } catch (caught) {
      if (callableErrorCode(caught) === "failed-precondition") {
        setPreview(null);
        setError("동시 수정 충돌입니다. 새 미리보기를 만든 뒤 다시 Publish 하세요.");
      } else {
        setError(publicCallableErrorMessage(caught, "메일 템플릿 Publish에 실패했습니다."));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-line bg-paper p-4" data-testid={`scp-mail-template-${definition.kind}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-ink">{definition.title}</h3>
          <p className="mt-0.5 text-[11px] text-ink-3" title={definition.kind}>
            {definition.lane} · {mailTemplateKindLabel(definition.kind)}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-ink-4">{definition.desc}</p>
          <p className="mt-1 text-[11px] text-ink-4">
            published version {typeof liveRow?.version === "number" ? liveRow.version : "fallback"}
            {liveRow ? ` · ${liveBodyFormat(liveRow, definition.defaultBodyFormat) === "text" ? "텍스트만" : "HTML+텍스트"}` : ""}
          </p>
        </div>
        <Badge tone={liveRow ? "ok" : "neutral"}>{liveRow ? "published" : "fallback"}</Badge>
      </div>
      <Field label="Subject">
        <input
          value={draft.subject}
          onChange={(event) => patch({ subject: event.target.value })}
          className="h-8 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink focus:border-accent focus:outline-none"
        />
      </Field>
      <Field label="본문 형식">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="본문 형식">
          {BODY_FORMAT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={draft.bodyFormat === option.value}
              onClick={() => patch({ bodyFormat: option.value })}
              className={`min-h-8 rounded-md px-3 text-xs font-semibold transition-colors ${draft.bodyFormat === option.value ? "bg-fill text-ink shadow-sm" : "text-ink-3 hover:bg-fill/70 hover:text-ink"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-ink-4">
          {draft.bodyFormat === "text"
            ? "텍스트만 발송합니다(HTML 파트 없음). 아래 텍스트 본문이 그대로 수신자에게 갑니다."
            : "HTML + 텍스트 두 파트로 발송합니다. 텍스트 파트는 서버가 HTML 에서 파생합니다."}
        </p>
      </Field>
      {draft.bodyFormat === "html" ? (
        <Field label="HTML">
          <textarea
            value={draft.html}
            onChange={(event) => patch({ html: event.target.value })}
            rows={8}
            className="w-full resize-none rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] leading-relaxed text-ink focus:border-accent focus:outline-none"
          />
        </Field>
      ) : null}
      <Field label="Plain text">
        <textarea
          value={draft.text}
          onChange={(event) => patch({ text: event.target.value })}
          rows={5}
          className="w-full resize-none rounded-md border border-line bg-paper px-3 py-2 text-[12px] leading-relaxed text-ink focus:border-accent focus:outline-none"
        />
      </Field>
      <Field label="Variables">
        <div className="flex flex-wrap gap-1.5">
          {definition.vars.map((variable) => (
            <span key={variable} className="rounded-md border border-line bg-fill px-2 py-1 font-mono text-[11px] text-ink-2">
              {`{{${variable}}}`}{definition.required.includes(variable) ? " *" : ""}
            </span>
          ))}
        </div>
      </Field>
      <Field label="저장 전 점검">
        {preview
          ? <TemplateLintWarnings lints={preview.lints} />
          : <p className="text-[11px] text-ink-4">미리보기를 만들면 위험 문구·조건부 변수 점검 결과가 표시됩니다.</p>}
      </Field>
      <Field label="Rendered preview">
        {draft.bodyFormat === "text" ? (
          preview?.preview?.body ? (
            <pre data-testid="template-text-preview" className="max-h-72 w-full overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-paper p-3 text-[12px] leading-relaxed text-ink-2">
              {preview.preview.body}
            </pre>
          ) : (
            <span className="text-xs text-ink-4">미리보기를 만들면 서버 렌더 텍스트가 표시됩니다.</span>
          )
        ) : preview?.preview?.preview ? (
          <iframe
            title={`${definition.title} rendered preview`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={buildSafeMailPreviewDocument(preview.preview.preview)}
            className="h-72 w-full rounded-xl border border-line bg-paper"
          />
        ) : (
          <span className="text-xs text-ink-4">미리보기를 만들면 서버 렌더 HTML이 표시됩니다.</span>
        )}
        {preview?.preview?.subject ? <p className="mt-2 text-xs font-semibold text-ink-2">{preview.preview.subject}</p> : null}
      </Field>
      {showsTitleSamples && !titleRegistryReady ? (
        <Field label="게임별 미리보기">
          <div className="rounded-lg border border-warn/30 bg-warn-soft p-3 text-xs font-medium text-warn" data-testid="scp-mail-template-title-registry-state">
            <div className="flex flex-wrap items-center gap-2">
              <span>{titleRegistryMessage}</span>
              {serverTitleOptionsState === "error" ? <Button variant="secondary" size="sm" onClick={loadServerTitleOptions}>다시 확인</Button> : null}
            </div>
          </div>
        </Field>
      ) : showsTitleSamples && programTitles.length > 1 ? (
        <Field label="게임별 미리보기">
          <div className="grid gap-2 sm:grid-cols-2">
            {programTitles.map((title) => (
              <button
                key={title.id}
                type="button"
                data-testid={`scp-mail-title-sample-${title.id}`}
                onClick={() => previewTitleSample(title)}
                disabled={busy}
                className={`rounded-md border p-3 text-left transition-colors ${titlePreviewId === title.id ? "border-accent bg-accent-soft" : "border-line bg-fill hover:bg-paper"}`}
              >
                <span className="block text-xs font-bold text-ink">{title.name}</span>
                <span className="mt-1 block break-all text-[11px] leading-4 text-ink-4">{title.storeUrl}</span>
                <span className="mt-1 block font-mono text-[11px] text-ink-3">{title.requiredHashtag}</span>
              </button>
            ))}
          </div>
          {titlePreview?.preview?.subject ? (
            <p className="mt-2 text-[11px] text-ink-4">
              {programTitles.find((title) => title.id === titlePreviewId)?.name ?? "타이틀"} dry-run · {titlePreview.preview.subject}
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-ink-4">
              게임별 적용 결과를 저장하지 않고 미리 확인합니다.
            </p>
          )}
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-3">
        {error ? <span className="mr-auto text-xs text-danger">{error}</span> : null}
        {message ? <span className="mr-auto text-xs font-medium text-ok">{message}</span> : null}
        <Button variant="secondary" onClick={previewTemplate} disabled={busy}>
          미리보기
        </Button>
        <Button onClick={publishTemplate} disabled={busy || !preview?.contentHash}>
          Publish
        </Button>
      </div>
    </div>
  );
}

function OnboardingLaneCard({ liveTemplates }: { liveTemplates: Record<string, unknown>[] }) {
  return (
    <div className="rounded-md border border-line bg-paper p-4" data-testid="scp-mail-template-onboarding">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-ink">온보딩 메일</h3>
          <p className="mt-0.5 text-[11px] text-ink-3">온보딩 · 제네릭 텍스트 kind</p>
          <p className="mt-1 text-[11px] leading-4 text-ink-4">
            온보딩 드레인은 아래 제네릭 kind 의 텍스트 본문을 그대로 발송하고, 브랜디드 HTML 파트는
            같은 본문을 정본 셸에 담아 자동으로 붙습니다. 본문 편집은 정본 위치에서 합니다.
          </p>
        </div>
        <Badge tone="neutral">{ONBOARDING_GENERIC_KINDS.length} kinds</Badge>
      </div>
      <ul className="divide-y divide-line text-[12px]">
        {ONBOARDING_GENERIC_KINDS.map((kind) => {
          const liveRow = liveRowFor(kind, liveTemplates);
          return (
            <li key={kind} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-ink" title={kind}>{mailTemplateKindLabel(kind)}</span>
                <span className="ml-2 text-[11px] text-ink-4">
                  {typeof liveRow?.version === "number" ? `version ${liveRow.version}` : "코드 기본값"}
                </span>
              </span>
              <Badge tone={liveRow ? "ok" : "neutral"}>{liveRow ? "published" : "fallback"}</Badge>
            </li>
          );
        })}
      </ul>
      <div className="pt-3 text-right">
        <a href={GENERIC_TEMPLATE_EDIT_HREF} className="text-xs font-semibold text-accent hover:underline">
          제네릭 템플릿 편집 위치로 이동 →
        </a>
      </div>
    </div>
  );
}

export function ScpMailTemplatesPanel() {
  const liveTemplates = useLiveScpMailTemplates<Record<string, unknown>>([]);
  return (
    <div data-testid="scp-mail-templates-tab-panel" className="space-y-4">
      <Card>
        <CardHeader
          title="메일 템플릿"
          desc="SCP 자동 발송 템플릿을 여기서 편집합니다(접수 확인 · 콘텐츠 제출 확인 · 영상 검수 결과 + 온보딩 조망). 미리보기(dryRun)로 검증한 뒤 Publish 하며, 발행 문서를 지우면 각 레인은 코드 기본 문안으로 돌아갑니다."
          action={<Badge tone="neutral">{TEMPLATE_DEFS.length + 1} lanes</Badge>}
        />
        <div className="grid gap-4 px-5 pb-5 lg:grid-cols-2">
          {TEMPLATE_DEFS.map((definition) => (
            <ScpMailTemplateCard
              key={definition.kind}
              definition={definition}
              liveTemplates={liveTemplates}
            />
          ))}
          <OnboardingLaneCard liveTemplates={liveTemplates} />
        </div>
      </Card>
      {/* W8-9: 콜드메일(1차 아웃리치) 편집도 이 탭에서 한다. 정본은 scp_mail_templates 가 아니라
          programs/{id}.coldMail 문서이고 저장은 기존 updateProgramColdMail CAS 경로를 그대로 쓴다 —
          그래서 위 카드들과 다른 Card 로 분리해 정본 차이를 화면에서도 구분한다. */}
      {/* W72 C-1: 회차 매핑. 문안 편집(위 카드들)과 **어느 회차에 쓸지**(이 카드)를 분리한다 —
          한 카드에 섞으면 같은 문안을 여러 회차에 쓸 때 어디를 고쳐야 하는지가 흐려진다. */}
      <NudgeSequenceMappingCard />
      <ScpColdMailProgramCard />
    </div>
  );
}
