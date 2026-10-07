// 광고 후보 → 휴먼게이트 자동제안(C1). "good_ad_candidate" 영상에 대해 크리에이터 이메일 자동수집 +
//   아웃리치 초안 자동생성(callModel 경유·usage 로그) → ad_proposals 원장(status=proposed, mode=draft_only).
//   ⚠️ 이 모듈은 절대 메일을 발송하지 않는다. 실제 발송은 기존 휴먼게이트 경로(campaign_outreach /
//   prepareScpResultMail: draft_only + scpGate + suppression)에서 사람이 승인해야만 일어난다.
//   mail_safety_state/outbound 락을 우회하지 않는다. 클라 직접쓰기 금지(SEC-P0-004) → 이 콜러블 경유.
//   외부 AI는 callModel 단일 초크포인트(SEC-P0-005) + reportLlmUsage(COST-P0). 프롬프트 원문 비저장(SEC-P0-009).
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { callModel, selectVertexModelForTask } from "./vertex";
import { newSessionId, reportLlmUsage } from "./aiHubReport";
import { sourceRef as makeSourceRef, writeKnowledgeNode, type SourceRef } from "./knowledgeGraph";

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const PROPOSAL_COLLECTION = "ad_proposals";
const DRAFT_MODEL_FALLBACK = "gemini-2.5-flash";
const PROPOSABLE_VERDICTS = new Set(["good_ad_candidate", "brand_deal_low_fit", "organic_good_fit"]);

type ProposalReasonCode =
  | "ad_fit"
  | "gameplay_relevance"
  | "audience_match"
  | "language_region_fit"
  | "comment_sentiment"
  | "creator_quality"
  | "recent_growth"
  | "manual_operator_signal";

type ProposalWhy = {
  summary: string;
  reasonCodes: ProposalReasonCode[];
  positiveSignals: string[];
  cautionSignals: string[];
  sourceSignals: {
    adVerdict?: string;
    gameFit?: number | null;
    adConfidence?: number | null;
    adSignals?: string[];
    fitReasons?: string[];
    language?: string;
    audioAccent?: string;
    keywordTags?: string[];
    commentInsightSummary?: string;
    creatorCountry?: string;
    creatorLanguage?: string;
    followerCount?: number | null;
    emailResolved?: boolean;
  };
};

type ProposalLearningScore = {
  proposalFit: number;
  confidence: "low" | "medium" | "high";
  explanation: string;
  matchedLearningPatterns: string[];
  negativeLearningPatterns: string[];
};

type FeedProposalLearningAction = "proposal_created" | "human_approved" | "human_rejected" | "human_edited" | "sent" | "reply_received" | "converted" | "failed";
type HumanFeedbackAction = Extract<FeedProposalLearningAction, "human_approved" | "human_rejected" | "human_edited">;

type ProposalLearningEvent = {
  eventId: string;
  videoId: string;
  proposalId: string;
  creatorId?: string;
  channelId?: string;
  programId?: string;
  campaignId?: string;
  action: FeedProposalLearningAction;
  operatorReasonCodes: string[];
  operatorNote?: string;
  whyProposedSnapshot: ProposalWhy;
  learningSnapshot: ProposalLearningScore;
  draftChangedFields?: string[];
  sourceRefs: SourceRef[];
  createdAtIso: string;
  createdBy: string;
  createdByEmail?: string;
  createdByName?: string;
  createdByTeam?: string;
  safety: { draftOnly: true; sends: false; humanGateRequired: true };
};

const HUMAN_FEEDBACK_ACTIONS = new Set<HumanFeedbackAction>(["human_approved", "human_rejected", "human_edited"]);
const MAX_REASON_CODES = 8;
const MAX_REASON_CODE_LENGTH = 48;
const MAX_NOTE_LENGTH = 500;
const ALLOWED_DRAFT_CHANGED_FIELDS = new Set(["subject", "body", "tone", "cta", "offer", "schedule", "terms", "attachments", "recipient"]);

type CreatorContact = { creatorEmail: string; creatorName: string; youtubeHandle: string; emailSource: string; country?: string; language?: string; followerCount?: number | null };

// creators/{creatorId} 우선, 없으면 candidate_pool/{channelId}에서 이메일/이름/핸들을 해소한다.
async function resolveCreatorContact(video: Record<string, unknown>): Promise<CreatorContact> {
  const creatorId = asString(video.creatorId);
  const channelId = asString(video.channelId);
  const out: CreatorContact = { creatorEmail: "", creatorName: asString(video.channel), youtubeHandle: "", emailSource: "none" };

  if (creatorId) {
    const snap = await adminDb.collection("creators").doc(creatorId).get();
    if (snap.exists) {
      const c = snap.data() ?? {};
      out.creatorEmail = asString(c.email, asString(c.businessEmail, asString(c.contactEmail)));
      out.creatorName = asString(c.name, out.creatorName);
      out.youtubeHandle = asString(c.handle, asString(c.customUrl));
      out.country = asString(c.country, asString(c.region));
      out.language = asString(c.language, asString(c.primaryLanguage));
      out.followerCount = asNumberOrNull(c.followerCount ?? c.subscriberCount ?? c.subscribers);
      if (out.creatorEmail) out.emailSource = "creators";
    }
  }
  if (!out.creatorEmail && channelId) {
    const snap = await adminDb.collection("candidate_pool").doc(channelId).get();
    if (snap.exists) {
      const c = snap.data() ?? {};
      out.creatorEmail = asString(c.email, asString(c.businessEmail));
      out.creatorName = asString(c.name, out.creatorName);
      out.youtubeHandle = asString(c.handle, out.youtubeHandle);
      out.country = out.country || asString(c.country, asString(c.region));
      out.language = out.language || asString(c.language, asString(c.primaryLanguage));
      out.followerCount = out.followerCount ?? asNumberOrNull(c.followerCount ?? c.subscriberCount ?? c.subscribers);
      if (out.creatorEmail) out.emailSource = "candidate_pool";
    }
  }
  return out;
}

function safeText(value: unknown, maxLength = 180): string {
  return asString(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// S9: operatorNote는 사람이 직접 입력하는 자유 텍스트이고 buildLearningKbNode를 거쳐
// knowledge_nodes 요약(/admin/knowledge에 노출)까지 흘러간다. safeText만으로는 "prompt:"/
// "response:"/"raw:"/"query:" 같은 마커 뒤로 원문 프롬프트/응답을 그대로 붙여넣는 경로를
// 막지 못한다(SEC-P0-009 인접) — feedback-kb.ts의 sanitizeExcerpt와 동일한 패턴을 재사용.
function sanitizeOperatorNote(value: unknown, maxLength = 500): string {
  const stripped = asString(value).replace(/\b(prompt|response|raw|query)\s*[:=][\s\S]*/gi, "");
  return safeText(stripped, maxLength);
}

function safeTextArray(value: unknown, maxItems = 6, maxLength = 180): string[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((item) => safeText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function gameFitPercentOrNull(value: unknown): number | null {
  const numeric = asNumberOrNull(value);
  if (numeric === null) return null;
  return clampScore(numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric);
}

function boundedReasonCodes(value: unknown): string[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : [])
    .map((item) => safeText(item, MAX_REASON_CODE_LENGTH).toLowerCase().replace(/[^a-z0-9_-]/g, "_"))
    .filter((item) => item.length > 0 && !seen.has(item) && (seen.add(item), true))
    .slice(0, MAX_REASON_CODES);
}

function boundedDraftChangedFields(value: unknown): string[] | undefined {
  const seen = new Set<string>();
  const fields = (Array.isArray(value) ? value : [])
    .map((item) => safeText(item, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "_"))
    .filter((item) => ALLOWED_DRAFT_CHANGED_FIELDS.has(item) && !seen.has(item) && (seen.add(item), true))
    .slice(0, 12);
  return fields.length ? fields : undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function buildWhyProposed(video: Record<string, unknown>, ad: Record<string, unknown>, contact: CreatorContact): ProposalWhy {
  const gameFit = gameFitPercentOrNull(ad.gameFit);
  const adConfidence = asNumberOrNull(ad.adConfidence);
  const adSignals = safeTextArray(ad.adSignals, 6, 120);
  const fitReasons = safeTextArray(ad.fitReasons, 4, 120);
  const keywordTags = safeTextArray(video.keywordTags ?? video.tags, 6, 60);
  const commentInsights = firstRecord(video.commentInsights, video.commentInsight, video.commentAnalysis);
  const commentInsightSummary = safeText(commentInsights.summary ?? commentInsights.sentimentSummary ?? video.commentInsightSummary, 180);
  const reasonCodes = new Set<ProposalReasonCode>();
  const positiveSignals: string[] = [];
  const cautionSignals: string[] = [];
  const verdict = safeText(ad.verdict, 80);
  const language = safeText(video.language, 40);
  const audioAccent = safeText(video.audioAccent, 40);

  if (verdict) reasonCodes.add("ad_fit");
  if (gameFit !== null && gameFit >= 60) reasonCodes.add("gameplay_relevance");
  if (adConfidence !== null && adConfidence >= 0.65) reasonCodes.add("audience_match");
  if (language || audioAccent || contact.language || contact.country) reasonCodes.add("language_region_fit");
  if (commentInsightSummary) reasonCodes.add("comment_sentiment");
  if ((contact.followerCount ?? 0) >= 10000 || contact.creatorEmail) reasonCodes.add("creator_quality");

  if (verdict) positiveSignals.push(`광고 후보 판정: ${verdict}`);
  if (gameFit !== null) positiveSignals.push(`게임 적합도 ${gameFit}%`);
  if (adConfidence !== null) positiveSignals.push(`광고 신뢰도 ${Math.round(adConfidence * 100)}%`);
  for (const reason of fitReasons) positiveSignals.push(reason);
  for (const signal of adSignals) positiveSignals.push(signal);
  if (commentInsightSummary) positiveSignals.push(commentInsightSummary);
  if (contact.followerCount !== null && contact.followerCount !== undefined) positiveSignals.push(`크리에이터 규모 ${contact.followerCount.toLocaleString("ko-KR")}명`);

  if (!contact.creatorEmail) cautionSignals.push("연락 가능한 이메일이 아직 확인되지 않았습니다.");
  if (gameFit !== null && gameFit < 60) cautionSignals.push(`게임 적합도 ${gameFit}%로 추가 검토가 필요합니다.`);
  if (adConfidence !== null && adConfidence < 0.65) cautionSignals.push(`광고 신뢰도 ${Math.round(adConfidence * 100)}%로 사람 검수가 필요합니다.`);
  if (language && contact.language && language.toLowerCase() !== contact.language.toLowerCase()) cautionSignals.push(`영상 언어(${language})와 크리에이터 언어(${contact.language})가 다를 수 있습니다.`);

  const summaryParts = [
    verdict ? `광고 후보(${verdict})로 분류` : "광고 후보로 분류",
    gameFit !== null ? `게임 적합도 ${gameFit}%` : "게임 적합도 신호 확인",
    fitReasons[0] ? `${fitReasons[0]} 근거` : adSignals[0] ? `${adSignals[0]} 신호` : "구조화 신호",
  ];
  const summary = `${summaryParts.join(" · ")}가 있어 초안 후보로 기록했습니다.`;

  return {
    summary: safeText(summary, 240),
    reasonCodes: [...reasonCodes].slice(0, 8),
    positiveSignals: safeTextArray(positiveSignals, 6, 180),
    cautionSignals: safeTextArray(cautionSignals, 4, 180),
    sourceSignals: {
      ...(verdict ? { adVerdict: verdict } : {}),
      gameFit,
      adConfidence,
      ...(adSignals.length ? { adSignals } : {}),
      ...(fitReasons.length ? { fitReasons } : {}),
      ...(language ? { language } : {}),
      ...(audioAccent ? { audioAccent } : {}),
      ...(keywordTags.length ? { keywordTags } : {}),
      ...(commentInsightSummary ? { commentInsightSummary } : {}),
      ...(contact.country ? { creatorCountry: safeText(contact.country, 80) } : {}),
      ...(contact.language ? { creatorLanguage: safeText(contact.language, 80) } : {}),
      followerCount: contact.followerCount ?? null,
      emailResolved: Boolean(contact.creatorEmail),
    },
  };
}

function buildProposalLearningScore(why: ProposalWhy, ad: Record<string, unknown>): ProposalLearningScore {
  const gameFit = gameFitPercentOrNull(why.sourceSignals.gameFit) ?? gameFitPercentOrNull(ad.gameFit) ?? 50;
  const adConfidenceRaw = why.sourceSignals.adConfidence ?? asNumberOrNull(ad.adConfidence) ?? 0.5;
  const confidencePercent = adConfidenceRaw <= 1 ? adConfidenceRaw * 100 : adConfidenceRaw;
  const positiveBoost = why.positiveSignals.length * 4;
  const cautionPenalty = why.cautionSignals.length * 7;
  const emailBoost = why.sourceSignals.emailResolved ? 8 : -6;
  const proposalFit = clampScore(gameFit * 0.55 + confidencePercent * 0.35 + positiveBoost + emailBoost - cautionPenalty);
  const confidence = proposalFit >= 75 && why.cautionSignals.length <= 1 ? "high" : proposalFit >= 50 ? "medium" : "low";
  const matchedLearningPatterns = why.reasonCodes.slice(0, 6);
  const negativeLearningPatterns = why.cautionSignals.map((item) => item.slice(0, 80)).slice(0, 4);
  return {
    proposalFit,
    confidence,
    explanation: safeText(`제안 적합도 ${proposalFit}/100 (${confidence}) — ${matchedLearningPatterns.join(", ") || "기본 신호"}`, 240),
    matchedLearningPatterns,
    negativeLearningPatterns,
  };
}

function learningSourceRefs(videoId: string, proposalId: string, eventId: string, proposal: Record<string, unknown>): SourceRef[] {
  const creatorId = asString(proposal.creatorId);
  return [
    makeSourceRef(`videos/${videoId}`, "video", "source video"),
    makeSourceRef(`${PROPOSAL_COLLECTION}/${proposalId}`, "ad_proposal", "proposal draft"),
    makeSourceRef(`feed_proposal_learning_events/${eventId}`, "feed_proposal_learning_event", "learning event"),
    ...(creatorId ? [makeSourceRef(`creators/${creatorId}`, "creator", "creator profile")] : []),
  ];
}

function buildLearningEvent(input: {
  eventId: string;
  action: FeedProposalLearningAction;
  proposal: Record<string, unknown>;
  whyProposed: ProposalWhy;
  learningSnapshot: ProposalLearningScore;
  auth: ReturnType<typeof assertNonGuestAuth>;
  nowIso: string;
  operatorReasonCodes?: string[];
  operatorNote?: string;
  draftChangedFields?: string[];
}): ProposalLearningEvent {
  const videoId = asString(input.proposal.videoId);
  const proposalId = asString(input.proposal.proposalId, videoId);
  return {
    eventId: input.eventId,
    videoId,
    proposalId,
    ...(asString(input.proposal.creatorId) ? { creatorId: asString(input.proposal.creatorId) } : {}),
    ...(asString(input.proposal.channelId) ? { channelId: asString(input.proposal.channelId) } : {}),
    ...(asString(input.proposal.programId) ? { programId: asString(input.proposal.programId) } : {}),
    ...(asString(input.proposal.campaignId) ? { campaignId: asString(input.proposal.campaignId) } : {}),
    action: input.action,
    operatorReasonCodes: input.operatorReasonCodes ?? [],
    ...(input.operatorNote ? { operatorNote: safeText(input.operatorNote, MAX_NOTE_LENGTH) } : {}),
    whyProposedSnapshot: input.whyProposed,
    learningSnapshot: input.learningSnapshot,
    ...(input.draftChangedFields?.length ? { draftChangedFields: input.draftChangedFields } : {}),
    sourceRefs: learningSourceRefs(videoId, proposalId, input.eventId, input.proposal),
    createdAtIso: input.nowIso,
    createdBy: input.auth.userId,
    ...(input.auth.email ? { createdByEmail: safeText(input.auth.email, 160) } : {}),
    ...(input.auth.name ? { createdByName: safeText(input.auth.name, 120) } : {}),
    ...(input.auth.team ? { createdByTeam: safeText(input.auth.team, 80) } : {}),
    safety: { draftOnly: true, sends: false, humanGateRequired: true },
  };
}

function buildLearningKbNode(event: ProposalLearningEvent, proposal: Record<string, unknown>) {
  const actorNote = event.operatorReasonCodes.length ? ` 사유: ${event.operatorReasonCodes.join(", ")}.` : "";
  const boundedNote = event.operatorNote ? ` 메모: ${event.operatorNote}` : "";
  const changed = event.draftChangedFields?.length ? ` 수정 필드: ${event.draftChangedFields.join(", ")}.` : "";
  const subject = safeText(proposal.creatorName ?? proposal.channelId ?? proposal.videoId, 80);
  return {
    id: `feed-proposal-learning-${event.eventId}`,
    type: "feed_proposal_learning" as const,
    title: `피드 제안 학습: ${event.action} · ${subject || event.videoId}`,
    summary: safeText(`${event.whyProposedSnapshot.summary} 학습 액션 ${event.action}.${actorNote}${changed}${boundedNote} 발송 없음/draft_only.`, 1000),
    sourceRefs: event.sourceRefs,
    entityRefs: [
      `videos/${event.videoId}`,
      `${PROPOSAL_COLLECTION}/${event.proposalId}`,
      ...(event.creatorId ? [`creators/${event.creatorId}`] : []),
    ],
    createdAtIso: event.createdAtIso,
  };
}

function proposalAttribution(auth: ReturnType<typeof assertNonGuestAuth>, previous: Record<string, unknown> = {}) {
  return {
    createdBy: asString(previous.createdBy, auth.userId),
    ...(asString(previous.createdByEmail, auth.email) ? { createdByEmail: safeText(asString(previous.createdByEmail, auth.email), 160) } : {}),
    ...(asString(previous.createdByName, auth.name) ? { createdByName: safeText(asString(previous.createdByName, auth.name), 120) } : {}),
    ...(asString(previous.createdByTeam, auth.team) ? { createdByTeam: safeText(asString(previous.createdByTeam, auth.team), 80) } : {}),
  };
}

function updateAttribution(auth: ReturnType<typeof assertNonGuestAuth>) {
  return {
    updatedBy: auth.userId,
    ...(auth.email ? { updatedByEmail: safeText(auth.email, 160) } : {}),
    ...(auth.name ? { updatedByName: safeText(auth.name, 120) } : {}),
    ...(auth.team ? { updatedByTeam: safeText(auth.team, 80) } : {}),
  };
}

function isEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

function templateDraft(creatorName: string, videoTitle: string): { subject: string; body: string } {
  const name = creatorName || "크리에이터";
  const title = videoTitle || "최근 영상";
  return {
    subject: `[Supercent] ${name}님과 캐주얼 게임 광고 협업 제안`,
    body: `안녕하세요 ${name}님,\n\nSupercent 마케팅팀입니다. "${title}" 영상을 인상 깊게 보았고, 저희 캐주얼 모바일 게임 광고 협업을 제안드리고 싶어 연락드립니다.\n\n채널 톤과 시청자층이 저희 게임과 잘 맞는다고 판단했습니다. 관심 있으시면 회신 부탁드립니다 — 상세 조건·일정은 유연하게 조율 가능합니다.\n\n감사합니다.\nSupercent 마케팅팀 드림`,
  };
}

// 아웃리치 초안 자동생성 — callModel(email_draft) 경유. 실패/에뮬레이터 시 결정론 템플릿(draftSource 표기).
async function generateProposalDraft(input: { creatorName: string; videoTitle: string; verdict: string; adSignals: readonly string[]; fitReasons: readonly string[] }): Promise<{ subject: string; body: string; draftSource: "ai" | "template"; modelId: string }> {
  if (isEmulator()) {
    const t = templateDraft(input.creatorName, input.videoTitle);
    return { ...t, draftSource: "template", modelId: "template" };
  }
  const modelId = selectVertexModelForTask("email_draft") || DRAFT_MODEL_FALLBACK;
  const schema = {
    type: "object",
    properties: { subject: { type: "string" }, body: { type: "string" } },
    required: ["subject", "body"],
  } as const;
  const prompt = [
    "Write a warm, concise Korean cold-outreach email draft proposing a CASUAL mobile-game advertising collaboration with a YouTube creator.",
    "Tone: professional, respectful, specific. 3-5 short paragraphs. Sign off as 'Supercent 마케팅팀'. Do NOT invent concrete fees, dates, or contract terms — invite a reply to discuss.",
    "Return JSON only: { subject, body }. Korean language.",
    JSON.stringify({
      creatorName: input.creatorName || "크리에이터",
      referencedVideo: input.videoTitle,
      whyReachingOut: { verdict: input.verdict, adSignals: input.adSignals.slice(0, 6), fitReasons: input.fitReasons.slice(0, 4) },
    }),
  ].join("\n");
  const startedAt = Date.now();
  try {
    const result = await callModel<{ subject?: unknown; body?: unknown }>(modelId, schema, prompt);
    const subject = asString(result.json?.subject);
    const body = asString(result.json?.body);
    await reportLlmUsage({
      sessionId: newSessionId(),
      toolId: "scp.ad_proposal_draft",
      modelId: result.modelId,
      provider: result.provider,
      transport: result.transport ?? "unverified",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalCostUsd: result.estimatedCostUsd,
      latencyMs: Date.now() - startedAt,
    });
    if (subject && body) return { subject, body, draftSource: "ai", modelId: result.modelId };
  } catch (error) {
    console.warn("[ad-proposal] draft generation failed; using template", { error: error instanceof Error ? error.message : String(error) });
  }
  const t = templateDraft(input.creatorName, input.videoTitle);
  return { ...t, draftSource: "template", modelId };
}

// good_ad_candidate 영상 → 제안 생성(이메일 수집 + 초안 + 원장). 발송 없음(휴먼게이트).
export async function createAdProposal(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "ad_proposal.create", WRITE_ROLES);
  const data = asRecord(request.data);
  const videoId = asString(data.videoId);
  if (!videoId) throw Object.assign(new Error("videoId required"), { code: "invalid-argument", errorCode: "create_ad_proposal_video_id_required" });

  const videoSnap = await adminDb.collection("videos").doc(videoId).get();
  if (!videoSnap.exists) throw Object.assign(new Error("video not found"), { code: "not-found", errorCode: "create_ad_proposal_video_found" });
  const video = videoSnap.data() ?? {};
  const ad = asRecord(video.adClassification);
  const verdict = asString(ad.verdict);
  if (!verdict) throw Object.assign(new Error("video is not ad-classified yet"), { code: "failed-precondition", errorCode: "create_ad_proposal_video_ad_classified_yet" });
  if (!PROPOSABLE_VERDICTS.has(verdict)) throw Object.assign(new Error(`verdict '${verdict}' is not proposable`), { code: "failed-precondition", errorCode: "create_ad_proposal_verdict" });

  const contact = await resolveCreatorContact(video);
  const videoTitle = asString(video.title, "최근 영상");
  const adSignals = Array.isArray(ad.adSignals) ? ad.adSignals.filter((s): s is string => typeof s === "string") : [];
  const fitReasons = Array.isArray(ad.fitReasons) ? ad.fitReasons.filter((s): s is string => typeof s === "string") : [];
  const draft = await generateProposalDraft({ creatorName: contact.creatorName, videoTitle, verdict, adSignals, fitReasons });

  const nowIso = new Date().toISOString();
  const proposalId = videoId; // 영상당 1 제안(멱등). 재생성 시 draft/상태 갱신.
  const proposalRef = adminDb.collection(PROPOSAL_COLLECTION).doc(proposalId);
  const previousProposal = await proposalRef.get();
  const previous = previousProposal.data() ?? {};
  const whyProposed = buildWhyProposed(video, ad, contact);
  const learningSnapshot = buildProposalLearningScore(whyProposed, ad);
  const proposal = {
    proposalId,
    videoId,
    creatorId: asString(video.creatorId),
    channelId: asString(video.channelId),
    creatorEmail: contact.creatorEmail,
    emailSource: contact.emailSource,
    creatorName: contact.creatorName,
    youtubeUrl: asString(video.url, videoId ? `https://www.youtube.com/watch?v=${videoId}` : ""),
    verdict,
    adSnapshot: { isAd: ad.isAd === true, gameFit: typeof ad.gameFit === "number" ? ad.gameFit : null, adConfidence: typeof ad.adConfidence === "number" ? ad.adConfidence : null, adSignals: adSignals.slice(0, 6), fitReasons: fitReasons.slice(0, 4) },
    whyProposed,
    learningSnapshot,
    draftSubject: draft.subject,
    draftBody: draft.body,
    draftSource: draft.draftSource,
    draftModel: draft.modelId,
    status: "proposed" as const, // proposed → (사람 승인) approved → sent. 이 콜러블은 proposed까지만.
    mode: "draft_only" as const, // 발송 게이트: 사람 승인 전까지 절대 발송 안 함.
    emailResolved: Boolean(contact.creatorEmail),
    createdAtIso: asString(previous.createdAtIso, nowIso),
    updatedAtIso: nowIso,
    ...proposalAttribution(auth, previous),
    ...updateAttribution(auth),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const eventRef = adminDb.collection("feed_proposal_learning_events").doc();
  const event = buildLearningEvent({ eventId: eventRef.id, action: "proposal_created", proposal, whyProposed, learningSnapshot, auth, nowIso });
  const batch = adminDb.batch();
  batch.set(proposalRef, proposal);
  batch.create(eventRef, event);
  const kbNodePath = writeKnowledgeNode(batch, buildLearningKbNode(event, proposal));
  await batch.commit();

  return {
    ok: true as const,
    proposal,
    learningEvent: event,
    kbNode: { path: kbNodePath, id: `feed-proposal-learning-${event.eventId}` },
    // 감사: 이 경로는 발송하지 않는다. 발송은 사람이 승인해야 하는 별도 게이트.
    humanGate: { sends: false, requiresHumanApproval: true, note: "초안만 생성됨 — 발송은 사람 승인 필요(campaign_outreach/prepareScpResultMail draft_only 게이트)." },
    behaviorLog: makeBehaviorLog(auth, "ad_proposal.create", "success"),
  };
}

// 사람의 제안 판단을 append-only 학습 원장에 기록한다. 초안/메일 발송/API/model 호출은 하지 않는다.
export async function recordAdProposalFeedback(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "ad_proposal.feedback", WRITE_ROLES);
  const data = asRecord(request.data);
  const videoId = asString(data.videoId);
  const action = asString(data.action) as HumanFeedbackAction;
  if (!videoId) throw Object.assign(new Error("videoId required"), { code: "invalid-argument", errorCode: "record_ad_proposal_feedback_video_id_required" });
  if (!HUMAN_FEEDBACK_ACTIONS.has(action)) throw Object.assign(new Error("invalid feedback action"), { code: "invalid-argument", errorCode: "record_ad_proposal_feedback_invalid_feedback_action" });

  const [proposalSnap, videoSnap] = await Promise.all([
    adminDb.collection(PROPOSAL_COLLECTION).doc(videoId).get(),
    adminDb.collection("videos").doc(videoId).get(),
  ]);
  if (!proposalSnap.exists) throw Object.assign(new Error("proposal not found"), { code: "failed-precondition", errorCode: "record_ad_proposal_feedback_proposal_found" });
  if (!videoSnap.exists) throw Object.assign(new Error("video not found"), { code: "not-found", errorCode: "record_ad_proposal_feedback_video_found" });

  const proposal = proposalSnap.data() ?? {};
  const video = videoSnap.data() ?? {};
  const ad = asRecord(video.adClassification);
  const contact: CreatorContact = {
    creatorEmail: asString(proposal.creatorEmail),
    creatorName: asString(proposal.creatorName, asString(video.channel)),
    youtubeHandle: asString(proposal.youtubeHandle),
    emailSource: asString(proposal.emailSource, "proposal"),
    country: asString((asRecord(proposal.whyProposed).sourceSignals as Record<string, unknown> | undefined)?.creatorCountry),
    language: asString((asRecord(proposal.whyProposed).sourceSignals as Record<string, unknown> | undefined)?.creatorLanguage),
    followerCount: asNumberOrNull((asRecord(proposal.whyProposed).sourceSignals as Record<string, unknown> | undefined)?.followerCount),
  };
  const whyProposed = asRecord(proposal.whyProposed).summary ? proposal.whyProposed as ProposalWhy : buildWhyProposed(video, ad, contact);
  const learningSnapshot = asRecord(proposal.learningSnapshot).proposalFit !== undefined ? proposal.learningSnapshot as ProposalLearningScore : buildProposalLearningScore(whyProposed, ad);
  const nowIso = new Date().toISOString();
  const operatorReasonCodes = boundedReasonCodes(data.operatorReasonCodes);
  const operatorNote = sanitizeOperatorNote(data.operatorNote, MAX_NOTE_LENGTH);
  const draftChangedFields = boundedDraftChangedFields(data.draftChangedFields);
  const proposalId = asString(proposal.proposalId, videoId);
  const eventRef = adminDb.collection("feed_proposal_learning_events").doc();
  const proposalForEvent = { ...proposal, proposalId, videoId, whyProposed, learningSnapshot };
  const event = buildLearningEvent({ eventId: eventRef.id, action, proposal: proposalForEvent, whyProposed, learningSnapshot, auth, nowIso, operatorReasonCodes, operatorNote, draftChangedFields });
  const latestHumanDecision = {
    action,
    operatorReasonCodes,
    ...(operatorNote ? { operatorNote } : {}),
    ...(draftChangedFields?.length ? { draftChangedFields } : {}),
    decidedAtIso: nowIso,
    decidedBy: auth.userId,
    ...(auth.email ? { decidedByEmail: safeText(auth.email, 160) } : {}),
    ...(auth.name ? { decidedByName: safeText(auth.name, 120) } : {}),
    ...(auth.team ? { decidedByTeam: safeText(auth.team, 80) } : {}),
  };

  const batch = adminDb.batch();
  batch.create(eventRef, event);
  batch.update(proposalSnap.ref, {
    latestHumanDecision,
    status: action,
    mode: "draft_only",
    updatedAtIso: nowIso,
    ...updateAttribution(auth),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const kbNodePath = writeKnowledgeNode(batch, buildLearningKbNode(event, proposalForEvent));
  await batch.commit();

  return {
    ok: true as const,
    latestHumanDecision,
    learningEvent: event,
    kbNode: { path: kbNodePath, id: `feed-proposal-learning-${event.eventId}` },
    humanGate: { sends: false, requiresHumanApproval: true, note: "학습 기록만 저장됨 — 발송 아님." },
    behaviorLog: makeBehaviorLog(auth, "ad_proposal.feedback", "success"),
  };
}

export const __test__ = {
  buildWhyProposed,
  buildProposalLearningScore,
  boundedReasonCodes,
  sanitizeOperatorNote,
};

// 제안 원장 조회(리뷰 UI/admin verify). 단일 orderBy(인덱스 불필요).
export async function listAdProposals(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "ad_proposal.list", WRITE_ROLES);
  const data = asRecord(request.data);
  const limit = Math.max(1, Math.min(200, typeof data.limit === "number" ? data.limit : 50));
  const snap = await adminDb.collection(PROPOSAL_COLLECTION).orderBy("createdAtIso", "desc").limit(limit).get();
  const rows = snap.docs.map((d) => {
    const r = d.data() ?? {};
    return {
      proposalId: asString(r.proposalId, d.id),
      videoId: asString(r.videoId),
      creatorName: asString(r.creatorName),
      creatorEmail: asString(r.creatorEmail),
      emailResolved: r.emailResolved === true,
      verdict: asString(r.verdict),
      draftSubject: asString(r.draftSubject),
      draftSource: asString(r.draftSource),
      status: asString(r.status, "proposed"),
      mode: asString(r.mode, "draft_only"),
      createdAtIso: asString(r.createdAtIso),
    };
  });
  return { ok: true as const, rows, count: rows.length, behaviorLog: makeBehaviorLog(auth, "ad_proposal.list", "success") };
}
