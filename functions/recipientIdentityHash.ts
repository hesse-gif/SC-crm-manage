/**
 * W82 — **수신자 식별 해시의 정본.**
 *
 * ■ 왜 필요한가
 *   W81 이 전일 리포트에 라스트터치 귀속(콜드 vs 독려)을 넣었는데, 전환 원장
 *   (`scp_application_management`)에 수신자 식별자가 **하나도 없어** 계산이 불가능했다
 *   (프로드 실측 2026-08-14: identity 전 필드 null · revisions 0). 리포트가 "미측정"으로 나갔다.
 *
 * ■ 그런데 식별자는 이미 있었다 (W82 실측)
 *   같은 전환에 대해 생성되는 outbox 가 `applicationId` + `recipientEmailHash` 를 갖고 있다:
 *     scp_application_confirmed_mail_outbox  (Apply)
 *     scp_content_submitted_mail_outbox      (영상 제출)
 *   즉 **새 쓰기도 백필도 필요 없다.** applicationId 로 그 해시를 끌어오면 조인이 성립한다.
 *   실측 검증: 최근 전환 49건 중 콜드 접촉 13 · 독려 접촉 29 가 실제로 맞물린다.
 *
 * ■ 개인정보 축
 *   평문 이메일은 쓰지 않는다. 전환 경로(v3 receiver · v1 command)는 원문 이메일을 **의도적으로
 *   금지**하고 있고(명시적 denylist), 이 설계는 그 경계를 건드리지 않는다 — 해시만 오간다.
 *
 * ■ 길이를 24자로 통일하는 이유 (실측)
 *   · scp_coldmail_history.emailHash      : 24자
 *   · mail_outbound_log.toHash            : 24자
 *   · *_mail_outbox.recipientEmailHash    : **64자**
 *   전부 같은 sha256 이지만 길이가 다르다. 하나로 줄이지 않으면 조인이 전부 어긋난다.
 */
import { createHash } from "crypto";

/** 조인 키 길이. 접촉 원장이 이미 쓰는 형태다 — 바꾸면 기존 데이터와 안 맞는다. */
export const RECIPIENT_IDENTITY_HASH_LENGTH = 24;

/**
 * 수신자 이메일 → 조인용 해시.
 *
 * 정규화(trim + 소문자)를 반드시 거친다. 대소문자가 다른 같은 주소가 다른 키가 되면
 * 귀속이 조용히 갈라진다. 빈 입력은 빈 문자열을 돌려준다 —
 * 빈 해시를 만들어 "식별됐다"고 착각하게 만들지 않는다.
 */
export function recipientIdentityHash(email: unknown): string {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) return "";
  return createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, RECIPIENT_IDENTITY_HASH_LENGTH);
}

/**
 * 이미 저장된 해시(24자 또는 64자)를 조인 형태로 맞춘다.
 *
 * 앞 24자가 같다는 사실에 암묵적으로 기대지 않고 **명시적으로** 자른다.
 * 16진수 형태가 아니면 빈 문자열이다 — 형태가 어긋난 값이 조인 키가 되면 조용히 안 맞는다.
 */
export function toRecipientIdentityHash(storedHash: unknown): string {
  const value = typeof storedHash === "string" ? storedHash.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{24,64}$/.test(value)) return "";
  return value.slice(0, RECIPIENT_IDENTITY_HASH_LENGTH);
}
