"use client";

// W8-9: 콜드메일 편집기 이설 — 프로그램 상세 모달에 있던 편집기가 여기로 왔다.
//
// 이설 원칙(W8-1 에서 확정된 함정 체크리스트를 그대로 적용):
//   ① 라이브 데이터 키: 프로그램 목록을 읽으므로 datasetKeysForPath("/flu/scp") 에 `programs` 가 있어야
//      한다 — 없으면 셀렉트가 영원히 비어 편집 자체가 불가능하다(W8-1c 와 같은 결함 클래스).
//   ② 콜러블·리전: 기존 updateProgramColdMail(dryRun → CAS 저장 → 감사로그) · previewEmailDraft ·
//      localizeProgramMailTemplate 을 **그대로** 재사용한다. 새 저장 경로를 만들지 않는다.
//      콜드메일 정본은 계속 programs/{id}.coldMail 문서다(scp_mail_templates 로 옮기는 것이 아니다).
//   ③ 권한 게이트: 이 탭은 manager+ 게이트(scp/page.tsx) 뒤에 있고, 서버는 CAMPAIGN_ROLES 로 다시
//      판정한다(콜러블이 진실). 화면 게이트는 편의이지 권한 판정이 아니다.
//   ④ 에러 문구 노출: publicCallableErrorMessage / callableErrorCode 로 실패 사유를 카드에 표시한다.
//   ⑤ draft 리셋 가드: 저장된 콜드메일 신원(version+contentHash)이 **실제로 바뀔 때만** 초안을
//      되돌린다 — 배경 refresh 가 같은 내용을 다시 커밋해도 작성 중인 본문을 잃지 않는다.
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  buildSafeMailPreviewDocument,
  localizeProgramMailTemplate,
  previewEmailDraft,
  updateProgramColdMail,
  type MailBodyFormat,
  type PreviewEmailDraftEnvelope,
  type UpdateProgramColdMailEnvelope,
} from "@/lib/data";
import { callableErrorCode, publicCallableErrorMessage, requestDataKeys, requestDataRefresh, useLive, useLivePrograms } from "@/lib/live";
import type { Program } from "@/modules/programs";
import {
  COLD_MAIL_BODY_FORMAT_OPTIONS,
  COLD_MAIL_COUNTRY_OPTIONS,
  PROGRAM_COLD_MAIL_PREVIEW_VALUES,
  programColdMailBodyFormat,
  programColdMailIdentity,
} from "@/lib/mail/programColdMail";

// W8-9 이설 본체 — 프로그램 상세 모달에 있던 편집기를 **그대로** 옮겼다(콜러블·CAS·감사로그·문구
// 동일). 달라진 것은 프로그램을 이 화면에서 고른다는 점과, 저장 후 목록 갱신을 requestDataRefresh
// 로 한다는 점뿐이다.
function ProgramColdMailEditor({ program, refresh }: { program: Program; refresh: () => void | Promise<unknown> }) {
  const coldMail = program.coldMail;
  const [subject, setSubject] = useState(coldMail?.subject ?? "");
  const [body, setBody] = useState(coldMail?.body ?? "");
  const [sourceCountry, setSourceCountry] = useState(coldMail?.sourceCountry ?? "KR");
  const [targets, setTargets] = useState<string[]>(coldMail?.targetCountries ?? []);
  const [bodyFormat, setBodyFormat] = useState<MailBodyFormat>(() => programColdMailBodyFormat(program));
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<UpdateProgramColdMailEnvelope | null>(null);
  const [compiledPreview, setCompiledPreview] = useState<PreviewEmailDraftEnvelope | null>(null);
  const [previewError, setPreviewError] = useState("");
  const localized = coldMail?.localized ?? {};
  const isHtmlMode = bodyFormat === "html";
  // ⑤ draft 리셋 가드: 저장된 콜드메일 신원(version+contentHash)이 바뀐 경우에만 초안을 되돌린다.
  // 예전 편집기는 모달이 다시 마운트될 때 useState 초기값으로만 동기화됐고, 이 화면은 배경 refresh
  // 로 같은 프로그램 객체가 계속 새로 오므로 가드가 없으면 작성 중 본문이 날아간다.
  const savedIdentity = programColdMailIdentity(program);
  const appliedIdentityRef = useRef(savedIdentity);
  // R8④: 신원이 바뀔 때 "마지막으로 화면에 반영한 원본" 스냅샷 — 지금 입력값이 이 스냅샷과 달라졌으면
  // (=draft dirty) 다른 탭/세션이 먼저 저장한 것이다. 이때는 조용히 덮어쓰지 않고 경고만 남긴다
  // (덮어쓰면 작성 중인 내용이 경고 없이 사라진다 — 회귀 신고 대상).
  const appliedSnapshotRef = useRef({
    subject: coldMail?.subject ?? "",
    body: coldMail?.body ?? "",
    sourceCountry: coldMail?.sourceCountry ?? "KR",
    targets: coldMail?.targetCountries ?? [],
    bodyFormat,
  });
  useEffect(() => {
    if (appliedIdentityRef.current === savedIdentity) return;
    appliedIdentityRef.current = savedIdentity;
    const baseline = appliedSnapshotRef.current;
    const draftDirty = subject !== baseline.subject
      || body !== baseline.body
      || sourceCountry !== baseline.sourceCountry
      || bodyFormat !== baseline.bodyFormat
      || targets.length !== baseline.targets.length
      || targets.some((code, index) => code !== baseline.targets[index]);
    const nextSnapshot = {
      subject: program.coldMail?.subject ?? "",
      body: program.coldMail?.body ?? "",
      sourceCountry: program.coldMail?.sourceCountry ?? "KR",
      targets: program.coldMail?.targetCountries ?? [],
      bodyFormat: programColdMailBodyFormat(program),
    };
    appliedSnapshotRef.current = nextSnapshot;
    if (draftDirty) {
      setMessage("충돌: 다른 세션이 이 콜드메일을 먼저 저장했습니다 — 지금 화면에 작성 중인 내용은 그대로 유지됩니다(자동 덮어쓰기 안 함). 최신 내용은 새로고침해야만 반영됩니다 — 미리보기를 다시 실행해도 화면의 값을 서버로 보낼 뿐 상대가 저장한 내용은 불러오지 않으며, 그대로 적용하면 상대 저장분을 덮어씁니다.");
      return;
    }
    setSubject(nextSnapshot.subject);
    setBody(nextSnapshot.body);
    setSourceCountry(nextSnapshot.sourceCountry);
    setTargets(nextSnapshot.targets);
    setBodyFormat(nextSnapshot.bodyFormat);
    setPreview(null);
    setCompiledPreview(null);
    setPreviewError("");
    setMessage("");
    // program 객체 참조가 바뀌어도 신원이 같으면 아무것도 하지 않는다(의존성에서 제외).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedIdentity]);

  function invalidatePreview() {
    setPreview(null);
    setCompiledPreview(null);
    setPreviewError("");
    setMessage("");
  }

  function toggleTarget(code: string) {
    setTargets((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
    invalidatePreview();
  }

  async function previewColdMail(useDefault = false) {
    if (!useDefault && !subject.trim() && !body.trim()) { setMessage("제목 또는 본문을 입력해 주세요."); return; }
    setBusy("preview");
    setMessage("");
    setPreviewError("");
    setCompiledPreview(null);
    try {
      const result = await updateProgramColdMail(useDefault
        ? { programId: program.id, useDefault: true, dryRun: true, previewValues: PROGRAM_COLD_MAIL_PREVIEW_VALUES }
        : { programId: program.id, subject, body, sourceCountry, targetCountries: targets, bodyFormat, dryRun: true, previewValues: PROGRAM_COLD_MAIL_PREVIEW_VALUES });
      setSubject(result.coldMail.subject);
      setBody(result.coldMail.body);
      setSourceCountry(result.coldMail.sourceCountry);
      setTargets(result.coldMail.targetCountries);
      setBodyFormat(result.coldMail.bodyFormat ?? "markdown");
      setPreview(result);
      const compiled = await previewEmailDraft({
        subject: result.coldMail.subject,
        body: result.coldMail.body,
        bodyFormat: result.coldMail.bodyFormat ?? "markdown",
        templateValues: PROGRAM_COLD_MAIL_PREVIEW_VALUES,
        templateRevision: result.contentHash,
        draftRef: `program-coldmail-${program.id}`,
        trackingId: `program-preview-${program.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 72) || "program"}`,
      });
      setCompiledPreview(compiled);
      setMessage("미리보기 완료 — 정규화 본문·placeholder·hash를 확인한 뒤 적용하세요.");
    } catch (error) {
      const detail = publicCallableErrorMessage(error, "콜드메일 미리보기를 만들지 못했습니다.");
      setPreviewError(detail);
      setMessage(`미리보기 실패: ${detail}`);
    } finally {
      setBusy(null);
    }
  }

  async function applyAndTranslate() {
    if (!preview || !compiledPreview || busy) return;
    setBusy("apply");
    setMessage("");
    try {
      const applied = await updateProgramColdMail({
        programId: program.id,
        ...preview.coldMail,
        ...(preview.currentVersion !== undefined ? { expectedVersion: preview.currentVersion } : {}),
        ...(preview.currentHash !== undefined ? { expectedHash: preview.currentHash } : {}),
      });
      // R8④: 방금 저장한 내용을 draft-dirty 판정 기준선으로 미리 반영한다 — 그렇지 않으면 이
      // 저장으로 배경 refresh 가 새 신원을 들고 돌아왔을 때 "다른 세션이 먼저 저장했다"는 오탐
      // 충돌 경고가 뜬다(내가 방금 저장한 것을 남이 저장한 것으로 착각).
      appliedSnapshotRef.current = { subject, body, sourceCountry, targets, bodyFormat };
      await refresh();
      setPreview(null);
      setCompiledPreview(null);
      // HTML 직접 작성 모드는 국가별 자동번역을 아예 돌리지 않는다(설계 결정) — 번역 호출 자체를 생략.
      if (isHtmlMode) {
        setMessage(`${applied.noop ? "동일 본문 유지(추가 쓰기 없음)" : `적용 완료 · version ${applied.version ?? "-"}`} · HTML 모드 — 번역 비활성화됨`);
        return;
      }
      const localizedResult = await localizeProgramMailTemplate({ programId: program.id });
      await refresh();
      requestDataRefresh();
      setMessage(`${applied.noop ? "동일 본문 유지(추가 쓰기 없음)" : `적용 완료 · version ${applied.version ?? "-"}`}`
        + ` · 번역 ${localizedResult.translated.length}개 생성, ${localizedResult.skipped.length}개 캐시 재사용`
        + (localizedResult.discarded.length > 0 ? `, stale ${localizedResult.discarded.length}개 폐기` : ""));
    } catch (error) {
      const detail = publicCallableErrorMessage(error, "콜드메일 변경을 적용하지 못했습니다.");
      if (callableErrorCode(error) === "failed-precondition") {
        setPreview(null);
        // R9-4: 예전 문구는 "다시 미리보기 하세요"였는데, 미리보기는 **화면의 값을 서버로 보낼 뿐**
        // 상대가 저장한 내용을 가져오지 않는다. 그 결과의 currentVersion/currentHash 로 적용하면 CAS 를
        // 통과해 **상대 저장분을 덮어쓴다** — 안내가 사고를 유도하고 있었다. 최신 내용을 받는 수단은
        // 새로고침뿐이다(로직은 그대로, 문구만 사실화).
        setMessage("적용 충돌: 다른 운영자가 원본을 먼저 저장했습니다. 새로고침해야 상대가 저장한 내용을 볼 수 있습니다 — 미리보기를 다시 실행해도 화면의 값을 보낼 뿐이라 그대로 적용하면 상대 저장분을 덮어씁니다.");
      } else {
        setMessage(`적용 실패: ${detail}`);
      }
    } finally {
      setBusy(null);
    }
  }

  // R9②: 충돌/실패 문구는 성공 문구와 같은 중립색이라 구분이 안 됐다 — 이 카드가 이미 쓰는
  // danger/warn 토큰(위 previewError 배너·isHtmlMode 경고와 동일 팔레트)으로만 갈라 보여준다.
  const messageIsConflict = message.includes("충돌");
  const messageIsFailure = !messageIsConflict && message.includes("실패");
  const messageClassName = messageIsConflict
    ? "mt-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs font-semibold text-warn"
    : messageIsFailure
      ? "mt-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-semibold text-danger"
      : "mt-3 text-xs font-semibold text-ink-2";

  return (
    <section className="mb-5 rounded-xl border border-line bg-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-ink">콜드메일 템플릿 · 국가별 발송</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{"원본을 작성하고 발송 국가를 고르면 국가별로 한 번 번역해 저장합니다. {{name}}·{{game}} 변수 사용 가능."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => previewColdMail(true)} disabled={busy !== null}>승인 기본안 미리보기</Button>
          <Button variant="secondary" onClick={() => previewColdMail(false)} disabled={busy !== null}>{busy === "preview" ? "미리보기 중…" : "1. 변경 미리보기"}</Button>
          <Button onClick={applyAndTranslate} disabled={busy !== null || !preview || !compiledPreview}>{busy === "apply" ? "적용·번역 중…" : "2. 현재 버전 적용 & 번역"}</Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3">
        <label className="grid gap-1 text-xs font-semibold text-ink-2">
          제목 (원본)
          <input value={subject} onChange={(e) => { setSubject(e.target.value); invalidatePreview(); }} placeholder="예: {{name}}님께 협업 제안" className="h-10 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink" />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="콜드메일 본문 형식">
          {COLD_MAIL_BODY_FORMAT_OPTIONS.map((option) => {
            const active = bodyFormat === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => { setBodyFormat(option.value); invalidatePreview(); }}
                aria-pressed={active}
                className={`inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-semibold transition-[background-color,border-color,transform] active:scale-[0.96] ${active ? "border-accent bg-accent-soft text-accent" : "border-line bg-paper text-ink-3 hover:border-ink-3"}`}
              >
                {active ? "✓ " : ""}{option.label}
              </button>
            );
          })}
        </div>
        <label className="grid gap-1 text-xs font-semibold text-ink-2">
          {isHtmlMode ? "본문 (원본 HTML)" : "본문 (원본)"}
          <textarea
            value={body}
            onChange={(e) => { setBody(e.target.value); invalidatePreview(); }}
            rows={isHtmlMode ? 14 : 10}
            placeholder={isHtmlMode ? "<p>{{game}} 신작 협업을 제안드립니다…</p>" : "예: {{game}} 신작 협업을 제안드립니다…"}
            className={`w-full rounded-md border border-line bg-paper px-3 py-2 text-sm leading-relaxed text-ink ${isHtmlMode ? "font-mono" : ""}`}
          />
        </label>
        {isHtmlMode ? (
          <p className="text-xs font-semibold text-warn">HTML 모드에서는 마크다운 변환 없이 원문 그대로 발송되며, 국가별 자동 번역은 비활성화됩니다(영문/원문 그대로 발송).</p>
        ) : null}
        <label className="grid gap-1 text-xs font-semibold text-ink-2">
          원본 작성 언어(국가)
          <select value={sourceCountry} onChange={(e) => { setSourceCountry(e.target.value); invalidatePreview(); }} className="h-10 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink">
            <option value="KR">한국어 (KR)</option>
            {COLD_MAIL_COUNTRY_OPTIONS.map((opt) => <option key={opt.code} value={opt.code}>{opt.label}</option>)}
          </select>
        </label>
        {isHtmlMode ? null : (
          <div className="grid gap-1.5">
            <span className="text-xs font-semibold text-ink-2">발송 국가</span>
            <div className="flex flex-wrap gap-1.5">
              {COLD_MAIL_COUNTRY_OPTIONS.map((opt) => {
                const on = targets.includes(opt.code);
                return (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => toggleTarget(opt.code)}
                    aria-pressed={on}
                    className={`inline-flex min-h-10 items-center rounded-full border px-3 text-xs font-semibold transition-[background-color,border-color,transform] active:scale-[0.96] ${on ? "border-accent bg-accent-soft text-accent" : "border-line bg-paper text-ink-3 hover:border-ink-3"}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {message ? (
        <p className={messageClassName} role={messageIsConflict || messageIsFailure ? "alert" : undefined}>
          {message}
        </p>
      ) : null}

      {busy === "preview" ? (
        <div className="mt-3 rounded-md bg-fill px-3 py-8 text-center text-xs font-semibold text-ink-3" role="status">
          서버에서 드라이런 원본과 메일 아티팩트를 컴파일하는 중…
        </div>
      ) : null}

      {previewError && busy !== "preview" ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-semibold text-danger" role="alert">
          <span>{previewError}</span>
          <Button size="sm" variant="secondary" onClick={() => void previewColdMail(false)}>다시 시도</Button>
        </div>
      ) : null}

      {preview && compiledPreview ? (
        <div className="mt-3 rounded-md border border-warn/30 bg-warn-soft p-3 text-xs text-ink-2" data-testid="coldmail-cas-preview">
          <div title={`정규화 hash ${preview.contentHash}`}>저장된 버전 {preview.currentVersion ?? 0} · 본문 대조값 확인됨</div>
          <div className="mt-1">미치환: {preview.preview.missingPlaceholders.length > 0 ? preview.preview.missingPlaceholders.join(", ") : "없음"}</div>
          <iframe
            title="프로그램 콜드메일 서버 컴파일 미리보기"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={buildSafeMailPreviewDocument(compiledPreview.artifact.compiledHtml, compiledPreview.assetContents ?? [])}
            className="mt-2 h-[480px] w-full rounded-md border border-line bg-white"
          />
          <dl className="mt-3 grid gap-1 rounded-md bg-paper p-3 text-[10px] leading-5 text-ink-3">
            <div>본문 형식 {compiledPreview.artifact.bodyFormat} · 템플릿 리비전 {compiledPreview.artifact.templateRevision}</div>
            {/* 컴파일 해시 3종은 운영자가 읽을 값이 아니다 — 대조가 필요할 때만 툴팁으로. */}
            <div
              title={`source ${compiledPreview.artifact.sourceHash} / compiled ${compiledPreview.artifact.compiledHash} / text ${compiledPreview.artifact.textHash} / compiler ${compiledPreview.artifact.compilerVersion}`}
            >
              본문 지문 확인됨 (자세히 보기는 마우스를 올려 확인)
            </div>
          </dl>
          <div className="mt-3 text-xs font-semibold text-ink-2">컴파일된 텍스트</div>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-paper p-2 text-[11px] leading-5">{compiledPreview.artifact.text}</pre>
        </div>
      ) : null}

      {Object.keys(localized).length > 0 ? (
        <div className="mt-4 grid gap-2">
          <span className="text-xs font-bold text-ink">국가별 번역 (저장됨)</span>
          {Object.entries(localized).map(([country, variant]) => (
            <div key={country} className="rounded-md border border-line bg-fill px-3 py-2">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <span className="rounded bg-paper px-1.5 py-0.5 tabular-nums text-ink">{country}</span>
                <span className="text-ink-4">{variant.lang}</span>
              </div>
              <div className="mt-1 truncate text-sm font-semibold text-ink">{variant.subject}</div>
              <div className="mt-0.5 truncate text-xs leading-relaxed text-ink-3">{variant.body}</div>
              {variant.sourceHash ? <div className="mt-1 truncate text-[10px] text-ink-4" title={`source ${variant.sourceHash}`}>본문 대조값 확인됨</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}


export function ScpColdMailProgramCard() {
  const { authReady, canRead, perKeyError } = useLive();
  const livePrograms = useLivePrograms<Program>([]);
  const [programId, setProgramId] = useState("");
  // R9①: perKeyError("programs") 는 벌크 loading 과 무관하게 이 키의 최종 실패만 잡는다 — 이게
  // 없으면 requestDataKeys 가 실패해도 options.length === 0 이 계속 "불러오는 중"으로만 보인다.
  const programsLoadError = perKeyError("programs");

  // ① 라이브 데이터 키: /flu/scp 분기에 programs 가 포함돼 있어야 목록이 채워진다. 라우트 키가
  // 아직 안 실렸을 때도 이 카드가 스스로 요청해 "빈 셀렉트"로 막히지 않게 한다(중복 요청은 병합됨).
  useEffect(() => {
    if (!authReady || !canRead) return;
    requestDataKeys(["programs"], true);
  }, [authReady, canRead]);

  const options = useMemo(
    () => livePrograms
      .filter((program): program is Program => Boolean(program?.id))
      .map((program) => ({ id: program.id, label: program.title || program.id }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    [livePrograms],
  );
  const selected = useMemo(
    () => livePrograms.find((program) => program.id === programId) ?? null,
    [livePrograms, programId],
  );

  return (
    <Card>
      <CardHeader
        title="콜드메일 템플릿"
        desc="프로그램별 1차 콜드메일 원본을 편집합니다. 정본은 programs 문서의 coldMail 이고, 저장은 기존 CAS 경로(미리보기 → 현재 버전 적용)를 그대로 씁니다. 캠페인 위저드는 이 원본을 상속합니다."
        action={<Badge tone="neutral">{options.length} programs</Badge>}
      />
      <div className="grid gap-4 px-5 pb-5">
        <label className="grid gap-1 text-xs font-semibold text-ink-2">
          프로그램
          <select
            aria-label="콜드메일 편집 프로그램"
            data-testid="coldmail-program-select"
            value={programId}
            onChange={(event) => setProgramId(event.target.value)}
            disabled={!authReady || !canRead || options.length === 0}
            className="h-10 w-full rounded-md border border-line bg-paper px-3 text-sm text-ink disabled:cursor-not-allowed disabled:text-ink-4"
          >
            <option value="">
              {!authReady ? "권한 확인 중" : !canRead ? "읽기 권한 없음" : programsLoadError ? "프로그램 목록을 불러오지 못함" : options.length === 0 ? "프로그램 목록을 불러오는 중" : "프로그램을 고르세요"}
            </option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        {programsLoadError ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-semibold text-danger" role="alert">
            <span>프로그램 목록을 불러오지 못했습니다: {programsLoadError}</span>
            <Button size="sm" variant="secondary" onClick={() => requestDataKeys(["programs"], true)}>다시 시도</Button>
          </div>
        ) : null}
        {selected ? (
          // key: 프로그램을 바꾸면 초안이 다른 프로그램 본문으로 남지 않는다(교차 오염 차단).
          <ProgramColdMailEditor key={selected.id} program={selected} refresh={async () => { requestDataRefresh(); }} />
        ) : (
          <p className="rounded-md bg-fill px-3 py-3 text-xs text-ink-3">
            프로그램을 고르면 저장된 원본을 불러옵니다. 프로그램 상세 화면에서는 미리보기만 제공합니다.
          </p>
        )}
      </div>
    </Card>
  );
}
