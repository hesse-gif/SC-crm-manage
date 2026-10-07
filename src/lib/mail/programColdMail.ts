// W8-9: 프로그램 콜드메일 편집의 **공유 상수·판정**. 편집기는 SCP 자동화 > 메일 템플릿 탭으로
// 이설됐고, 프로그램 상세 모달은 미리보기만 남는다. 두 화면이 같은 값을 보게 하려고 사본 대신
// 이 모듈을 쓴다(정본은 여전히 programs/{id}.coldMail 문서 + updateProgramColdMail 콜러블이다).
import type { MailBodyFormat, Program } from "@/lib/data";

export const COLD_MAIL_COUNTRY_OPTIONS: { code: string; label: string }[] = [
  { code: "US", label: "미국 (English)" },
  { code: "BR", label: "브라질 (Português)" },
  { code: "JP", label: "일본 (日本語)" },
  { code: "ID", label: "인도네시아 (Indonesia)" },
  { code: "ES", label: "스페인 (Español)" },
  { code: "VN", label: "베트남 (Tiếng Việt)" },
  { code: "TH", label: "태국 (ไทย)" },
  { code: "DE", label: "독일 (Deutsch)" },
  { code: "FR", label: "프랑스 (Français)" },
];

export const COLD_MAIL_BODY_FORMAT_OPTIONS: Array<{ value: MailBodyFormat; label: string }> = [
  { value: "markdown", label: "마크다운" },
  { value: "text", label: "일반 텍스트" },
  { value: "html", label: "HTML 직접 작성" },
];

export const PROGRAM_COLD_MAIL_PREVIEW_VALUES = {
  name: "Sample Creator",
  creator: "Sample Creator",
  game: "Super Creator Partners",
  campaign: "Super Creator Partners",
  owner: "Supercent SCP",
  creatorName: "Sample Creator",
  channelName: "Sample Channel",
  gameTitle: "XP Hero",
  campaignName: "Super Creator Partners",
  country: "US",
  senderName: "Supercent",
};

export function programColdMailBodyFormat(program: Pick<Program, "coldMail"> | null | undefined): MailBodyFormat {
  const coldMail = program?.coldMail as unknown as Record<string, unknown> | undefined;
  return coldMail?.bodyFormat === "text" || coldMail?.bodyFormat === "html" ? coldMail.bodyFormat : "markdown";
}

/**
 * 편집기 초안 리셋 판정용 발행 신원. 저장된 콜드메일이 **실제로 바뀔 때만** 값이 달라진다 —
 * 배경 refresh 가 같은 내용의 새 객체를 커밋해도 작성 중인 초안을 날리지 않는다(W8-1d 와 같은 규칙).
 */
export function programColdMailIdentity(program: Pick<Program, "id" | "coldMail"> | null | undefined): string {
  const coldMail = program?.coldMail as unknown as Record<string, unknown> | undefined;
  const version = typeof coldMail?.version === "number" ? String(coldMail.version) : "";
  const hash = typeof coldMail?.contentHash === "string" ? coldMail.contentHash : "";
  return `${program?.id ?? ""}:${version}:${hash}`;
}
