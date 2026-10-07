// 프로그램 단위 콜드메일 중복발송 방지 (R5-B 철칙).
//
// 정책: **기본은 전역 차단**(scope="global" — settings.automation.outreachDedupScope 가 없거나
// "program"이 아닌 모든 값). 한 번 콜드메일 보낸 크리에이터/이메일/후보는 어느 프로그램에서도
// 재발송하지 않는다.
//
// 헤세 결정(2026-09-16): 운영자 옵트인으로 **프로그램 스코프 모드**(scope="program" —
// settings.automation.outreachDedupScope === "program")를 추가했다. 이 모드에서는 같은
// 프로그램 안에서의 재발송만 막고, 서로 다른 프로그램(예: XP Hero 가 콜드메일한 크리에이터를
// Snake Clash×Pororo 캠페인이 독립적으로 재접촉)은 서로 막지 않는다. 키가 Firestore 에
// 없으면(레거시) "global"로 떨어진다 — 이 수리를 배포해도 운영자가 설정을 켜기 전까지는
// 아무 것도 바뀌지 않는다(fail-closed). 과거 `allowResendInProgram` 예외 플래그는 감사/레거시
// 입력일 뿐이며 이 스코프 토글과는 별개다(resolveOutreachDedupScope/resolveOutreachDedupContext
// 참고). 전역 suppression(수신거부/bounce/infly-overlap)은 스코프와 무관하게 이 모듈과 별도로
// 발송 경로에서 항상 강제된다.
//
// SoT: program_outreach_dedup/{programId}__{creatorKey}  (멱등 append-only 사실 doc).
//   creatorKey = creator:<creatorId> | email:<lower> | candidate:<candidateId>  (안정적 크리에이터 신원).
//   programId 소스: campaign_outreach.programId(createCampaign가 스탬프) → 레거시면 campaignId→
//   campaigns/{id}.programId 폴백 → 그래도 없으면 DEFAULT_PROGRAM_ID("scp").
//
// 하드 규칙:
//   - append-only 사실. firstSentAtIso는 최초 1회만 기록(트랜잭션으로 불변), lastSentAtIso만 갱신.
//   - 클라 직접쓰기 금지(SEC-P0-004): 발송 경로/서버 브릿지에서만 기록.

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asString } from "./shared";
import { normalizePublicYouTubeChannelUrl } from "./scpColdmailHistory";

const DEDUP_COLLECTION = "program_outreach_dedup";
// PB-3: 콜드스타트/레거시 갭 — dedup SoT(program_outreach_dedup)도 campaign_outreach doc도
// 없지만 과거 수기/G1(recordScpColdOutreach) 경로로 scp_coldmail_history에만 남은 접촉자를
// send-time fallback에서 잡기 위한 append-only 발송 히스토리 원장(scpColdmailHistory.ts 소유).
const COLDMAIL_HISTORY_COLLECTION = "scp_coldmail_history";
const COLDMAIL_HISTORY_PROJECTION_COLLECTION = "scp_coldmail_history_projection";
export const DEFAULT_PROGRAM_ID = "scp";
const GETALL_CHUNK = 300;
// W58-3 [W57 이월]: `in` 상한은 30 이다. 10 으로 쪼개면 **발송 경로 행당 왕복이 3배**가 되고,
// 그 비용이 그대로 발송 페이즈 예산(240s)을 먹는다 — pass 당 9~11건밖에 못 보내는 처리량의 한 항이다.
// admin.ts:206 이 같은 근거로 이미 30 이고 read.ts:57 도 30 이다. 판정 결과는 불변(페이지 수만 줄어든다).
const FIRESTORE_IN_QUERY_LIMIT = 30;
// W58-C [Codex 적대 리뷰 · CRITICAL]: `sent_evidence_pending` 은 **SMTP 가 이미 성공한 상태**다.
// chat-ai.ts 는 이력 원장 기록이 실패하면 이 상태로 표시하고 `recordProgramOutreachSend` **전에**
// 반환한다 — 즉 dedup SoT(program_outreach_dedup)에 아무것도 안 남는다. 그 자리의 주석은
// "campaign_outreach 의 sent row 폴백이 보장하므로 재발송 구멍이 아니다"라고 적혀 있었지만,
// **그 폴백이 이 상태를 몰랐다**(여기 집합에 없었다). 그래서 같은 사람의 다른 승인 행이 다음 pass 에
// 실제로 다시 나갈 수 있었다(프로드 현재 이 상태 28행 보유).
// 판정은 fail-closed 여야 한다 — "보냈는지 모호하면 보내지 않는다"가 철칙 R5-B 의 방향이다.
// admin.ts 의 CAMPAIGN_OUTREACH_TOUCH_STATES·CAMPAIGN_REFILL_COUNTED_STATES 는 W10 F-3 에서
// 이미 같은 이유로 포함했다 — 발송 시점 집합만 빠져 있었다.
const SENT_OUTREACH_STATES = new Set(["sent", "mock_sent", "sent_evidence_pending"]);

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:@-]+/g, "_").slice(0, 200);
}

// T0-1: campaignArbiter.ts:359 campaignInventoryTargetPath 의 판정을 그대로 미러링한다(우선순위
// candidateId → creatorId → targetId, safe() 새니타이즈, `__` 구분자, 100자 상한 — 전부 동일).
// 그 함수를 직접 import 하지 못한 이유: 이 수리는 campaignArbiter.ts 를 읽기 전용 경계로 받았다
// (동시에 다른 세션이 admin.ts/chat-ai.ts/campaigns.ts 를 고치는 중이라 campaignArbiter.ts 의 export
// 표면을 건드리면 충돌 위험이 있다). export 하나 추가하는 것만으로 끝나는 변경이라, 그 파일을 다음에
// 만질 세션이 이 미러를 지우고 원본을 import 하도록 교체하면 된다.
/** 타깃 문서 경로. 테스트가 **실제 outreach 행 모양**으로 이 규약을 검증할 수 있게 내보낸다. */
export function programCampaignTargetPath(row: Record<string, unknown>): string {
  const programId = asString(row.canonicalProgramId) || asString(row.programId);
  const targetId = asString(row.candidateId) || asString(row.creatorId) || asString(row.targetId);
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "item";
  return programId && targetId ? `program_campaign_targets/${safe(programId)}__${safe(targetId)}` : "";
}

// T0-2 [실제 발송 경로 소비 표시]: `campaign_candidates` 문서 ID 는 candidateScope.ts
// campaignCandidateLinkId 의 sha256 해시(`ccl_<40hex>`)라 candidateId 로 재계산할 수 없다(위
// programCampaignTargetPath 와 달리 여기는 경로를 "만들지" 않고 "검증"만 한다). outreach 행이
// 생성 시점에 이미 들고 있는 `campaignCandidateRef` 필드(admin.ts 캠페인 생성 시
// target.campaignCandidateRef 를 그대로 스탬프)를 그대로 쓰되, 임의 문자열로 Firestore 경로를
// 구성하지 않도록 형식만 좁게 검증한다(campaigns.ts sanitizeCandidateLinks 와 동형 정규식).
export function validCampaignCandidateRef(value: string): string {
  const ref = (value ?? "").trim();
  const prefix = "campaign_candidates/";
  if (!ref.startsWith(prefix)) return "";
  return /^[A-Za-z0-9_-]{1,180}$/.test(ref.slice(prefix.length)) ? ref : "";
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => (value ?? "").trim()).filter(Boolean))];
}

function chunkStrings(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function sentOutreachState(data: Record<string, unknown>): boolean {
  return SENT_OUTREACH_STATES.has(asString(data.deliveryState) || asString(data.status));
}

// 크로스-프로그램 dedup용 안정적 크리에이터 키. approval/send-time에서는 사용 가능한
// 모든 식별자(creator/email/candidate)를 검사한다. primary key는 기존 SoT doc-id 호환용이다.
export function resolveCreatorDedupKeys(data: Record<string, unknown>): string[] {
  const creatorId = asString(data.creatorId);
  const email = (asString(data.creatorEmail) || asString(data.to) || asString(data.email)).toLowerCase();
  const candidateId = asString(data.candidateId);
  return uniqueStrings([
    creatorId ? `creator:${creatorId}` : "",
    email.includes("@") ? `email:${email}` : "",
    candidateId ? `candidate:${candidateId}` : "",
  ]);
}

export function resolveCreatorDedupKey(data: Record<string, unknown>): string {
  return resolveCreatorDedupKeys(data)[0] ?? "";
}

export function programDedupDocId(programId: string, creatorKey: string): string {
  return `${safeSegment(programId || DEFAULT_PROGRAM_ID)}__${safeSegment(creatorKey)}`;
}

// 캠페인/프로그램 문서에서 예외 플래그를 읽는다(campaignAllowsInflyOverlap와 동형).
export function campaignAllowsResendInProgram(data: Record<string, unknown>): boolean {
  const record = (typeof data === "object" && data !== null) ? data : {};
  const mailProfile = (typeof record.mailProfile === "object" && record.mailProfile !== null) ? record.mailProfile as Record<string, unknown> : {};
  const targetingCriteria = (typeof record.targetingCriteria === "object" && record.targetingCriteria !== null) ? record.targetingCriteria as Record<string, unknown> : {};
  return record.allowResendInProgram === true
    || mailProfile.allowResendInProgram === true
    || targetingCriteria.allowResendInProgram === true;
}

export type OutreachDedupScope = "global" | "program";

// 헤세 결정 2026-09-16: 프로그램 스코프 독립 — XP Hero 수신자를 Snake Clash×Pororo 캠페인에서
// 재사용할 수 있게 하는 운영자 옵트인 토글. settings.automation.outreachDedupScope 가 정확히
// "program" 일 때만 "program"이고, 그 외(키 없음/undefined/오타/과거 값)는 전부 "global"로
// fail-closed 한다 — 이 판정이 R5-B 전역 차단을 바꾸는 유일한 스위치다.
export function resolveOutreachDedupScope(
  settings: { automation?: { outreachDedupScope?: unknown } } | null | undefined,
): OutreachDedupScope {
  return settings?.automation?.outreachDedupScope === "program" ? "program" : "global";
}

export type OutreachDedupContext = {
  programId: string;
  allowResendInProgram: boolean;
  creatorKey: string;
  creatorKeys: string[];
  scope: OutreachDedupScope;
};

// 발송 대상 doc(campaign_outreach 등)에서 dedup 판정에 필요한 컨텍스트를 해소한다.
// programId/allowResendInProgram이 doc에 없으면(레거시) campaignId→campaigns 문서를 1회 읽어 폴백한다.
// scope는 호출부가 settings에서 한 번 해소해 넘긴다(행마다 readSettings를 다시 하지 않는다) —
// 생략하면 기존 동작과 동일한 "global"이다.
export async function resolveOutreachDedupContext(
  data: Record<string, unknown>,
  scope: OutreachDedupScope = "global",
): Promise<OutreachDedupContext> {
  const creatorKeys = resolveCreatorDedupKeys(data);
  const creatorKey = creatorKeys[0] ?? "";
  let programId = asString(data.programId);
  let allowResendInProgram = campaignAllowsResendInProgram(data);
  const campaignId = asString(data.campaignId);
  if ((!programId || !allowResendInProgram) && campaignId) {
    try {
      const snapshot = await adminDb.collection("campaigns").doc(campaignId).get();
      const campaign = snapshot.data() ?? {};
      if (!programId) programId = asString(campaign.programId);
      if (!allowResendInProgram) allowResendInProgram = campaignAllowsResendInProgram(campaign);
    } catch {
      // 캠페인 조회 실패 시 안전측(전역 차단) 기본값 유지.
    }
  }
  if (!programId) programId = DEFAULT_PROGRAM_ID;
  return { programId, allowResendInProgram, creatorKey, creatorKeys, scope };
}

// creatorKey 입력 정규화. programCreatorAlreadySent는 레거시 호출 호환용이며 live-send 경로는 creatorSentInAnyProgram으로 전역 차단한다.
function normalizeCreatorKeys(creatorKeyOrKeys: string | string[] | undefined): string[] {
  return Array.isArray(creatorKeyOrKeys) ? uniqueStrings(creatorKeyOrKeys) : uniqueStrings([creatorKeyOrKeys ?? ""]);
}

export async function programCreatorAlreadySent(programId: string, creatorKeyOrKeys: string | string[]): Promise<boolean> {
  const creatorKeys = normalizeCreatorKeys(creatorKeyOrKeys);
  if (creatorKeys.length === 0) return false;
  for (let index = 0; index < creatorKeys.length; index += GETALL_CHUNK) {
    const chunk = creatorKeys.slice(index, index + GETALL_CHUNK);
    const refs = chunk.map((key) => adminDb.collection(DEDUP_COLLECTION).doc(programDedupDocId(programId, key)));
    // perf(2026-09-17): 존재 여부만 본다(snapshot.exists) — 필드 값은 쓰지 않으므로 최소 필드로
    // 전송량을 줄인다(판정은 불변, snapshot.exists 는 fieldMask 와 무관하게 항상 정확하다).
    const snapshots = await adminDb.getAll(...refs, { fieldMask: ["creatorKey"] });
    if (snapshots.some((snapshot) => snapshot.exists)) return true;
  }
  return false;
}

// 어느 프로그램에서든 콜드 발송된 적이 있는가(전역 차단 철칙 강제).
export async function creatorSentInAnyProgram(creatorKeyOrKeys: string | string[]): Promise<boolean> {
  const creatorKeys = normalizeCreatorKeys(creatorKeyOrKeys);
  if (creatorKeys.length === 0) return false;
  for (let index = 0; index < creatorKeys.length; index += 10) {
    const chunk = creatorKeys.slice(index, index + 10);
    // perf(2026-09-17): !snapshot.empty 만 본다 — 필드 없이 key-only projection 으로 전송량을 줄인다.
    const snapshot = await adminDb.collection(DEDUP_COLLECTION).where("creatorKey", "in", chunk).select().limit(1).get();
    if (!snapshot.empty) return true;
  }
  return false;
}

/**
 * W75 승격 사전 필터: 어느 프로그램에서든 이미 접촉한 안정 키를 한 번의 bounded bulk 판정으로 읽는다.
 * 반환값은 입력 키 자체라 후보별로 정확히 귀속할 수 있다. 쓰기 0, 원문 메시지/메일 본문 0.
 */
export async function readCreatorKeysSentInAnyProgram(creatorKeyOrKeys: string[]): Promise<Set<string>> {
  const creatorKeys = normalizeCreatorKeys(creatorKeyOrKeys);
  const touched = new Set<string>();
  for (const chunk of chunkStrings(creatorKeys, FIRESTORE_IN_QUERY_LIMIT)) {
    const snapshot = await adminDb.collection(DEDUP_COLLECTION)
      .where("creatorKey", "in", chunk)
      .select("creatorKey")
      .get();
    for (const doc of snapshot.docs) {
      const creatorKey = asString(doc.data().creatorKey);
      if (creatorKey) touched.add(creatorKey);
    }
  }
  return touched;
}

/** W75: append-only coldmail 원장에서 이미 발송된 이메일만 bulk로 되찾는다. */
export async function readEmailsSentInColdmailHistory(emails: string[]): Promise<Set<string>> {
  const normalized = uniqueStrings(emails.map((email) => email.toLowerCase()).filter((email) => email.includes("@")));
  const touched = new Set<string>();
  for (const chunk of chunkStrings(normalized, FIRESTORE_IN_QUERY_LIMIT)) {
    const snapshot = await adminDb.collection(COLDMAIL_HISTORY_COLLECTION)
      .where("emailLower", "in", chunk)
      .select("emailLower")
      .get();
    for (const doc of snapshot.docs) {
      const email = asString(doc.data().emailLower).toLowerCase();
      if (email) touched.add(email);
    }
  }
  return touched;
}

/** W75: 이메일이 없어도 과거 콜드메일 행의 정규 YouTube 채널 URL이 같으면 재발굴하지 않는다. */
export async function readYoutubeUrlsSentInColdmailHistory(urls: string[]): Promise<Set<string>> {
  const normalized = uniqueStrings(urls.map(normalizePublicYouTubeChannelUrl));
  const touched = new Set<string>();
  for (const chunk of chunkStrings(normalized, FIRESTORE_IN_QUERY_LIMIT)) {
    // 원장은 레거시 raw URL을 보유할 수 있으므로, 같은 원장에서 파생된 정규 projection도 함께 본다.
    // history 직접 조회는 현행 행을, projection 조회는 www/슬래시 변형이 있던 과거 행을 닫는다.
    const snapshots = await Promise.all([
      adminDb.collection(COLDMAIL_HISTORY_COLLECTION).where("youtubeUrl", "in", chunk).select("youtubeUrl").get(),
      adminDb.collection(COLDMAIL_HISTORY_PROJECTION_COLLECTION).where("youtubeUrl", "in", chunk).select("youtubeUrl").get(),
    ]);
    for (const doc of snapshots.flatMap((snapshot) => snapshot.docs)) {
      const url = normalizePublicYouTubeChannelUrl(doc.data().youtubeUrl);
      if (url) touched.add(url);
    }
  }
  return touched;
}

// scope==="program"일 때만 쓰는 판정: 행의 programId(레거시로 없으면 DEFAULT_PROGRAM_ID로 귀속)가
// context.programId와 같은가. scope!=="program"이면(기본 "global") 항상 통과 — 기존 동작 그대로다.
// export: chat-ai.ts의 creatorAlreadyContacted(live-send 직전 in-flight/기발송 가드)와 admin.ts의
// outreachEvidenceProgramId(적대 리뷰 2026-09-16 MEDIUM)가 "programId 없는 레거시 행은
// DEFAULT_PROGRAM_ID로 귀속" 규칙을 여기 한 곳에서 재사용한다 — 판정 fork 금지.
export function outreachRowMatchesScope(record: Record<string, unknown>, context: OutreachDedupContext): boolean {
  if (context.scope !== "program") return true;
  const rowProgramId = asString(record.programId) || DEFAULT_PROGRAM_ID;
  return rowProgramId === (context.programId || DEFAULT_PROGRAM_ID);
}

// HIGH-2(b) 이중 안전망 — dedup SoT(program_outreach_dedup)가 비어 있어도(recordProgramOutreachSend
// 실패/레거시 수동승인 row 등) 철칙이 새지 않도록, 발송 완료(sent/mock_sent) 이력을 campaign_outreach에서
// 직접 조회해 "이미 보낸 사람"을 fallback으로 잡는다. SoT 쓰기 성공에 의존하지 않는다.
// scope==="global"(기본)이면 어느 프로그램의 완료 발송이든 존재하면 전역 차단한다.
// scope==="program"이면 context.programId(레거시 행은 DEFAULT_PROGRAM_ID로 귀속)와 같은 행만 본다 —
// 복합 인덱스가 필요한 where 절을 추가하지 않고 select()로 받은 필드를 메모리에서 거른다.
export async function creatorSentInCampaignOutreach(
  data: Record<string, unknown>,
  context: OutreachDedupContext,
): Promise<boolean> {
  const email = (asString(data.creatorEmail) || asString(data.to) || asString(data.email)).toLowerCase();
  const candidateId = asString(data.candidateId);
  const creatorId = asString(data.creatorId);
  const queries: Array<{ field: string; value: string }> = [];
  if (email.includes("@")) {
    queries.push({ field: "creatorEmail", value: email });
    queries.push({ field: "to", value: email });
  }
  if (candidateId) queries.push({ field: "candidateId", value: candidateId });
  if (creatorId) queries.push({ field: "creatorId", value: creatorId });
  // 적대 리뷰 2026-09-16 MEDIUM: program 모드에서는 SoT(program_outreach_dedup)에 같은 프로그램
  // row가 없을 때만 여기까지 떨어지는데, 그때 identity당 전체 스캔은 비싸다. 새 복합 인덱스 없이
  // 완화하는 상한이다 — XP Hero 같은 대량 캠페인은 한 사람을 최근 몇 번(관측 2~3회) 재접촉하는
  // 수준이라 sent 상태 row가 identity당 수십 건을 넘지 않는다. SoT 문서가 1차 증거이고, 이 경로는
  // 그 SoT 기록이 실패했을 때만 쓰는 레거시 fallback이라 완전 스캔이 필요하지 않다.
  const IDENTITY_QUERY_LIMIT = 60;
  for (const query of queries) {
    const snapshot = await adminDb.collection("campaign_outreach")
      .where(query.field, "==", query.value)
      .select("deliveryState", "status", "programId")
      .limit(IDENTITY_QUERY_LIMIT)
      .get();
    for (const doc of snapshot.docs) {
      const record = doc.data() ?? {};
      if (sentOutreachState(record) && outreachRowMatchesScope(record, context)) return true;
    }
  }

  // Some legacy/manual rows only store the actual recipient in message_sources and
  // leave campaign_outreach.to/creatorEmail empty. Resolve that indirection too so
  // the global no-resend rule does not depend on denormalized row fields.
  if (email.includes("@")) {
    const messageSources = new Map<string, string>();
    for (const field of ["to", "creatorEmail", "email"]) {
      const snapshot = await adminDb.collection("message_sources")
        .where(field, "==", email)
        .select()
        .get();
      for (const doc of snapshot.docs) messageSources.set(doc.ref.path, doc.id);
    }
    const messageRefs = [...messageSources.keys()];
    for (const chunk of chunkStrings(messageRefs, FIRESTORE_IN_QUERY_LIMIT)) {
      if (chunk.length === 0) continue;
      // 위 IDENTITY_QUERY_LIMIT과 같은 이유 — messageRef 간접 조회도 identity당 무한정 스캔하지 않는다.
      const snapshot = await adminDb.collection("campaign_outreach")
        .where("messageRef", "in", chunk)
        .select("deliveryState", "status", "programId")
        .limit(IDENTITY_QUERY_LIMIT)
        .get();
      for (const doc of snapshot.docs) {
        const record = doc.data() ?? {};
        if (sentOutreachState(record) && outreachRowMatchesScope(record, context)) return true;
      }
    }
    const outreachIds = uniqueStrings([...messageSources.values()]);
    for (const chunk of chunkStrings(outreachIds, GETALL_CHUNK)) {
      if (chunk.length === 0) continue;
      const refs = chunk.map((id) => adminDb.collection("campaign_outreach").doc(id));
      const snapshots = await adminDb.getAll(...refs, {
        fieldMask: ["deliveryState", "status", "programId"],
      });
      for (const snapshot of snapshots) {
        if (!snapshot.exists) continue;
        const record = snapshot.data() ?? {};
        if (sentOutreachState(record) && outreachRowMatchesScope(record, context)) return true;
      }
    }
  }
  return false;
}

// PB-3(Opus MAJOR-2) 콜드스타트/레거시 fallback — dedup SoT도 campaign_outreach의 sent row도
// 없지만 scp_coldmail_history(appendScpColdmailHistory·과거 G1 발송)에만 발송 이력이 남은
// 접촉자를 send-time에 잡는다. scp_coldmail_history는 append-only "발송 이벤트" 원장이라 row
// 존재 자체가 "이미 콜드 접촉함"을 의미한다(deliveryState 필터 불필요). 신원은 이메일뿐이므로
// emailLower로 조회한다.
// scope==="global"(기본)이면 어느 프로그램의 콜드 히스토리든 존재하면 전역 차단한다.
// scope==="program"이면 행의 programId(appendScpColdmailHistory가 항상 정규화해서 쓰지만, 그
// 이전에 만들어진 진짜 레거시 행은 필드 자체가 없을 수 있어 DEFAULT_PROGRAM_ID로 귀속)가
// context.programId와 같을 때만 차단한다.
export async function creatorSentInColdmailHistory(
  data: Record<string, unknown>,
  context: OutreachDedupContext,
): Promise<boolean> {
  const email = (asString(data.creatorEmail) || asString(data.to) || asString(data.email)).toLowerCase();
  if (!email.includes("@")) return false;
  if (context.scope !== "program") {
    // perf(2026-09-17): !snapshot.empty 만 본다 — key-only projection.
    const snapshot = await adminDb.collection(COLDMAIL_HISTORY_COLLECTION).where("emailLower", "==", email).select().limit(1).get();
    return !snapshot.empty;
  }
  const contextProgramId = context.programId || DEFAULT_PROGRAM_ID;
  // 적대 리뷰 2026-09-16 MEDIUM: creatorSentInCampaignOutreach의 IDENTITY_QUERY_LIMIT과 같은 이유
  // (새 복합 인덱스 없이 완화) — 같은 이메일의 콜드메일 이력 행이 identity당 20건을 넘는 경우는
  // 드물고, 이 함수 자체가 SoT/campaign_outreach 둘 다 미스일 때만 도달하는 레거시 fallback이다.
  const snapshot = await adminDb.collection(COLDMAIL_HISTORY_COLLECTION)
    .where("emailLower", "==", email)
    .select("programId")
    .limit(20)
    .get();
  return snapshot.docs.some((doc) => (asString(doc.data().programId) || DEFAULT_PROGRAM_ID) === contextProgramId);
}

// 단일 호출 지점 — scope에 맞는 판정 조합을 대신 골라준다. context.scope는 호출부가 settings에서
// 미리(행마다 다시 읽지 않고) 한 번 해소해 resolveOutreachDedupContext에 넘긴 값이다.
//   scope==="program": 이 프로그램에서만 발송된 적 있는지(programCreatorAlreadySent) + 프로그램
//     필터링된 campaign_outreach/scp_coldmail_history fallback.
//   scope==="global"(기본, 기존 동작 그대로): 어느 프로그램에서든 발송된 적 있는지
//     (creatorSentInAnyProgram) + 필터링 없는 campaign_outreach/scp_coldmail_history fallback.
// perf(2026-09-17 처리량 장애): 이 파일 헤더는 SoT(program_outreach_dedup)가 정본이 된 정확한
// 날짜/버전을 명시하지 않는다 — "SoT 미스면 두 fallback을 건너뛴다"는 규칙을 안전하게 판정할 근거가
// 없다는 뜻이다(잘못 판정하면 재발송 구멍 = R5-B 철칙 위반). 그래서 fallback은 그대로 유지하고,
// 세 조회를 **동시에** 실행한다 — 셋 다 읽기 전용·서로 독립이고 결과는 OR 이므로 순서·동시성이
// 바뀌어도 반환값은 불변이다. 유일한 트레이드오프: SoT 가 이미 true 인(발송 완료, 소수 경로) 경우
// fallback 두 개를 추가로 읽지만, 다수 경로(SoT 미스 = 첫 발송)의 지연이 그만큼 줄어든다 —
// program-scoped dedup 은 순차 실행 시 creatorSentInCampaignOutreach 하나만으로도 최대 7회
// 안팎의 직렬 Firestore 왕복(identity 필드 4개 + message_sources indirection)이 쌓일 수 있다.
export async function creatorSentInProgramScope(
  context: OutreachDedupContext,
  data: Record<string, unknown>,
): Promise<boolean> {
  const sotCheck = context.scope === "program"
    ? programCreatorAlreadySent(context.programId, context.creatorKeys)
    : creatorSentInAnyProgram(context.creatorKeys);
  const [sot, fallbackCampaignOutreach, fallbackColdmail] = await Promise.all([
    sotCheck,
    creatorSentInCampaignOutreach(data, context),
    creatorSentInColdmailHistory(data, context),
  ]);
  return sot || fallbackCampaignOutreach || fallbackColdmail;
}

// HIGH-2(a) SoT 기록 실패를 조용히 로그만 남기지 않고 durable 마커로 표면화한다(재처리/감사용).
// 발송 자체는 이미 완료됐고 campaign_outreach의 sent row가 fallback SoT로 동작하므로 철칙은 유지된다.
export async function recordProgramOutreachDedupFailure(params: {
  programId: string;
  creatorKey: string;
  campaignId?: string;
  trackingId?: string;
  refPath?: string;
  error: string;
  failedAtIso?: string;
}): Promise<void> {
  const programId = params.programId || DEFAULT_PROGRAM_ID;
  const trackingId = asString(params.trackingId);
  const id = safeSegment(`${programId}__${params.creatorKey}__${trackingId || Date.now().toString(36)}`);
  await adminDb.collection(`${DEDUP_COLLECTION}_failures`).doc(id).set({
    id,
    programId,
    creatorKey: params.creatorKey,
    campaignId: asString(params.campaignId),
    trackingId,
    refPath: asString(params.refPath),
    error: params.error.slice(0, 500),
    reconcilePending: true,
    failedAtIso: params.failedAtIso ?? new Date().toISOString(),
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// 레거시 호환 helper: 주어진 creatorKey들 중 이 프로그램에서 이미 발송된 것들.
export async function readProgramTouchedKeys(programId: string, creatorKeys: string[]): Promise<Set<string>> {
  const touched = new Set<string>();
  const unique = [...new Set(creatorKeys.filter(Boolean))];
  for (let index = 0; index < unique.length; index += GETALL_CHUNK) {
    const chunk = unique.slice(index, index + GETALL_CHUNK);
    const refs = chunk.map((key) => adminDb.collection(DEDUP_COLLECTION).doc(programDedupDocId(programId, key)));
    const snapshots = await adminDb.getAll(...refs);
    snapshots.forEach((snapshot, offset) => {
      if (snapshot.exists) touched.add(chunk[offset]);
    });
  }
  return touched;
}

// 발송 성공 후 "크리에이터 C가 프로그램 P에서 콜드 발송됨" 사실을 멱등 기록한다.
// firstSentAtIso는 최초 1회만(불변), lastSentAtIso는 동일 사실 재관측 시 갱신.
export async function recordProgramOutreachSend(params: {
  programId: string;
  creatorKey: string;
  campaignId?: string;
  creatorId?: string;
  candidateId?: string;
  email?: string;
  trackingId?: string;
  sentAtIso?: string;
  campaignCandidateRef?: string;
}): Promise<{ firstSend: boolean }> {
  const creatorKey = params.creatorKey;
  if (!creatorKey) return { firstSend: false };
  const programId = params.programId || DEFAULT_PROGRAM_ID;
  const id = programDedupDocId(programId, creatorKey);
  const ref = adminDb.collection(DEDUP_COLLECTION).doc(id);
  const sentAtIso = params.sentAtIso ?? new Date().toISOString();
  // T0-1 실측: 이 원장 기록만 하고 program_campaign_targets 의 소비 표시(status:"ready")를 갱신하지
  // 않아, admin.ts filterUntouchedCampaignTargets 가 매 pass 이미 발송된 타깃(관측 363건)을 다시
  // 조회 대상에 넣고 있었다. status 는 캐시일 뿐이고 이 dedup 원장이 권위다.
  //
  // ⚠️ 26-08-28 [리뷰 지적 · 주석 정정]: 타깃 write-back 은 **원장과 같은 트랜잭션**이다. 아래
  //   try/catch 는 `tx.get` 실패만 흡수하고, `tx.set` 은 동기 버퍼링이라 던지지 않는다 — 즉
  //   타깃 문서의 경합·권한 오류는 **원장 커밋까지 함께 실패시킨다**. 종전 주석은 "실패해도 원장에
  //   영향 없다"고 적었으나 코드는 그렇지 않았다.
  //   그래도 같은 커밋을 유지하는 쪽을 택한다: 분리하면 원장은 기록됐는데 status 가 안 바뀌는
  //   드리프트 창이 생기고, 그 창이 정확히 이 수리가 없애려는 상태(발송했는데 ready 로 남음)다.
  //   실패 시 재시도는 상위 호출부가 담당하고, 재시도해도 원장이 재발송을 막으므로
  //   **발송이 중복되는 방향으로는 여전히 실패하지 않는다**.
  const targetPath = programCampaignTargetPath({
    canonicalProgramId: programId,
    candidateId: params.candidateId,
    creatorId: params.creatorId,
  });
  const targetRef = targetPath ? adminDb.doc(targetPath) : null;
  // T0-2: `program_campaign_targets` 문서 없이 나가는 발송(프로드 실측 98%)은 위 targetRef
  // write-back 이 절대 닿지 않는다 — 그 발송의 유일한 참여 문서는 `campaign_candidates` 자신이고,
  // 프로드 실측(sent 상태 표본 28/28)으로 확인한바 그 문서의 stage 는 발송 후에도 "discovered"로
  // 방치돼 있다. 경로는 추측하지 않는다 — `campaign_candidates` 문서 ID 는 sha256 해시라 candidateId
  // 로 재계산 불가능하고, outreach 행이 생성 시점에 이미 들고 있는 campaignCandidateRef 필드(admin.ts
  // 캠페인 생성 시 target.campaignCandidateRef 스탬프)를 그대로 쓴다.
  const candidateRef = validCampaignCandidateRef(params.campaignCandidateRef ?? "");
  const candidateDocRef = candidateRef ? adminDb.doc(candidateRef) : null;
  const firstSend = await adminDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    // Firestore 트랜잭션은 모든 get 이 set 보다 앞서야 한다 — 타깃/후보 문서 read 도 여기서 먼저 끝낸다.
    let targetSnapshot: FirebaseFirestore.DocumentSnapshot | null = null;
    if (targetRef) {
      try {
        targetSnapshot = await tx.get(targetRef);
      } catch {
        targetSnapshot = null;
      }
    }
    let candidateSnapshot: FirebaseFirestore.DocumentSnapshot | null = null;
    if (candidateDocRef) {
      try {
        candidateSnapshot = await tx.get(candidateDocRef);
      } catch {
        candidateSnapshot = null;
      }
    }
    if (snapshot.exists) {
      tx.set(ref, {
        lastSentAtIso: sentAtIso,
        sendCount: FieldValue.increment(1),
        lastTrackingId: asString(params.trackingId),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      tx.set(ref, {
        id,
        programId,
        creatorKey,
        campaignId: asString(params.campaignId),
        creatorId: asString(params.creatorId),
        email: asString(params.email).toLowerCase(),
        firstTrackingId: asString(params.trackingId),
        lastTrackingId: asString(params.trackingId),
        firstSentAtIso: sentAtIso,
        lastSentAtIso: sentAtIso,
        sendCount: 1,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (targetRef && targetSnapshot?.exists && asString(targetSnapshot.data()?.status) === "ready") {
      try {
        tx.set(targetRef, {
          status: "contacted",
          contactedAtIso: sentAtIso,
          updatedAtIso: sentAtIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch {
        // 캐시 write-back 실패는 삼킨다 — 위 주석대로 원장 커밋에 영향을 주면 안 된다.
      }
    }
    // T0-2: 같은 성질(캐시일 뿐, 이 dedup 원장이 권위) · 같은 안전 계약(위 target 케이스와 동형) —
    // "discovered" 일 때만 "contacted"로 바뀐다. 다른 stage(예: 이후 스테이지로 이미 전진한 후보)는
    // 불가침이다.
    if (candidateDocRef && candidateSnapshot?.exists && asString(candidateSnapshot.data()?.stage) === "discovered") {
      try {
        tx.set(candidateDocRef, {
          stage: "contacted",
          contactedAtIso: sentAtIso,
          updatedAtIso: sentAtIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch {
        // 소비 표시 write-back 실패는 삼킨다 — 원장 커밋에 영향을 주면 안 된다.
      }
    }
    return !snapshot.exists;
  });

  return { firstSend };
}
