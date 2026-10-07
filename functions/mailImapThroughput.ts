export const MIN_IMAP_BATCH_SIZE = 1;
export const DEFAULT_IMAP_BATCH_SIZE = 50;
export const MAX_IMAP_BATCH_SIZE = 200;

export const DEFAULT_IMAP_MAX_RUN_SECONDS = 240;
export const MAX_IMAP_MAX_RUN_SECONDS = 240;

function finitePositiveInteger(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

export function resolveImapBatchSize(value: unknown): number {
  const numeric = finitePositiveInteger(value);
  if (numeric === null) return DEFAULT_IMAP_BATCH_SIZE;
  return Math.max(MIN_IMAP_BATCH_SIZE, Math.min(numeric, MAX_IMAP_BATCH_SIZE));
}

/**
 * The setting is the hard per-run ceiling. An explicit caller limit may only
 * reduce it; omitted or invalid caller limits inherit the configured ceiling.
 */
export function resolveImapRunLimit(
  requestedLimit: unknown,
  configuredBatchSize: unknown,
): number {
  const configured = resolveImapBatchSize(configuredBatchSize);
  const requested = finitePositiveInteger(requestedLimit);
  return requested === null
    ? configured
    : Math.min(configured, Math.max(MIN_IMAP_BATCH_SIZE, Math.min(requested, MAX_IMAP_BATCH_SIZE)));
}

export function resolveImapMaxRunSeconds(value: unknown): number {
  const numeric = finitePositiveInteger(value);
  if (numeric === null) return DEFAULT_IMAP_MAX_RUN_SECONDS;
  return Math.max(1, Math.min(numeric, MAX_IMAP_MAX_RUN_SECONDS));
}

// W76-A: "빈 성공"(ok:true, fetched:0)이 커서 오염(있는 메일을 못 보는 상태)을 가리면 안 된다.
// 0이면 격차를 하나라도 관측 즉시 경고로 승격한다(기본값) — 운영자가 settings.email.imap로 완화 가능.
export const DEFAULT_IMAP_CURSOR_GAP_ALERT_THRESHOLD = 0;
export const MAX_IMAP_CURSOR_GAP_ALERT_THRESHOLD = 10_000;

export function resolveImapCursorGapAlertThreshold(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  if (numeric === null) return DEFAULT_IMAP_CURSOR_GAP_ALERT_THRESHOLD;
  return Math.min(numeric, MAX_IMAP_CURSOR_GAP_ALERT_THRESHOLD);
}
