"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { acknowledgeVideoResultMailDeadLetterAlert } from "@/lib/data";
import { publicCallableErrorMessage, requestDataRefresh } from "@/lib/live";
import { useRole } from "@/lib/role";
import { useViewAs } from "@/lib/viewAs";
import {
  resultMailAlertAction,
  resultMailAlertMeta,
  type ResultMailAlertAcknowledgement,
} from "@/modules/review/resultMailAlert";

export function VideoResultMailAlertControl({
  submission,
  acknowledgement,
  onChanged,
  onAcknowledgementChanged,
}: {
  submission: unknown;
  acknowledgement?: ResultMailAlertAcknowledgement | null;
  onChanged?: () => Promise<void> | void;
  onAcknowledgementChanged?: (acknowledgement: ResultMailAlertAcknowledgement) => void;
}) {
  const meta = resultMailAlertMeta(submission, acknowledgement);
  const action = resultMailAlertAction(submission, acknowledgement);
  const { role } = useRole();
  const { isViewingAs: viewAsFlagActive } = useViewAs();
  const isReadOnlyViewAs = role === "super_admin" && viewAsFlagActive;
  const readOnlyReason = isReadOnlyViewAs ? "대신 보기 중에는 결과메일 실패 확인 상태를 변경할 수 없습니다." : "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!meta || !action) return null;
  const nextAcknowledged = !action.acknowledged;
  async function submit() {
    if (busy || !action || action.disabledReason) return;
    if (readOnlyReason) {
      setError(readOnlyReason);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const envelope = await acknowledgeVideoResultMailDeadLetterAlert({
        outboxId: action.outboxId,
        acknowledged: nextAcknowledged,
      });
      onAcknowledgementChanged?.({
        outboxId: envelope.outboxId,
        submissionId: envelope.submissionId,
        acknowledged: envelope.acknowledged,
        acknowledgedAtIso: envelope.acknowledgedAtIso,
      });
      await onChanged?.();
      requestDataRefresh();
    } catch (caught) {
      setError(publicCallableErrorMessage(caught, "결과메일 실패 확인 상태를 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-xl border border-line bg-fill px-3 py-2 text-xs text-ink-3" data-testid="video-result-mail-alert-control">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-ink-2">{meta.label}</span>
        <Button
          size="sm"
          variant="secondary"
          className="h-8"
          disabled={busy || Boolean(action.disabledReason) || Boolean(readOnlyReason)}
          onClick={() => void submit()}
        >
          {busy ? "저장 중" : action.acknowledged ? "확인 취소" : "확인 처리"}
        </Button>
      </div>
      {action.disabledReason ? <p className="mt-1 text-warn">{action.disabledReason}</p> : null}
      {readOnlyReason ? <p className="mt-1 text-warn">{readOnlyReason}</p> : null}
      {error ? <p className="mt-1 text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
