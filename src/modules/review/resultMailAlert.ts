export type ResultMailAlertTone = "warn" | "danger";
export type ResultMailAlertMeta = { label: string; tone: ResultMailAlertTone };
export type ResultMailAlertAction = { outboxId: string; acknowledged: boolean; disabledReason: string };

export type ResultMailAlertScanStatus = {
  status: "ok" | "incomplete" | "unavailable";
  scanned: number;
  limit: number;
  pages: number;
  reason?: string;
};

export type ResultMailAlertAcknowledgement = {
  outboxId: string;
  submissionId: string;
  acknowledged: boolean;
  acknowledgedAtIso: string | null;
  acknowledgedBy?: string | null;
  acknowledgedByRole?: string | null;
  acknowledgedReason?: string | null;
};

type AnyRecord = Record<string, unknown>;

function record(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function postDecisionStatusOf(submission: unknown): AnyRecord {
  return record(record(submission).postDecisionStatus);
}

function activeAlertOf(submission: unknown): AnyRecord | null | undefined {
  const status = postDecisionStatusOf(submission);
  if (!Object.prototype.hasOwnProperty.call(status, "resultMailAlert")) return undefined;
  const alert = status.resultMailAlert;
  return alert === null ? null : record(alert);
}

function serverAcknowledgementOf(submission: unknown): ResultMailAlertAcknowledgement | null {
  const acknowledgement = record(postDecisionStatusOf(submission).resultMailAcknowledgement);
  const outboxId = text(acknowledgement.outboxId);
  const submissionId = text(acknowledgement.submissionId);
  if (!outboxId || !submissionId || acknowledgement.acknowledged !== true) return null;
  return {
    outboxId,
    submissionId,
    acknowledged: true,
    acknowledgedAtIso: text(acknowledgement.acknowledgedAtIso) || null,
    acknowledgedBy: text(acknowledgement.acknowledgedBy) || null,
    acknowledgedByRole: text(acknowledgement.acknowledgedByRole) || null,
    acknowledgedReason: text(acknowledgement.acknowledgedReason) || null,
  };
}

function effectiveAcknowledgement(
  submission: unknown,
  localAcknowledgement?: ResultMailAlertAcknowledgement | null,
): ResultMailAlertAcknowledgement | null {
  return localAcknowledgement ?? serverAcknowledgementOf(submission);
}

function metaForActiveAlert(alert: AnyRecord): ResultMailAlertMeta {
  const deliveryState = text(alert.deliveryState);
  if (deliveryState === "dead_letter") return { label: "결과메일 실패(재시도 중단)", tone: "danger" };
  if (deliveryState === "retryable_failed") return { label: "결과메일 실패(재시도 예정)", tone: "warn" };
  return { label: "결과메일 상태 확인 필요", tone: "warn" };
}

export function resultMailAlertMeta(
  submission: unknown,
  acknowledgement?: ResultMailAlertAcknowledgement | null,
): ResultMailAlertMeta | null {
  const postDecisionStatus = postDecisionStatusOf(submission);
  if (Object.keys(postDecisionStatus).length === 0) return null;
  const alert = activeAlertOf(submission);
  if (alert && Object.keys(alert).length > 0) return metaForActiveAlert(alert);
  const effective = effectiveAcknowledgement(submission, acknowledgement);
  if (effective?.acknowledged && effective.outboxId) {
    return { label: "결과메일 실패 확인됨", tone: "warn" };
  }
  if (alert === undefined) return { label: "결과메일 상태 확인 불가", tone: "warn" };
  return null;
}

export function resultMailAlertAction(
  submission: unknown,
  acknowledgement?: ResultMailAlertAcknowledgement | null,
): ResultMailAlertAction | null {
  const alert = activeAlertOf(submission);
  if (alert && Object.keys(alert).length > 0) {
    const outboxId = text(alert.outboxId);
    if (!outboxId) return null;
    const deliveryState = text(alert.deliveryState);
    if (deliveryState !== "dead_letter") {
      return { outboxId, acknowledged: false, disabledReason: "재시도 예정 상태는 확인 처리 대상이 아닙니다." };
    }
    return { outboxId, acknowledged: false, disabledReason: "" };
  }
  const effective = effectiveAcknowledgement(submission, acknowledgement);
  if (effective?.acknowledged && effective.outboxId) {
    return { outboxId: effective.outboxId, acknowledged: true, disabledReason: "" };
  }
  return null;
}


export function pickResultMailAlertScanStatus(
  current: ResultMailAlertScanStatus | null,
  next: ResultMailAlertScanStatus,
): ResultMailAlertScanStatus {
  const priority: Record<ResultMailAlertScanStatus["status"], number> = {
    ok: 0,
    incomplete: 1,
    unavailable: 2,
  };
  if (!current) return next;
  return priority[next.status] > priority[current.status] ? next : current;
}

export function resultMailAlertScanMessage(scan: ResultMailAlertScanStatus | null | undefined): string {
  if (!scan || scan.status === "ok") return "";
  const scope = `스캔 ${scan.scanned}/${scan.limit} · ${scan.pages}쪽`;
  const reason = scan.reason ? ` · ${scan.reason}` : "";
  if (scan.status === "unavailable") {
    return `결과메일 실패 조회를 완료하지 못했습니다. 실패 0건 또는 전체 정상으로 해석하지 마세요. ${scope}${reason}`;
  }
  return `결과메일 실패 조회가 일부만 완료되었습니다. 실패 0건 또는 전체 정상으로 해석하지 마세요. ${scope}${reason}`;
}
