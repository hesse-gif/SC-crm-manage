// 전 화면 공용 목업 데이터. 실제 데이터/API 없음(껍데기). inflychat 자체 DB 신규 구축 가정.
// 비용/원문은 데모용 더미. 운영 전환 시 SEC-P0-009(원문 비노출)·SEC-P0-004(Functions 경유) 적용 대상.

export type Stage = "contact" | "negotiation" | "contract" | "review" | "live";
export type GuideStatus = "within" | "near" | "over";
export type Platform = "YouTube" | "Instagram" | "TikTok" | "X" | "Reddit" | "Discord" | "Web";

export const STAGES: { key: Stage; label: string; tone: "info" | "accent" | "warn" | "ai" | "ok" }[] = [
  { key: "contact", label: "컨택", tone: "info" },
  { key: "negotiation", label: "협의", tone: "ai" },
  { key: "contract", label: "계약", tone: "accent" },
  { key: "review", label: "검수", tone: "warn" },
  { key: "live", label: "운영중", tone: "ok" },
];

export const stageLabel = (s: Stage) => STAGES.find((x) => x.key === s)?.label ?? s;

export function fmtKRW(n: number): string {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}억`;
  if (n >= 10000) return `${(n / 10000).toLocaleString()}만`;
  return n.toLocaleString();
}
export function fmtFollowers(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}만`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}천`;
  return `${n}`;
}

// ── 대시보드 KPI ───────────────────────────────────────────
export const KPIS = [
  { label: "진행 중 협업", value: "37", delta: "+6", tone: "ok" as const },
  { label: "AI 자동 처리 비율", value: "62%", delta: "+8%p", tone: "ai" as const },
  { label: "검수 대기", value: "5", delta: "-2", tone: "warn" as const },
  { label: "사람 검수 필요(에스컬레이션)", value: "2", delta: "+2", tone: "danger" as const },
];
