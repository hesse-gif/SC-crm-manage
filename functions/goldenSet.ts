// 골든셋 라벨링 v1 — 설계자 정성 라벨(golden_set_labels) 기록 + 1차 분류(classification)와의 일치율 계산.
//   신규 enum은 골든셋(goldenSetCount>=5) 확보 전까지 activeEnumIds()에서 제외된다(videoTaxonomy.ts governance).
//   골든셋 라벨링 자체는 부트스트랩 대상이므로 활성 enum이 아니어도(taxonomy v1 시드에 정의만 되어 있으면) 허용한다.
// 일치율(computeGoldenSetAgreement)은 trendReport.publishWeeklyTrendReport의 published/gate_blocked 게이트 입력.

import { loadTaxonomy, type TaxonomyAxis } from "./videoTaxonomy";
import { FieldValue } from "firebase-admin/firestore";

export const GOLDEN_SET_LABEL_PHASES = ["calibration", "full"] as const;
export type GoldenSetLabelPhase = typeof GOLDEN_SET_LABEL_PHASES[number];
const AXES: readonly TaxonomyAxis[] = ["format", "genreStyle", "contentNature"];
const DEFAULT_PHASE: GoldenSetLabelPhase = "calibration";

export type GoldenSetQualitativeLabel = {
  readonly format: string;
  readonly genreStyle: string;
  readonly contentNature: string;
};

export type GoldenSetLabelInput = GoldenSetQualitativeLabel & {
  readonly videoId: string;
  readonly labeler: string;
  readonly phase?: GoldenSetLabelPhase;
};

export type GoldenSetLabelRecord = GoldenSetLabelInput & {
  readonly phase: GoldenSetLabelPhase;
  readonly labeledAtIso: string;
};

function isKnownEnumId(axis: TaxonomyAxis, id: string): boolean {
  const entries = loadTaxonomy().axes[axis] ?? [];
  return entries.some((entry) => entry.id === id);
}

function isPhase(value: unknown): value is GoldenSetLabelPhase {
  return typeof value === "string" && (GOLDEN_SET_LABEL_PHASES as readonly string[]).includes(value);
}

type FirestoreSnapshot = {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
};

type FirestoreDocRef = {
  get(): Promise<FirestoreSnapshot>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
};

export type FirestoreDb = {
  collection(name: string): { doc(id: string): FirestoreDocRef };
};

const GOLDEN_SET_LABELS_COLLECTION = "golden_set_labels";
const GOLDEN_SET_ENUM_PROGRESS_COLLECTION = "golden_set_enum_progress";

export function goldenSetLabelDocId(videoId: string, labeler: string): string {
  return `${videoId}__${labeler}`;
}

function enumProgressDocId(axis: TaxonomyAxis, id: string): string {
  return `${axis}__${id}`;
}

// 신규 enum 골든셋 보강 추적 훅 — 라벨이 선택한 각 축의 enum id에 대해 진행 카운터를 증가시킨다.
// 실제 activeEnumIds() 게이팅은 taxonomy 시드 파일(단일 소스, PR 반영)이 정본이며, 이 카운터는
// "5건 확보" 임계값 도달 여부를 운영진이 추적/PR 트리거하기 위한 참고 지표다(governance).
async function bumpGoldenSetEnumProgress(db: FirestoreDb, label: GoldenSetQualitativeLabel, nowIso: string): Promise<void> {
  const bumps: Promise<unknown>[] = [];
  for (const axis of AXES) {
    const id = label[axis];
    const docId = enumProgressDocId(axis, id);
    bumps.push(
      db.collection(GOLDEN_SET_ENUM_PROGRESS_COLLECTION).doc(docId).set(
        { axis, id, count: FieldValue.increment(1), updatedAtIso: nowIso },
        { merge: true },
      ),
    );
  }
  await Promise.all(bumps);
}

export type RecordGoldenSetLabelOptions = {
  readonly nowIso?: string;
};

// 콜러블 recordGoldenSetLabel(RBAC manager+, index.ts에서 auth.uid를 labeler로 전달)의 순수 쓰기 로직.
export async function recordGoldenSetLabelImpl(
  db: FirestoreDb,
  input: GoldenSetLabelInput,
  options: RecordGoldenSetLabelOptions = {},
): Promise<GoldenSetLabelRecord> {
  const videoId = typeof input.videoId === "string" ? input.videoId.trim() : "";
  const labeler = typeof input.labeler === "string" ? input.labeler.trim() : "";
  if (!videoId) throw new Error("invalid-argument: videoId is required");
  if (!labeler) throw new Error("invalid-argument: labeler is required");
  for (const axis of AXES) {
    const value = input[axis];
    if (typeof value !== "string" || !isKnownEnumId(axis, value)) {
      throw new Error(`invalid-argument: ${axis} must be a known taxonomy enum id, got ${JSON.stringify(value)}`);
    }
  }
  const phase = isPhase(input.phase) ? input.phase : DEFAULT_PHASE;
  const nowIso = options.nowIso ?? new Date().toISOString();

  const record: GoldenSetLabelRecord = {
    videoId,
    labeler,
    format: input.format,
    genreStyle: input.genreStyle,
    contentNature: input.contentNature,
    phase,
    labeledAtIso: nowIso,
  };

  await db.collection(GOLDEN_SET_LABELS_COLLECTION).doc(goldenSetLabelDocId(videoId, labeler)).set(record, { merge: true });
  await bumpGoldenSetEnumProgress(db, record, nowIso);
  return record;
}

export type GoldenSetAgreementMismatch = {
  readonly videoId: string;
  readonly axis: TaxonomyAxis;
  readonly labeled: string;
  readonly classified: string;
};

export type GoldenSetAgreementResult = {
  readonly agreementPct: number; // 0..100
  readonly agreementRatio: number; // 0..1 — publishWeeklyTrendReport goldenSetAgreement 입력 형식
  readonly matched: number;
  readonly compared: number;
  readonly skippedNoClassification: number;
  readonly mismatches: GoldenSetAgreementMismatch[];
};

// 정성 필드(format/genreStyle/contentNature) 3축 전부 일치해야 "일치"로 카운트한다.
// classifications에 없는 videoId는 비교 대상에서 제외(skippedNoClassification)하고 분모에 넣지 않는다.
export function computeGoldenSetAgreement(
  labels: readonly (GoldenSetQualitativeLabel & { videoId: string })[],
  classifications: ReadonlyMap<string, GoldenSetQualitativeLabel> | Record<string, GoldenSetQualitativeLabel>,
): GoldenSetAgreementResult {
  const lookup = classifications instanceof Map
    ? classifications
    : new Map(Object.entries(classifications));

  let matched = 0;
  let compared = 0;
  let skippedNoClassification = 0;
  const mismatches: GoldenSetAgreementMismatch[] = [];

  for (const label of labels) {
    const classification = lookup.get(label.videoId);
    if (!classification) {
      skippedNoClassification += 1;
      continue;
    }
    compared += 1;
    let allMatch = true;
    for (const axis of AXES) {
      if (label[axis] !== classification[axis]) {
        allMatch = false;
        mismatches.push({ videoId: label.videoId, axis, labeled: label[axis], classified: classification[axis] });
      }
    }
    if (allMatch) matched += 1;
  }

  const agreementRatio = compared > 0 ? matched / compared : 0;
  return {
    agreementPct: Number((agreementRatio * 100).toFixed(1)),
    agreementRatio,
    matched,
    compared,
    skippedNoClassification,
    mismatches,
  };
}
