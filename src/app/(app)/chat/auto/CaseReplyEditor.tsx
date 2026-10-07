"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  previewChatAutoCaseReply,
  resetChatAutoCaseReply,
  saveChatAutoCaseReply,
  suggestChatAutoCaseReply,
  type ChatAutoCasebookDefaultSuggestion,
  type ChatAutoCasebookReplyText,
  type PreviewChatAutoCaseReplyEnvelope,
  type SuggestChatAutoCaseReplyEnvelope,
} from "@/lib/data";
import { insertAtSelection, type CaseReplyLinkChoice } from "@/lib/casebookInbox";
import { callableBusinessErrorCode, publicCallableErrorMessage } from "@/lib/live";

const REPLY_MAX_LENGTH = 4_000;
const INSTRUCTION_MAX_LENGTH = 1_000;

export function CaseReplyEditor({
  caseId,
  replyText,
  canEdit,
  canSuggest,
  defaultSuggestion,
  linkChoices = [],
  onEngagedChange,
  onReload,
  onSaved,
}: {
  caseId: string;
  replyText: ChatAutoCasebookReplyText;
  canEdit: boolean;
  canSuggest: boolean;
  /** Background-precomputed suggestion from the snapshot (contract §1/§4). Absent on an older server. */
  defaultSuggestion?: ChatAutoCasebookDefaultSuggestion;
  /** "링크 넣기" choices for this case; empty hides the control. */
  linkChoices?: CaseReplyLinkChoice[];
  /** Reports whether the editor is open or holds unsaved text, so the list never hides it. */
  onEngagedChange?: (engaged: boolean) => void;
  onReload: (caseId: string) => Promise<ChatAutoCasebookReplyText | null>;
  onSaved: () => Promise<void>;
}) {
  const mountedRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const previewRequestRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [baseReply, setBaseReply] = useState(replyText);
  const [text, setText] = useState(replyText.text ?? "");
  const [operatorInstruction, setOperatorInstruction] = useState("");
  const [suggestion, setSuggestion] = useState<SuggestChatAutoCaseReplyEnvelope | null>(null);
  // Which suggestion ("manual:<text>" / "default:<text>") was last copied into the editor, so the
  // "반영됨" label never carries over to a different suggestion.
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ forText: string; result: PreviewChatAutoCaseReplyEnvelope } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [busy, setBusy] = useState<"save" | "suggest" | "reload" | "reset" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [versionConflict, setVersionConflict] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const savedText = baseReply.text ?? "";
  const dirty = text !== savedText;
  const editable = canEdit && replyText.editable && baseReply.editable;
  const canRequestSuggestion = canSuggest && replyText.suggestionAllowed && baseReply.suggestionAllowed;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Open or unsaved → the list must keep this row visible whatever the view filter says, so a filter
  // change or refresh can never unmount a human's unsaved text. Latest callback via ref: the parent
  // passes a fresh function every render.
  const engaged = open || dirty;
  const engagedChangeRef = useRef(onEngagedChange);
  useEffect(() => {
    engagedChangeRef.current = onEngagedChange;
  });
  useEffect(() => {
    engagedChangeRef.current?.(engaged);
  }, [engaged]);
  useEffect(() => () => engagedChangeRef.current?.(false), []);

  // Restore the caret after a link insertion (the textarea is controlled, so React re-applies the
  // value first).
  useEffect(() => {
    const caret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [text]);

  // A snapshot refresh can arrive while the editor is open. Keep unsaved human text, but advance
  // the CAS base when the user has not changed their text locally.
  useEffect(() => {
    if (dirty) return;
    setBaseReply(replyText);
    setText(replyText.text ?? "");
  }, [dirty, replyText]);

  const markConflict = () => {
    setVersionConflict(true);
    setError("");
  };

  async function reloadLatest() {
    if ((!canEdit && !canSuggest) || busy) return;
    setBusy("reload");
    setError("");
    try {
      const latest = await onReload(caseId);
      if (!mountedRef.current) return;
      if (!latest) {
        setError("최신 답신 상태를 불러오지 못했습니다. 작성한 내용은 그대로 남아 있습니다.");
        return;
      }
      setBaseReply(latest);
      setVersionConflict(false);
      setError("");
      setNotice("최신 저장 기준을 불러왔습니다. 작성한 답신은 보존했습니다.");
    } catch {
      if (mountedRef.current) setError("최신 답신 상태를 불러오지 못했습니다. 작성한 내용은 그대로 남아 있습니다.");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function requestSuggestion() {
    if (!canRequestSuggestion || busy || versionConflict || !baseReply.revisionHash) return;
    setBusy("suggest");
    setError("");
    setNotice("");
    setVersionConflict(false);
    setSuggestion(null);
    setAppliedKey(null);
    try {
      const result = await suggestChatAutoCaseReply({
        caseId,
        ...(operatorInstruction.trim() ? { operatorInstruction: operatorInstruction.trim() } : {}),
        expectedRevision: baseReply.revision,
        expectedRevisionHash: baseReply.revisionHash,
      });
      if (!mountedRef.current) return;
      setSuggestion(result);
    } catch (caught) {
      if (!mountedRef.current) return;
      if (callableBusinessErrorCode(caught) === "chat_auto_case_reply_revision_conflict") {
        markConflict();
      } else {
        setError(publicCallableErrorMessage(caught, "답신 제안을 만들지 못했습니다."));
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function saveReply() {
    if (!editable || busy || versionConflict || !dirty || !text.trim() || text.length > REPLY_MAX_LENGTH || !baseReply.revisionHash) return;
    setBusy("save");
    setError("");
    setNotice("");
    setVersionConflict(false);
    try {
      const result = await saveChatAutoCaseReply({
        caseId,
        text,
        expectedRevision: baseReply.revision,
        expectedRevisionHash: baseReply.revisionHash,
      });
      if (!mountedRef.current) return;
      setBaseReply(result.replyText);
      setText(result.replyText.text ?? text);
      setSuggestion(null);
      setAppliedKey(null);
      setVersionConflict(false);
      const savedAutoSendable = result.replyText.automaticStatus === "permit_gated";
      setNotice(result.permitState === "disarmed"
        ? savedAutoSendable
          ? "답신을 저장했습니다. 자동발송 승인은 해제되었습니다. 새 검증을 통과해 super_admin이 다시 승인하면 저장한 문구가 그대로 자동발송됩니다."
          : "답신을 저장했습니다. 편집한 답신은 사람 검토 후 발송되며, 자동발송 승인은 해제되었습니다."
        : savedAutoSendable
          ? "답신을 저장했습니다. 승인 전까지 이 답신은 사람 검토 후 발송됩니다."
          : "답신을 저장했습니다. 편집한 답신은 사람 검토 후 발송됩니다.");
      void onSaved().catch(() => {
        if (mountedRef.current) setNotice("답신을 저장했습니다. 최신 자동발송 상태를 새로 확인하지 못했습니다.");
      });
    } catch (caught) {
      if (!mountedRef.current) return;
      if (callableBusinessErrorCode(caught) === "chat_auto_case_reply_revision_conflict") {
        markConflict();
      } else {
        setError(publicCallableErrorMessage(caught, "답신을 저장하지 못했습니다."));
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function resetReply() {
    if (!editable || busy || versionConflict || baseReply.source !== "operator_override" || !baseReply.revisionHash) return;
    setBusy("reset");
    setError("");
    setNotice("");
    setVersionConflict(false);
    try {
      const result = await resetChatAutoCaseReply({
        caseId,
        expectedRevision: baseReply.revision,
        expectedRevisionHash: baseReply.revisionHash,
      });
      if (!mountedRef.current) return;
      setBaseReply(result.replyText);
      setText(result.replyText.text ?? "");
      setSuggestion(null);
      setAppliedKey(null);
      setConfirmReset(false);
      setVersionConflict(false);
      setNotice(result.permitState === "disarmed"
        ? "기본 답신 문구로 되돌렸습니다. 자동발송 승인은 해제된 상태입니다."
        : "기본 답신 문구로 되돌렸습니다. 발송은 되지 않았습니다.");
      void onSaved().catch(() => {
        if (mountedRef.current) setNotice("기본 답신 문구로 되돌렸습니다. 최신 자동발송 상태를 새로 확인하지 못했습니다.");
      });
    } catch (caught) {
      if (!mountedRef.current) return;
      if (callableBusinessErrorCode(caught) === "chat_auto_case_reply_revision_conflict") {
        markConflict();
      } else {
        setError(publicCallableErrorMessage(caught, "기본 답신 문구로 되돌리지 못했습니다."));
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  // "링크 넣기": inserts `{{TOKEN}}` at the textarea selection. Pure text edit — no server call, and
  // the server stays the judge of which tokens this case may use (preview/save validate it).
  function insertLink(token: string) {
    const textarea = textareaRef.current;
    if (!editable || busy !== null || !textarea) return;
    const result = insertAtSelection(text, textarea.selectionStart, textarea.selectionEnd, `{{${token}}}`, REPLY_MAX_LENGTH);
    setNotice("");
    if (!result) {
      setError(`글자 수 제한(${REPLY_MAX_LENGTH.toLocaleString("ko-KR")}자)을 넘어 링크를 넣을 수 없습니다.`);
      return;
    }
    setError("");
    pendingCaretRef.current = result.caret;
    setText(result.text);
  }

  // Read-only: no model call, no write, never touches the editor text or the CAS base.
  async function requestPreview() {
    if ((!canEdit && !canSuggest) || previewBusy || !text.trim()) return;
    previewRequestRef.current += 1;
    const requestId = previewRequestRef.current;
    const forText = text;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const result = await previewChatAutoCaseReply({ caseId, text: forText });
      if (!mountedRef.current || requestId !== previewRequestRef.current) return;
      setPreview({ forText, result });
    } catch (caught) {
      if (!mountedRef.current || requestId !== previewRequestRef.current) return;
      setPreview(null);
      setPreviewError(publicCallableErrorMessage(caught, "미리보기를 만들지 못했습니다."));
    } finally {
      if (mountedRef.current && requestId === previewRequestRef.current) setPreviewBusy(false);
    }
  }

  // One suggestion block at a time: an operator-requested (manual) suggestion replaces the
  // precomputed default; the default only ever fills the editor through the explicit apply click.
  const defaultReady = defaultSuggestion?.status === "ready" && defaultSuggestion.text ? defaultSuggestion : null;
  const defaultVisible = !suggestion && defaultSuggestion && defaultSuggestion.status !== "not_applicable" ? defaultSuggestion : null;
  const shownSuggestionKey = suggestion
    ? `manual:${suggestion.text}`
    : defaultReady ? `default:${defaultReady.text}` : null;
  const shownSuggestionText = suggestion ? suggestion.text : defaultReady ? defaultReady.text : null;
  // "편집창에 반영됨" only while the editor still holds exactly the applied suggestion — any edit
  // (or a different suggestion) returns the button to "제안 문구를 편집창에 넣기".
  const suggestionApplied = shownSuggestionKey !== null && appliedKey === shownSuggestionKey && text === shownSuggestionText;
  const previewStale = preview !== null && preview.forText !== text;

  const hasReplyActions = baseReply.editable || baseReply.suggestionAllowed;

  return (
    <div className="mt-3" data-testid={`case-reply-editor-${caseId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={replyStatusTone(baseReply.automaticStatus)}>{automaticStatusLabel(baseReply.automaticStatus)}</Badge>
        {baseReply.reviewRequired ? <Badge tone="warn">사람 검토 필요</Badge> : null}
        {hasReplyActions ? <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!canEdit && !canSuggest}
          title={canEdit || canSuggest ? undefined : "답신 편집 또는 AI 의견 요청 권한이 필요합니다."}
          onClick={() => {
            setOpen((current) => !current);
            setError("");
            setNotice("");
          }}
          data-testid={`case-reply-toggle-${caseId}`}
        >
          {open ? "답신 편집 닫기" : editable ? "답신 편집" : canRequestSuggestion ? "AI 의견 요청" : "답신 편집 · 조회 전용"}
        </Button> : null}
        <span className="text-[11px] text-ink-3">
          {baseReply.source === "operator_override" ? "운영자 저장본" : baseReply.source === "static" ? "기본 답신 문구" : "저장된 답신 없음"}
        </span>
      </div>

      {!hasReplyActions && baseReply.unavailableReason ? (
        <p className="mt-2 text-xs text-ink-3" data-testid={`case-reply-unavailable-${caseId}`}>
          {baseReply.unavailableReason}
        </p>
      ) : null}

      {open ? (
        <Card className="mt-3" data-testid={`case-reply-editor-panel-${caseId}`}>
          <div className="space-y-4 p-4">
            <p className="text-xs text-ink-3">
              {baseReply.automaticStatus === "permit_gated"
                ? "저장은 답신 문구만 게시합니다. 메일은 발송되지 않으며, 저장 후 자동발송 승인은 해제됩니다. 새 검증과 super_admin 승인을 마치면 저장한 문구가 그대로 자동발송됩니다."
                : "저장은 답신 문구만 게시합니다. 메일은 발송되지 않으며, 저장 후 자동발송 승인은 해제되고 사람 검토 상태로 유지됩니다."}
            </p>
            {replyText.unavailableReason ? (
              <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">{replyText.unavailableReason}</p>
            ) : null}

            <label className="block text-xs font-semibold text-ink-2">
              답신 문구
              <textarea
                ref={textareaRef}
                value={text}
                maxLength={REPLY_MAX_LENGTH}
                rows={6}
                onChange={(event) => {
                  setText(event.target.value);
                  setNotice("");
                }}
                disabled={!editable || busy !== null}
                placeholder="이 케이스에는 이렇게 답장하기"
                className="mt-1.5 w-full resize-y rounded-md border border-line bg-paper px-3 py-2 text-sm font-normal leading-6 text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none disabled:bg-fill disabled:text-ink-3"
                aria-label="저장할 답신 문구"
                data-testid={`case-reply-text-${caseId}`}
              />
              <span className="mt-1 block text-right font-normal text-ink-4">{text.length}/{REPLY_MAX_LENGTH}자</span>
            </label>

            <div className="flex flex-wrap items-center gap-2" data-testid={`case-reply-toolbar-${caseId}`}>
              {linkChoices.length > 0 ? (
                <>
                  <span className="text-xs font-semibold text-ink-2">링크 넣기</span>
                  {linkChoices.map((choice) => (
                    <Button
                      key={choice.token}
                      type="button"
                      size="sm"
                      variant="secondary"
                      className={choice.primary ? "border-accent text-accent" : undefined}
                      disabled={!editable || busy !== null || !choice.allowed}
                      title={choice.allowed
                        ? `{{${choice.token}}}${choice.url ? ` · ${choice.url}` : ""}`
                        : "이 케이스의 답신에는 쓸 수 없는 링크입니다."}
                      onClick={() => insertLink(choice.token)}
                      data-testid={`case-reply-link-${choice.token}-${caseId}`}
                    >
                      {choice.label}
                    </Button>
                  ))}
                </>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={previewBusy || !text.trim()}
                onClick={() => void requestPreview()}
                data-testid={`case-reply-preview-button-${caseId}`}
              >
                {previewBusy ? "미리보기 만드는 중" : "미리보기"}
              </Button>
            </div>

            {preview || previewError ? (
              <div className="rounded-md border border-line bg-fill p-3" data-testid={`case-reply-preview-${caseId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-bold text-ink">미리보기</h4>
                  <Badge tone="neutral">읽기 전용</Badge>
                  {previewStale ? <Badge tone="warn">편집 내용이 바뀌었습니다 · 다시 미리보기</Badge> : null}
                </div>
                {previewError ? <p className="mt-2 text-sm font-semibold text-danger" role="alert">{previewError}</p> : null}
                {preview ? (
                  <>
                    {!preview.result.valid ? (
                      <p className="mt-2 text-sm font-semibold text-danger" role="alert" data-testid={`case-reply-preview-error-${caseId}`}>
                        {preview.result.errorMessage ?? "이 문구로는 발송 문구를 만들 수 없습니다."}
                      </p>
                    ) : null}
                    {preview.result.resolvedText ? (
                      <p className="mt-2 whitespace-pre-wrap rounded-md bg-paper/80 px-3 py-2 text-sm leading-6 text-ink" data-testid={`case-reply-preview-text-${caseId}`}>
                        {preview.result.resolvedText}
                      </p>
                    ) : null}
                    {preview.result.links.length > 0 ? (
                      <ul className="mt-2 space-y-0.5 text-xs text-ink-2" data-testid={`case-reply-preview-links-${caseId}`}>
                        {preview.result.links.map((link) => (
                          <li key={link.token} className="break-all">
                            <span className="font-semibold">{link.label}</span> — {link.url}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="mt-2 text-[11px] text-ink-3">실제 발송 때와 같은 방식으로 링크를 바꿔 보여줍니다. 저장이나 발송은 되지 않습니다.</p>
                  </>
                ) : null}
              </div>
            ) : null}

            {defaultVisible ? (
              <div className="rounded-md border border-ai/20 bg-ai-soft p-3" data-testid={`case-reply-default-suggestion-${caseId}`} data-status={defaultVisible.status}>
                {defaultReady ? (
                  <>
                    <h4 className="text-sm font-bold text-ink">이렇게 답장할까요?</h4>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="ai">미리 준비된 제안</Badge>
                      {defaultReady.generatedAtIso ? (
                        <span className="text-xs text-ink-3">{formatGeneratedAt(defaultReady.generatedAtIso)} 생성</span>
                      ) : null}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap rounded-md bg-paper/80 px-3 py-2 text-sm leading-6 text-ink">{defaultReady.text}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={!editable || busy !== null || versionConflict}
                        title={editable ? undefined : "답신 편집 권한이 필요합니다."}
                        onClick={() => {
                          setText(defaultReady.text ?? "");
                          setAppliedKey(`default:${defaultReady.text}`);
                          setNotice("");
                        }}
                        data-testid={`case-reply-apply-default-${caseId}`}
                      >
                        {suggestionApplied ? "편집창에 반영됨" : "제안 문구를 편집창에 넣기"}
                      </Button>
                      <span className="text-[11px] text-ink-3">편집창에만 반영되며, 발송이나 저장은 따로 하지 않습니다.</span>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-ink-2" data-testid={`case-reply-default-status-${caseId}`}>
                    <span className="font-bold text-ink">미리 준비된 제안 · </span>
                    {defaultVisible.status === "stale"
                      ? "갱신 필요 · 곧 다시 만듭니다"
                      : defaultVisible.status === "pending"
                        ? "준비 중"
                        : canRequestSuggestion
                          ? "생성 실패 · 아래 \"AI 의견 요청\"으로 직접 만들 수 있습니다"
                          : "생성 실패"}
                  </p>
                )}
              </div>
            ) : null}

            {canRequestSuggestion ? (
              <div className="rounded-md bg-fill p-3">
                <label className="block text-xs font-semibold text-ink-2">
                  AI 의견을 위한 요청 (선택)
                  <textarea
                    value={operatorInstruction}
                    maxLength={INSTRUCTION_MAX_LENGTH}
                    rows={2}
                    onChange={(event) => setOperatorInstruction(event.target.value)}
                    disabled={busy !== null}
                    placeholder="예: 정산 일정은 확정하지 말고, 담당자가 확인해 안내한다고 답해 주세요."
                    className="mt-1.5 w-full resize-y rounded-md border border-line bg-paper px-3 py-2 text-sm font-normal text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none disabled:bg-fill-2"
                    aria-label="AI 답신 제안 요청"
                    data-testid={`case-reply-instruction-${caseId}`}
                  />
                  <span className="mt-1 block text-right font-normal text-ink-4">{operatorInstruction.length}/{INSTRUCTION_MAX_LENGTH}자</span>
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null || versionConflict || !baseReply.revisionHash || operatorInstruction.length > INSTRUCTION_MAX_LENGTH}
                    onClick={() => void requestSuggestion()}
                    data-testid={`case-reply-suggest-${caseId}`}
                  >
                    {busy === "suggest" ? "의견을 만드는 중" : "AI 의견 요청"}
                  </Button>
                  <span className="text-[11px] text-ink-3">제안은 저장되지 않습니다. 검토·저장 전에는 답신에 반영되지 않습니다.</span>
                </div>
              </div>
            ) : null}

            {suggestion ? (
              <div className="rounded-md border border-ai/20 bg-ai-soft p-3" data-testid={`case-reply-suggestion-${caseId}`}>
                <h4 className="text-sm font-bold text-ink">이렇게 답장할까요?</h4>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="ai">AI 제안</Badge>
                  {suggestion.cacheHit ? <Badge tone="neutral">저장된 제안</Badge> : null}
                  <span className="text-xs font-semibold text-ink-2">제공자: {providerLabel(suggestion.provider)}</span>
                </div>
                {suggestion.reason ? <p className="mt-2 text-xs text-ink-3">제안 이유: {suggestion.reason}</p> : null}
                <p className="mt-2 whitespace-pre-wrap rounded-md bg-paper/80 px-3 py-2 text-sm leading-6 text-ink">{suggestion.text}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null || versionConflict}
                    onClick={() => {
                      setText(suggestion.text);
                      setAppliedKey(`manual:${suggestion.text}`);
                      setNotice("");
                    }}
                    data-testid={`case-reply-apply-suggestion-${caseId}`}
                  >
                    {suggestionApplied ? "편집창에 반영됨" : "제안 문구를 편집창에 넣기"}
                  </Button>
                  <span className="text-[11px] text-ink-3">편집창에만 반영되며, 발송이나 저장은 따로 하지 않습니다.</span>
                </div>
              </div>
            ) : null}

            {editable && baseReply.source === "operator_override" ? (
              <div className="rounded-md border border-line px-3 py-2">
                {confirmReset ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-ink-2">저장한 답신과 편집 중인 내용을 지우고 기본 문구로 되돌릴까요? 발송은 되지 않습니다.</span>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        disabled={busy !== null || versionConflict}
                        onClick={() => void resetReply()}
                        data-testid={`case-reply-reset-confirm-${caseId}`}
                      >
                        {busy === "reset" ? "되돌리는 중" : "기본 문구로 되돌리기"}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={busy !== null || versionConflict} onClick={() => setConfirmReset(false)}>
                        취소
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button type="button" size="sm" variant="ghost" disabled={busy !== null || versionConflict} onClick={() => setConfirmReset(true)}>
                    기본 답신 문구로 되돌리기
                  </Button>
                )}
              </div>
            ) : null}

            {versionConflict ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn" role="status" data-testid={`case-reply-conflict-${caseId}`}>
                <span>최신 답신 기준이 바뀌었습니다. 작성한 답신은 보존되어 있습니다.</span>
                <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void reloadLatest()}>
                  {busy === "reload" ? "불러오는 중" : "최신 상태 불러오기"}
                </Button>
              </div>
            ) : null}
            {error ? <p className="text-sm font-semibold text-danger" role="alert">{error}</p> : null}
            {notice ? <p className="text-sm font-semibold text-ok" role="status">{notice}</p> : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
              <span className="text-[11px] text-ink-3">{baseReply.automaticStatus === "permit_gated" ? "승인 시 그대로 자동발송되는 저장본" : "사람 검토가 필요한 저장본"} · 수정 내용은 저장 버튼을 눌러야 게시됩니다.</span>
              <Button
                type="button"
                size="sm"
                disabled={!editable || busy !== null || versionConflict || !dirty || !text.trim() || text.length > REPLY_MAX_LENGTH || !baseReply.revisionHash}
                onClick={() => void saveReply()}
                data-testid={`case-reply-save-${caseId}`}
              >
                {busy === "save" ? "저장 중" : "검토 후 답신 저장"}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function automaticStatusLabel(status: ChatAutoCasebookReplyText["automaticStatus"]): string {
  if (status === "blocked") return "자동응답 차단";
  if (status === "permit_gated") return "자동발송 승인 필요";
  if (status === "no_reply") return "답신 없음";
  return "사람 검토 전용";
}

function replyStatusTone(status: ChatAutoCasebookReplyText["automaticStatus"]): "neutral" | "warn" | "danger" {
  if (status === "blocked") return "danger";
  if (status === "permit_gated") return "warn";
  return "neutral";
}

function formatGeneratedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ko-KR");
}

function providerLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "vertex" || normalized === "vertex_ai" || normalized === "google_vertex") return "Vertex AI";
  if (normalized === "ai-hub" || normalized === "ai_hub") return "AI Hub";
  if (normalized === "openai") return "OpenAI";
  if (normalized === "anthropic") return "Anthropic";
  if (normalized === "typesafe") return "TypeSafe";
  if (normalized === "unverified" || normalized === "") return "제공자 확인 불가";
  return provider.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
