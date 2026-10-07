// R17-6 [W9-3]: 전환율은 **표본이 임계를 넘을 때만** 숫자로 낸다.
//
// 실측 기준선이 발송 1,506 → 회신 12 → apply 1 → 파트너 활성 0 이다. 이 표본에서 %를 계산해 화면에
// 띄우면(1/1506 = 0.07%, 0/1 = 0%) 숫자가 사실처럼 읽히고 필요 발송량 역산까지 따라온다 — 날조다.
// 임계 미만이면 비율·예상치를 **아예 만들지 않고** "측정 중 (표본 N건)"만 보여준다.
//
// 판정을 순수함수로 두는 이유: 표시 여부를 화면 안에서 분기하면 값 단정이 불가능해지고, 이 레포에서
// 소스 문자열 가드는 세 번 우회됐다. 진리표로 고정한다.

/** 승인·활성 표본 임계. W9-3 이 정한 값(20건) — 이보다 적으면 비율을 계산하지 않는다. */
export const CONVERSION_SAMPLE_THRESHOLD = 20;

export type ConversionSampleState =
  | { measurable: true; sample: number; percent: number; label: string }
  | { measurable: false; sample: number; label: string };

/**
 * @param numerator 전환된 건수(예: 계약·파트너)
 * @param denominator 모수(예: 협업 제안 발송)
 * @param sample 전환율의 신뢰를 결정하는 표본 = 전환 건수 자체. 모수가 커도 전환이 1건이면
 *               비율은 의미가 없으므로, 임계는 **분자**에 걸어야 한다.
 */
export function conversionSampleState(input: {
  numerator: number;
  denominator: number;
  sample?: number;
  threshold?: number;
}): ConversionSampleState {
  const threshold = Number.isFinite(input.threshold) ? Math.max(1, Math.round(input.threshold as number)) : CONVERSION_SAMPLE_THRESHOLD;
  const numerator = Number.isFinite(input.numerator) ? Math.max(0, Math.round(input.numerator)) : 0;
  const denominator = Number.isFinite(input.denominator) ? Math.max(0, Math.round(input.denominator)) : 0;
  const sample = Number.isFinite(input.sample) ? Math.max(0, Math.round(input.sample as number)) : numerator;

  // 모수가 0 이면 비율이 정의되지 않는다. 표본 임계 미만이면 계산 자체를 하지 않는다.
  if (denominator <= 0 || sample < threshold) {
    return { measurable: false, sample, label: `측정 중 (표본 ${sample.toLocaleString()}건)` };
  }
  const percent = Math.round((numerator / denominator) * 1_000) / 10;
  return { measurable: true, sample, percent, label: `${percent}%` };
}
