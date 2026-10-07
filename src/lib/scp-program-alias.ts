// SCP 프로그램 별칭 통일(공유 계약) — "scp"(레거시 짧은 별칭)와
// "pg-super-creator-partners"(실 프로그램 문서 ID)는 같은 프로그램을 가리킨다.
// 신규 선택지/집계는 canonical만 노출하고, 레거시 값은 읽기 시 정규화해 동일 취급한다
// (문서 ID 자체는 불변 — dual-read).
export const SCP_PROGRAM_ALIAS_IDS = ["scp", "pg-super-creator-partners"] as const;

export const canonicalScpProgramId: (typeof SCP_PROGRAM_ALIAS_IDS)[number] = "pg-super-creator-partners";

const ALIAS_SET = new Set<string>(SCP_PROGRAM_ALIAS_IDS);

/** programId가 SCP 프로그램 별칭 집합(scp / pg-super-creator-partners) 중 하나인지 판정. */
export function isScpProgramId(programId: unknown): boolean {
  if (typeof programId !== "string") return false;
  return ALIAS_SET.has(programId.trim().toLowerCase());
}

/** 별칭이면 canonical id로, 아니면 원값(trim)을 그대로 반환. */
export function normalizeScpProgramId(programId: string): string {
  const trimmed = typeof programId === "string" ? programId.trim() : "";
  return ALIAS_SET.has(trimmed.toLowerCase()) ? canonicalScpProgramId : trimmed;
}

/** SCP 계열 프로그램 휴리스틱 — 별칭 집합 + 관례 패턴(scp- 접두, -scp/_scp 포함, scp 종결).
 * 서버 aggregate와 클라 programs/필터가 반드시 같은 판정을 써야 한다(판정 fork 금지). */
export function isScpLikeProgramId(programId: unknown): boolean {
  if (typeof programId !== "string") return false;
  const normalized = programId.trim().toLowerCase();
  if (!normalized) return false;
  if (ALIAS_SET.has(normalized)) return true;
  return normalized.startsWith("scp-") || normalized.includes("_scp") || normalized.includes("-scp") || normalized.endsWith("scp");
}
