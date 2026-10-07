// 댓글 감성 골든셋 v1 — goldenSet.ts(영상 택소노미) 규범 미러. 사람 라벨(golden_set_sentiment_labels) vs
//   분석 예측 일치율(computeSentimentAgreement)을 계산해 배포 게이트(≥임계)로 삼는다.
//   2역할: (1) 오프라인 픽스처 게이트=산식 결정적 회귀(CI, LLM 미호출), (2) 라이브 measure 잡=모델 정확도(비CI).
import { FieldValue } from "firebase-admin/firestore";
import type { CommentSentiment } from "./videoCommentAnalysis";

export const SENTIMENT_GOLDEN_SET_PUBLISH_THRESHOLD = 0.8;
export const GOLDEN_SET_SENTIMENT_LABELS_COLLECTION = "golden_set_sentiment_labels";
export const SENTIMENT_GOLDEN_SET_PHASES = ["calibration", "full"] as const;
export type SentimentGoldenSetPhase = (typeof SENTIMENT_GOLDEN_SET_PHASES)[number];
const SENTIMENTS: readonly CommentSentiment[] = ["positive", "neutral", "negative"];

export type SentimentGoldenLabel = {
  commentId: string;
  humanLabel: CommentSentiment;
  lang?: string;
};
export type SentimentPrediction = {
  commentId: string;
  predicted: CommentSentiment;
};
export type SentimentAgreementMismatch = {
  commentId: string;
  human: CommentSentiment;
  predicted: CommentSentiment;
};
export type SentimentAgreementResult = {
  agreementPct: number;
  agreementRatio: number;
  matched: number;
  compared: number;
  skippedNoPrediction: number;
  mismatches: SentimentAgreementMismatch[];
};

function normalizeSentiment(value: unknown): CommentSentiment | null {
  return SENTIMENTS.includes(value as CommentSentiment) ? value as CommentSentiment : null;
}

// 순수: 예측에 없는 라벨은 분모에서 제외(skippedNoPrediction). goldenSet.computeGoldenSetAgreement 동형.
export function computeSentimentAgreement(
  labels: readonly SentimentGoldenLabel[],
  predictions: ReadonlyMap<string, CommentSentiment> | readonly SentimentPrediction[] | Record<string, CommentSentiment>,
): SentimentAgreementResult {
  let lookup: Map<string, CommentSentiment>;
  if (predictions instanceof Map) lookup = predictions;
  else if (Array.isArray(predictions)) lookup = new Map(predictions.map((p) => [p.commentId, p.predicted]));
  else lookup = new Map(Object.entries(predictions) as [string, CommentSentiment][]);

  let matched = 0;
  let compared = 0;
  let skippedNoPrediction = 0;
  const mismatches: SentimentAgreementMismatch[] = [];
  for (const label of labels) {
    const human = normalizeSentiment(label.humanLabel);
    const predicted = lookup.get(label.commentId);
    if (!human || !predicted) {
      skippedNoPrediction += 1;
      continue;
    }
    compared += 1;
    if (predicted === human) matched += 1;
    else mismatches.push({ commentId: label.commentId, human, predicted });
  }
  const agreementRatio = compared > 0 ? matched / compared : 0;
  return {
    agreementPct: Number((agreementRatio * 100).toFixed(1)),
    agreementRatio,
    matched,
    compared,
    skippedNoPrediction,
    mismatches,
  };
}

export function passesSentimentGate(ratio: number, threshold = SENTIMENT_GOLDEN_SET_PUBLISH_THRESHOLD): boolean {
  return ratio >= threshold;
}

// ── golden_set_sentiment_labels 쓰기(RBAC는 콜러블/스크립트 상위에서 검증). goldenSet.recordGoldenSetLabelImpl 미러. ──
type FirestoreDocRef = { set(value: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown> };
export type FirestoreDb = { collection(name: string): { doc(id: string): FirestoreDocRef } };

export type RecordSentimentLabelInput = SentimentGoldenLabel & { labeler: string; phase?: SentimentGoldenSetPhase };

export function sentimentLabelDocId(commentId: string, labeler: string): string {
  return `${commentId}__${labeler}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
}

export async function recordSentimentLabelImpl(
  db: FirestoreDb,
  input: RecordSentimentLabelInput,
  options: { nowIso?: string } = {},
): Promise<{ id: string }> {
  const human = normalizeSentiment(input.humanLabel);
  if (!human) throw new Error(`invalid humanLabel: ${String(input.humanLabel)}`);
  const phase: SentimentGoldenSetPhase = SENTIMENT_GOLDEN_SET_PHASES.includes(input.phase as SentimentGoldenSetPhase) ? input.phase as SentimentGoldenSetPhase : "calibration";
  const id = sentimentLabelDocId(input.commentId, input.labeler);
  await db.collection(GOLDEN_SET_SENTIMENT_LABELS_COLLECTION).doc(id).set({
    id,
    commentId: input.commentId,
    humanLabel: human,
    lang: input.lang ?? "",
    labeler: input.labeler,
    phase,
    updatedAtIso: options.nowIso ?? new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { id };
}
