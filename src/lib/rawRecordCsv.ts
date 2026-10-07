// 원본 데이터 화면의 CSV 내보내기 직렬화.
//
// 화면에 이미 떠 있는(=이미 Functions 경유로 읽어온) 행을 그대로 파일로 저장한다. 서버 왕복도,
// 새 callable 도, Firestore 쓰기도 없다. 예전 "CSV 내보내기" 버튼은 onClick 이 아예 없었다.
import type { RawRecord } from "./data";

export const RAW_RECORD_CSV_COLUMNS = [
  "시간",
  "유형",
  "대상",
  "담당자",
  "상태",
  "금액",
  "채널",
  "참조",
] as const;

export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildRawRecordCsv(
  rows: readonly RawRecord[],
  creatorNameById: ReadonlyMap<string, string>,
): string {
  const lines = [RAW_RECORD_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push([
      row.time,
      row.type,
      creatorNameById.get(row.creatorId) ?? row.creatorId,
      row.owner,
      row.status,
      row.amountKRW ?? "",
      row.channel ?? "",
      row.ref,
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string) {
  // BOM 을 붙여야 Excel 이 한글을 깨뜨리지 않는다.
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  // Firefox 는 문서에 붙지 않은 anchor 의 click() 을 무시한다 — 반드시 append 후 클릭한다.
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Safari 는 같은 틱에 revoke 하면 다운로드가 시작되기 전에 blob 이 사라진다 — 다음 틱에 해제한다.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
