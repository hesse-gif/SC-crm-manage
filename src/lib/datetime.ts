// 발송/수신 시각 표시는 전부 이 헬퍼를 경유한다 — 한국시간(KST, Asia/Seoul) 고정.
// 서버에 저장되는 sentAtIso/receivedAtIso 등은 UTC ISO이므로, 화면 표기는 항상 KST로 변환한다.

const KST_PARTS = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// ISO 시각 문자열을 "YYYY-MM-DD HH:mm KST"로 변환. 비어있거나 파싱 불가면 fallback.
export function formatKst(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  const parts = KST_PARTS.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  if (!parts.year || !parts.hour) return fallback;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} KST`;
}
