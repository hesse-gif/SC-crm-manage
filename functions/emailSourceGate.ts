/**
 * 이메일 백필(digging) **쓰기 게이트** — 저장 직전 최종 주소가 **전체 정규화 원문**에 독립 토큰으로 실재해야 한다.
 *
 * 추출기의 위생(TLD 접두 절단 `.comm`→`.com`, 난독화 접기, 조각 판정)은 패턴별로 새는 곳이 계속 나왔다. 그래서 패턴 단위가 아니라
 * 구조로 닫는다: **정리가 끝난 정확한 최종 주소**를 원문과 대조한다. 신원을 바꾸는 정리(`gmail.comm`→`gmail.com`)·잘린 도메인
 * (`gmail.com[dot]vn`)·글자/숫자/`.`+영숫자/`@` 로 이어지는 꼬리는 전부 거부된다. 라이브 발굴 추출기는 건드리지 않는다.
 *
 * 정규화(원문 **전체**, 미리 자르지 않는다): 스타일/전각/엔티티/제로폭 접기 → NFKC → 모든 유니코드 공백(NBSP·탭·개행)을 한 칸으로
 * → 소문자. 대조 뷰는 난독화(`[at]`·`(dot)`·` dot `·アットマーク)를 접은 뷰다 — 난독화로 적힌 정상 주소가 실재 판정에서 떨어지지 않게.
 */
import { VALID_TLDS, foldStyledEmailText } from "./discovery";

export type SourceGateReason = "absent" | "left_boundary" | "right_continuation";

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

/**
 * 원문 전체 정규화 + 난독화 접기(대조 전용 뷰). **대소문자를 보존**한다 — 오른쪽 문맥 판정이 "소문자 TLD 단어"와 문장 시작
 * 대문자 단어(`x@y.com. My channel`)를 구별해야 하기 때문이다. 주소 대조는 소문자 사본에서 한다.
 */
export function normalizeEmailSource(text: string): string {
  const base = foldStyledEmailText(text)
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/gu, " ");
  return base
    .replace(/ ?[\[\(\{<] ?(?:アットマーク|アット|あっとまーく) ?[\]\)\}>] ?|(?<=[a-zA-Z0-9._%+-]) ?(?:アットマーク|アット|あっとまーく) ?/g, "@")
    .replace(/ ?[\[\(\{<] ?(?:at|@) ?[\]\)\}>] ?/gi, "@")
    .replace(/ ?[\[\(\{<] ?(?:dot|\.) ?[\]\)\}>] ?/gi, ".")
    .replace(/ dot (?=[a-zA-Z0-9])/gi, ".")
    .replace(/(?<=[a-zA-Z0-9._%+-]) @ (?=[a-zA-Z0-9-]+\.[a-zA-Z])/g, "@")
    .replace(/(?<=[a-zA-Z0-9._%+-]) at (?=[a-zA-Z0-9-]+\.[a-zA-Z])/gi, "@");
}

/**
 * 주소 오른쪽 문맥이 도메인/주소 **이어짐**인가(대소문자 보존 문맥):
 *  · 바로 이어지는 영숫자/주소 문자, `.`+영숫자(공백 없이), 바로 이어지는 `@`(공백 한 칸 뒤 `@` 포함)
 *  · (a) 공백 뒤 점 표기 + 영숫자(`addr .vn`, `addr . vn`)
 *  · (b) 점 표기 + 선택적 공백 + **전부 소문자** 유효 TLD 단어 + 경계(`addr. vn`) — 문장 시작 대문자 단어/TLD 가 아닌 단어(`. Thanks`, `. My channel`)는 살린다.
 *    문장이 소문자 TLD 단어로 시작하면(`x@y.com. my`) 거부 — fail-closed 비용으로 받아들인다.
 */
function continuesAddress(rest: string): boolean {
  if (/^[a-zA-Z0-9_%+\-]/.test(rest) || /^[.。｡][a-zA-Z0-9]/.test(rest) || /^ ?@/.test(rest)) return true;
  if (/^ [.。｡] ?[a-zA-Z0-9]/.test(rest)) return true;
  const word = /^[.。｡] ?([a-z]{2,24})(?![a-zA-Z0-9])/.exec(rest);
  return word !== null && VALID_TLDS.has(word[1]);
}

/** 정규화된(대소문자 보존) 원문에서 `email`(최종 주소)이 독립 토큰으로 실재하는가. 아니면 사유. */
export function emailSourceGateReason(email: string, normalizedSource: string): SourceGateReason | null {
  const needle = email.trim().toLowerCase();
  if (!needle) return "absent";
  const lowered = normalizedSource.toLowerCase();
  // 소문자화가 길이를 바꾸는 드문 문자가 있으면 오프셋이 어긋난다 — 그때는 소문자 사본 문맥으로 판정한다(더 보수적: TLD 가 아닌 대문자 단어도 소문자가 된다).
  const context = lowered.length === normalizedSource.length ? normalizedSource : lowered;
  let from = 0;
  let sawAny = false;
  let leftBad = false;
  let rightBad = false;
  for (;;) {
    const at = lowered.indexOf(needle, from);
    if (at < 0) break;
    sawAny = true;
    from = at + 1;
    const left = at === 0 ? "" : lowered[at - 1];
    if (left && /[a-z0-9._%+\-@]/.test(left)) { leftBad = true; continue; }
    if (continuesAddress(context.slice(at + needle.length))) { rightBad = true; continue; }
    return null;
  }
  if (!sawAny) return "absent";
  return leftBad && !rightBad ? "left_boundary" : "right_continuation";
}

export type SourceGate = { readonly check: (email: string) => SourceGateReason | null };

/** 같은 원문에 여러 주소를 대조할 때 정규화를 한 번만 한다. */
export function createEmailSourceGate(sourceText: string): SourceGate {
  const normalized = normalizeEmailSource(sourceText);
  return { check: (email) => emailSourceGateReason(email, normalized) };
}

/** 게이트를 통과한 주소만 남긴다. 거부 사유는 `onReject` 로 알린다(계측용). */
export function filterByEmailSource(emails: readonly string[], gate: SourceGate, onReject?: (reason: SourceGateReason) => void): string[] {
  const kept: string[] = [];
  for (const email of emails) {
    const reason = gate.check(email);
    if (reason) onReject?.(reason);
    else kept.push(email);
  }
  return kept;
}
