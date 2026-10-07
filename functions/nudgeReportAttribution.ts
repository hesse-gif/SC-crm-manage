/**
 * W81 — 전일 리포트의 **콜드 / 독려 귀속 규칙**.
 *
 * ■ 왜 필요한가
 *   지금까지 리포트의 Apply·영상 제출은 "콜드 아웃리치 성과"로만 셌다. 그런데 독려(기접촉
 *   팔로업)가 라이브가 되면 같은 사람이 콜드도 받고 독려도 받는다 — 그대로 두면 독려가 만든
 *   전환이 콜드 실적으로 계상되고(이중 계상), 두 레인 중 무엇이 듣는지 판단할 수 없다.
 *
 * ■ 규칙(헤세 확정): **라스트터치 · 7일 창**
 *   전환 이벤트(apply/영상 제출)마다 그 이메일의 **마지막 접촉 메일**을 찾는다.
 *     · 그 접촉이 이벤트보다 앞서고 7일 이내면 → 그 레인(콜드 or 독려)에 귀속
 *     · 창 밖이거나 접촉 기록이 없으면 → 어느 레인에도 귀속하지 않는다(무귀속)
 *   콜드 섹션의 Apply 에서 독려 귀속분을 빼는 것이 아니라, **애초에 라스트터치로 한 번만**
 *   센다. 빼기 방식은 같은 사람이 여러 번 전환하면 음수가 되거나 순서에 의존한다.
 *
 * ■ 순수 함수인 이유
 *   귀속은 리포트의 숫자를 정하는 규칙이다. Firestore 를 끼고 만들면 값으로 검증할 수 없고,
 *   "콜드만 / 독려만 / 양쪽 7일 내 / 창 밖" 네 형상을 계약으로 못박을 수 없다.
 */

/** 접촉 레인. 코호트②(기존 재촉 레인)도 독려로 편입한다(헤세 확정). */
export type ContactLane = "cold" | "nudge";

export type ContactEvent = {
  /**
   * 귀속 조인 키. W82 이후로는 **이메일 평문이 아니라 해시**다 —
   * 전환 경로가 원문 이메일을 의도적으로 안 싣기 때문이다(프라이버시 계약).
   * 값 자체는 불투명해도 되고, 같은 사람이면 같기만 하면 된다.
   */
  readonly email: string;
  readonly lane: ContactLane;
  readonly sentAtMs: number;
};

export type ConversionEvent = {
  readonly email: string;
  readonly atMs: number;
};

/** 라스트터치 귀속 창 — 헤세 확정 7일. */
export const NUDGE_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type AttributionResult = {
  readonly cold: number;
  readonly nudge: number;
  /** 창 밖이거나 접촉 기록이 없어 어느 레인에도 못 붙인 전환. 숨기지 않고 센다. */
  readonly unattributed: number;
};

/**
 * 조인 키 정규화. 이메일이면 소문자·trim, 해시면 그대로 소문자.
 * 두 축이 섞여 들어오면 조인이 조용히 갈리므로 호출부가 **한 축만** 넣어야 한다.
 */
export function normalizeAttributionEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * 이메일별 **마지막 접촉**을 뽑는다. 같은 시각이면 독려를 우선한다 —
 * 독려는 정의상 콜드 이후의 팔로업이고, 동시각은 배치 적재로 생기는 인공물이다.
 */
export function lastTouchByEmail(contacts: readonly ContactEvent[]): Map<string, ContactEvent> {
  const byEmail = new Map<string, ContactEvent>();
  for (const contact of contacts) {
    const email = normalizeAttributionEmail(contact.email);
    if (!email || !Number.isFinite(contact.sentAtMs)) continue;
    const current = byEmail.get(email);
    if (!current) {
      byEmail.set(email, { ...contact, email });
      continue;
    }
    if (contact.sentAtMs > current.sentAtMs) {
      byEmail.set(email, { ...contact, email });
      continue;
    }
    if (contact.sentAtMs === current.sentAtMs && contact.lane === "nudge") {
      byEmail.set(email, { ...contact, email });
    }
  }
  return byEmail;
}

/**
 * 전환 이벤트를 레인별로 귀속한다.
 *
 * 접촉은 **이벤트 이전**이어야 한다. 이벤트 뒤에 온 메일이 그 이벤트를 만들었을 리 없는데,
 * 마지막 접촉만 보고 붙이면 "지원한 사람에게 독려를 보냈더니 지원이 독려 실적이 되는" 역인과가
 * 생긴다(실제로 일어난다 — 독려는 미지원자 대상이지만 판정과 발송 사이에 지원이 들어온다).
 */
export function attributeConversions(
  conversions: readonly ConversionEvent[],
  contacts: readonly ContactEvent[],
  windowMs: number = NUDGE_ATTRIBUTION_WINDOW_MS,
): AttributionResult {
  const lastTouch = lastTouchByEmail(contacts);
  let cold = 0;
  let nudge = 0;
  let unattributed = 0;
  for (const conversion of conversions) {
    const email = normalizeAttributionEmail(conversion.email);
    const touch = email ? lastTouch.get(email) : undefined;
    if (!touch || !Number.isFinite(conversion.atMs)) {
      unattributed += 1;
      continue;
    }
    const gap = conversion.atMs - touch.sentAtMs;
    if (gap < 0 || gap > windowMs) {
      unattributed += 1;
      continue;
    }
    if (touch.lane === "nudge") nudge += 1;
    else cold += 1;
  }
  return { cold, nudge, unattributed };
}

/**
 * 라스트터치가 **이벤트 이전 접촉 중에서** 정해져야 하는 경우를 위한 정밀 귀속.
 *
 * `attributeConversions` 는 전체 기간의 마지막 접촉을 쓴다(리포트 창이 하루라 대부분 같다).
 * 누계 구간처럼 접촉이 이벤트 뒤에도 있는 창에서는 이 함수를 쓴다 — 이벤트 시각 이전의
 * 접촉만 후보로 놓고 그중 마지막을 고른다.
 */
export function attributeConversionsPrecise(
  conversions: readonly ConversionEvent[],
  contacts: readonly ContactEvent[],
  windowMs: number = NUDGE_ATTRIBUTION_WINDOW_MS,
): AttributionResult {
  const byEmail = new Map<string, ContactEvent[]>();
  for (const contact of contacts) {
    const email = normalizeAttributionEmail(contact.email);
    if (!email || !Number.isFinite(contact.sentAtMs)) continue;
    const list = byEmail.get(email) ?? [];
    list.push({ ...contact, email });
    byEmail.set(email, list);
  }
  for (const list of byEmail.values()) {
    // 시각 오름차순, 동시각이면 독려가 뒤로(마지막으로 선택되게).
    list.sort((left, right) => left.sentAtMs - right.sentAtMs
      || (left.lane === "nudge" ? 1 : 0) - (right.lane === "nudge" ? 1 : 0));
  }

  let cold = 0;
  let nudge = 0;
  let unattributed = 0;
  for (const conversion of conversions) {
    const email = normalizeAttributionEmail(conversion.email);
    const list = email ? byEmail.get(email) : undefined;
    if (!list || !Number.isFinite(conversion.atMs)) {
      unattributed += 1;
      continue;
    }
    let chosen: ContactEvent | null = null;
    for (const contact of list) {
      if (contact.sentAtMs > conversion.atMs) break;
      chosen = contact;
    }
    if (!chosen || conversion.atMs - chosen.sentAtMs > windowMs) {
      unattributed += 1;
      continue;
    }
    if (chosen.lane === "nudge") nudge += 1;
    else cold += 1;
  }
  return { cold, nudge, unattributed };
}
