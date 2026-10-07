import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromFunctions = createRequire(join(here, "..", "functions", "package.json"));
const admin = requireFromFunctions("firebase-admin");
const { SEED_COLLECTIONS } = await import(new URL("../functions/lib/seedData.js", import.meta.url));

const PROJECT_ID = "demo-flu";
const UID = "flu-emulator-admin";
const EMAIL = "test-admin@demo-flu";
const PASSWORD = "test1234";
const CLAIMS = { role: "super_admin", team: "AIX" };
const ADMIN_ACCOUNT = { uid: UID, email: EMAIL, password: PASSWORD, claims: CLAIMS };
const STAGING_AUTH_TENANT_ID = "flu-staging-emulator";
const BULK_SEED_ID = "flu-emulator-bulk";
const FIXTURE_SEED_ID = "flu-emulator-operational-hardening";

// Flu/Task-61 — QA가 Growth/AI Drama 조직 스코프(탭 프리셋·메일 계정 라우팅)를 실 로그인으로
// 검증할 수 있는 로그인 가능 테스트 계정 3개. 전부 @demo-flu 테스트 전용 이메일(실계정 이메일
// 재사용 금지 — 개인정보/오인 소지). orgId 판정은 이메일 → Peoply getPerson → primaryMembership
// 순인데, 에뮬레이터엔 PEOPLY_API_KEY가 없어 항상 실패했다 — functions/peoplyClient.ts의
// 에뮬레이터 전용 Peoply 픽스처(EMULATOR_PEOPLY_FIXTURE_BY_EMAIL)가 아래와 정확히 같은 이메일만
// 인식한다. 이메일을 바꾸면 그 상수도 함께 바꿔야 한다.
const GROWTH_MANAGER_ACCOUNT = {
  uid: "flu-emulator-growth-manager",
  email: "test-growth-manager@demo-flu",
  password: PASSWORD,
  claims: { role: "manager", team: "Growth" },
};
// Peoply 픽스처가 이 이메일을 orgId "org-ai-drama"로 해석한다 — settings/mail_routing·
// settings/org_tab_presets·settings/youtube_quota_pools 시드가 같은 orgId를 쓴다(아래
// appendOrgScopeTestAccountFixtures).
const DRAMA_MANAGER_ACCOUNT = {
  uid: "flu-emulator-drama-manager",
  email: "test-drama-manager@demo-flu",
  password: PASSWORD,
  claims: { role: "manager", team: "AI Drama" },
};
const DRAMA_ORG_ID = "org-ai-drama";
// Peoply 픽스처에 없는 이메일 = primaryMembership 미확인(peoply_error/no_primary_membership과
// 동일 효과) — actorOrgId가 항상 null인 "미매핑" 케이스를 재현한다.
const UNMAPPED_VIEWER_ACCOUNT = {
  uid: "flu-emulator-unmapped-viewer",
  email: "test-unmapped-viewer@demo-flu",
  password: PASSWORD,
  claims: { role: "viewer", team: "—" },
};
const ORG_SCOPE_QA_ACCOUNTS = [GROWTH_MANAGER_ACCOUNT, DRAMA_MANAGER_ACCOUNT, UNMAPPED_VIEWER_ACCOUNT];
// AI Drama 매니저가 self-linked(① 우선순위)로 연결해 둔 개인 메일함 — mail_accounts 문서의
// mailbox는 ACCOUNT_MAILBOX_PATTERN(도메인에 점 필수)을 통과해야 해 로그인 이메일(@demo-flu)과는
// 다른 값을 쓴다. ownerEmail만 로그인 이메일과 정확히 일치하면 된다(resolveMailAccountForEmail의
// ① 매칭 기준).
const DRAMA_PERSONAL_MAILBOX_ACCOUNT_ID = "test-drama-personal";
const DRAMA_PERSONAL_MAILBOX = "test-drama-manager@demo-flu.test";
const BULK_DEFAULTS = {
  creators: 10000,
  videos: 30000,
  programs: 25,
  applications: 5000,
  conversations: 10000,
  conversationsMessages: 100000,
  campaigns: 100,
  candidates: 1000,
};

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error("[seed] FIREBASE_AUTH_EMULATOR_HOST is not set — run via `firebase emulators:exec`.");
  process.exit(1);
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("[seed] FIRESTORE_EMULATOR_HOST is not set — run via `firebase emulators:exec`.");
  process.exit(1);
}

admin.initializeApp({ projectId: PROJECT_ID });
const authAdmin = admin.auth();
const stagingAuthAdmin = authAdmin.tenantManager().authForTenant(STAGING_AUTH_TENANT_ID);
const db = admin.firestore();
const bulkConfig = parseBulkConfig(process.argv.slice(2));

function withIsoFields(doc) {
  const stampedAt = new Date().toISOString();
  const createdAtIso = typeof doc.createdAtIso === "string" && doc.createdAtIso ? doc.createdAtIso : stampedAt;
  const updatedAtIso = typeof doc.updatedAtIso === "string" && doc.updatedAtIso ? doc.updatedAtIso : createdAtIso;
  return { ...doc, createdAtIso, updatedAtIso };
}

function stripUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter((entry) => entry[1] !== undefined));
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

function parseBulkConfig(args) {
  const bulkIndex = args.indexOf("--bulk");
  if (bulkIndex < 0) return null;
  const config = { ...BULK_DEFAULTS };
  for (const arg of args.slice(bulkIndex + 1)) {
    if (arg.startsWith("--")) break;
    const [rawKey, rawValue] = arg.split("=");
    if (!rawKey || rawValue === undefined || !(rawKey in config)) continue;
    config[rawKey] = positiveInt(rawValue, config[rawKey]);
  }
  return config;
}

function isoFromOffset(index) {
  return new Date(Date.UTC(2026, 5, 25, 0, 0, 0) - index * 1000).toISOString();
}

function bulkCreatorId(index) {
  return `cr_UCFLU${String(index).padStart(6, "0")}`;
}

function bulkProgramId(index) {
  return `pg-bulk-${String(index).padStart(4, "0")}`;
}

function bulkCampaignId(index) {
  return `cp-bulk-${String(index).padStart(4, "0")}`;
}

function appendBulkDoc(ops, counts, collection, id, data) {
  counts[collection] = (counts[collection] ?? 0) + 1;
  ops.push((batch) => batch.set(db.collection(collection).doc(id), stripUndefined(withIsoFields({
    ...data,
    id,
    seedId: BULK_SEED_ID,
    bulkSeed: true,
    seededAt: new Date().toISOString(),
  }))));
}

function appendBulkSubdoc(ops, counts, path, data) {
  counts[path] = (counts[path] ?? 0) + 1;
  ops.push((batch) => batch.set(db.doc(path), stripUndefined(withIsoFields({
    ...data,
    seedId: BULK_SEED_ID,
    bulkSeed: true,
    seededAt: new Date().toISOString(),
  }))));
}

function appendBulkSeedOps(ops, counts, config) {
  if (!config) return;
  for (let index = 0; index < config.creators; index += 1) {
    const ordinal = index + 1;
    const id = bulkCreatorId(ordinal);
    appendBulkDoc(ops, counts, "creators", id, {
      name: `Bulk Creator ${ordinal}`,
      handle: `@bulk_creator_${ordinal}`,
      email: `bulk-${ordinal}@example.com`,
      type: "influencer",
      avatar: "B",
      platform: "YouTube",
      primaryPlatform: "YouTube",
      channelId: `UCFLU${String(ordinal).padStart(6, "0")}`,
      youtubeUrl: `https://www.youtube.com/@bulk_creator_${ordinal}`,
      followers: 1000 + ordinal,
      region: ordinal % 3 === 0 ? "US" : "KR",
      category: ordinal % 2 === 0 ? "Puzzle" : "Mobile Game/XPHERO",
      stage: ordinal % 5 === 0 ? "contract" : "contact",
      owner: ordinal % 4 === 0 ? "시몬" : "헤세",
      team: "AIX",
      guideStatus: "within",
      aiHandling: ordinal % 7 !== 0,
      createdAtIso: isoFromOffset(ordinal + 100000),
      updatedAtIso: isoFromOffset(ordinal),
    });
  }

  for (let index = 0; index < config.candidates; index += 1) {
    const ordinal = index + 1;
    const id = `cand_UCFLU${String(ordinal).padStart(6, "0")}`;
    appendBulkDoc(ops, counts, "candidate_pool", id, {
      name: `Bulk Candidate ${ordinal}`,
      handle: `@bulk_candidate_${ordinal}`,
      email: `candidate-${ordinal}@example.com`,
      platform: "YouTube",
      channelId: `UCFLUCAND${String(ordinal).padStart(6, "0")}`,
      followers: 500 + ordinal,
      region: ordinal % 3 === 0 ? "JP" : "KR",
      category: "Mobile Game/XPHERO",
      matchScore: 60 + (ordinal % 40),
      source: "bulk-emulator",
      createdAtIso: isoFromOffset(ordinal + 90000),
      updatedAtIso: isoFromOffset(ordinal + 1000),
    });
  }

  for (let index = 0; index < config.videos; index += 1) {
    const ordinal = index + 1;
    const creatorOrdinal = config.creators > 0 ? ((index % config.creators) + 1) : ordinal;
    const id = `bulk-video-${String(ordinal).padStart(7, "0")}`;
    appendBulkDoc(ops, counts, "videos", id, {
      videoId: id,
      creatorId: bulkCreatorId(creatorOrdinal),
      title: `Bulk creator gameplay ${ordinal}`,
      views: 1000 + ordinal * 3,
      likes: 100 + (ordinal % 1000),
      comments: 10 + (ordinal % 300),
      published: isoFromOffset(ordinal).slice(0, 10),
      publishedIso: isoFromOffset(ordinal),
      thumb: "B",
      source: "bulk-emulator",
    });
  }

  for (let index = 0; index < config.campaigns; index += 1) {
    const ordinal = index + 1;
    const programOrdinal = config.programs > 0 ? ((index % config.programs) + 1) : 1;
    const queued = ordinal % 9;
    const sent = 20 + ordinal;
    const replied = ordinal % 17;
    const negotiating = ordinal % 11;
    const contracted = ordinal % 5;
    const live = ordinal % 3;
    const total = queued + sent + replied + negotiating + contracted + live;
    appendBulkDoc(ops, counts, "campaigns", bulkCampaignId(ordinal), {
      name: `Bulk Campaign ${ordinal}`,
      programId: config.programs > 0 ? bulkProgramId(programOrdinal) : undefined,
      owner: ordinal % 2 === 0 ? "헤세" : "시몬",
      source: "bulk-emulator",
      status: ordinal % 4 === 0 ? "완료" : "발송중",
      priority: ordinal % 3 === 0 ? "높음" : "보통",
      queued,
      sent,
      replied,
      negotiating,
      contracted,
      live,
      total,
      bounced: ordinal % 4,
      counterSource: "syncCampaignFunnel",
      createdAtIso: isoFromOffset(ordinal + 80000),
      updatedAtIso: isoFromOffset(ordinal + 2000),
    });
  }

  for (let index = 0; index < config.programs; index += 1) {
    const ordinal = index + 1;
    const id = bulkProgramId(ordinal);
    appendBulkDoc(ops, counts, "programs", id, {
      slug: `bulk-program-${ordinal}`,
      title: `Bulk Program ${ordinal}`,
      status: "open",
      brief: "대량 신청자 페이지네이션과 승인 플로우 검증용 프로그램입니다.",
      gameTitle: "XPHERO",
      owner: "헤세",
      rewardKRW: 2300000,
      kpiMetric: "approved",
      kpiTarget: Math.max(1, Math.ceil(config.applications / Math.max(1, config.programs))),
      tags: ["bulk", "emulator", "program"],
      applicationCount: 0,
      approvedCount: 0,
      contractCount: 0,
      reviewCount: 0,
      publicApplyPath: `/programs/bulk-program-${ordinal}/apply`,
      programAi: {
        enabled: true,
        dryRunDefault: true,
        defaultTone: "정중·간결",
        defaultFormat: "프로그램명 → 참여 혜택 → 다음 액션",
        learningTags: ["bulk"],
        maxPerProgramDailySends: 10,
        minProgramReplyDelayMinutes: 60,
        programTemplateNotes: ["bulk stress"],
      },
      createdAtIso: isoFromOffset(ordinal + 70000),
      updatedAtIso: isoFromOffset(ordinal + 3000),
    });
  }

  const applicationCounts = new Map();
  const approvedCounts = new Map();
  for (let index = 0; index < config.applications; index += 1) {
    const ordinal = index + 1;
    const programOrdinal = config.programs > 0 ? ((index % config.programs) + 1) : 1;
    const programId = bulkProgramId(programOrdinal);
    const status = ordinal % 10 === 0 ? "approved" : ordinal % 13 === 0 ? "hold" : ordinal % 17 === 0 ? "rejected" : "pending";
    applicationCounts.set(programId, (applicationCounts.get(programId) ?? 0) + 1);
    if (status === "approved") approvedCounts.set(programId, (approvedCounts.get(programId) ?? 0) + 1);
    appendBulkDoc(ops, counts, "program_applications", `${programId}-bulk-app-${String(ordinal).padStart(6, "0")}`, {
      programId,
      programSlug: `bulk-program-${programOrdinal}`,
      programTitle: `Bulk Program ${programOrdinal}`,
      status,
      creatorId: status === "approved" ? bulkCreatorId((ordinal % Math.max(1, config.creators)) + 1) : undefined,
      name: `Bulk Applicant ${ordinal}`,
      email: `bulk-app-${ordinal}@example.com`,
      handle: `@bulk_applicant_${ordinal}`,
      youtubeUrl: `https://www.youtube.com/@bulk_applicant_${ordinal}`,
      platform: "YouTube",
      followers: 2000 + ordinal,
      region: "KR",
      category: "Mobile Game/XPHERO",
      pitch: `Bulk application ${ordinal}`,
      avatar: "A",
      submittedAtIso: isoFromOffset(ordinal + 50000),
      updatedAtIso: isoFromOffset(ordinal + 4000),
    });
  }

  for (const [programId, applicationCount] of applicationCounts.entries()) {
    counts.program_rollups = (counts.program_rollups ?? 0) + 1;
    ops.push((batch) => batch.set(db.collection("programs").doc(programId), {
      applicationCount,
      approvedCount: approvedCounts.get(programId) ?? 0,
      updatedAtIso: new Date().toISOString(),
    }, { merge: true }));
  }

  for (let index = 0; index < config.conversations; index += 1) {
    const ordinal = index + 1;
    const creatorOrdinal = config.creators > 0 ? ((index % config.creators) + 1) : ordinal;
    const campaignOrdinal = config.campaigns > 0 ? ((index % config.campaigns) + 1) : 1;
    const programOrdinal = config.programs > 0 ? ((campaignOrdinal - 1) % config.programs) + 1 : 1;
    const id = `bulk-conv-${String(ordinal).padStart(6, "0")}`;
    appendBulkDoc(ops, counts, "conversations", id, {
      creatorId: bulkCreatorId(creatorOrdinal),
      creatorName: `Bulk Creator ${creatorOrdinal}`,
      creatorEmail: `bulk-${creatorOrdinal}@example.com`,
      creatorHandle: `@bulk_creator_${creatorOrdinal}`,
      creatorPlatform: "YouTube",
      creatorFollowers: 1000 + creatorOrdinal,
      programId: config.programs > 0 ? bulkProgramId(programOrdinal) : undefined,
      campaignId: config.campaigns > 0 ? bulkCampaignId(campaignOrdinal) : undefined,
      unread: ordinal % 4,
      aiActive: ordinal % 5 !== 0,
      messages: [],
      lastMessage: `Bulk conversation preview ${ordinal}`,
      lastMessageAtIso: isoFromOffset(ordinal),
      lastMessageFrom: ordinal % 2 === 0 ? "creator" : "ai",
      updatedAtIso: isoFromOffset(ordinal),
    });
  }

  if (config.conversationsMessages > 0) {
    const conversationId = "bulk-long-thread";
    appendBulkDoc(ops, counts, "conversations", conversationId, {
      creatorId: bulkCreatorId(1),
      creatorName: "Bulk Long Thread",
      creatorHandle: "@bulk_long_thread",
      creatorPlatform: "YouTube",
      creatorFollowers: 123456,
      unread: 0,
      aiActive: true,
      messages: [],
      lastMessage: `Long thread message ${config.conversationsMessages}`,
      lastMessageAtIso: isoFromOffset(1),
      lastMessageFrom: "creator",
      updatedAtIso: isoFromOffset(1),
    });
    for (let index = 0; index < config.conversationsMessages; index += 1) {
      const ordinal = index + 1;
      appendBulkSubdoc(ops, counts, `conversations/${conversationId}/messages/msg-${String(ordinal).padStart(5, "0")}`, {
        id: `msg-${String(ordinal).padStart(5, "0")}`,
        from: ordinal % 2 === 0 ? "creator" : "ai",
        author: ordinal % 2 === 0 ? "Bulk Creator" : "Flu AI",
        text: `Long-thread stress message ${ordinal}`,
        time: "",
        createdAtIso: isoFromOffset(config.conversationsMessages - ordinal),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCP 운영 하드닝 픽스처 (P1/P4/P6/P7/P11 e2e 재현용, .omx/plans/test-spec-scp-operational-
// hardening-20260707T071712Z.md §3). autoReply/coldmail-history/token-only submission
// 픽스처가 전무해 관련 e2e가 재현 자체 불가능했던 갭을 메운다. 기존 SEED_COLLECTIONS는
// 절대 수정하지 않고 append만 한다 — 기존 e2e의 수치/이름 assert를 보존하기 위함.
// ─────────────────────────────────────────────────────────────────────────────
function appendFixtureDoc(ops, counts, collection, id, data) {
  counts[collection] = (counts[collection] ?? 0) + 1;
  ops.push((batch) => batch.set(db.collection(collection).doc(id), stripUndefined(withIsoFields({
    ...data,
    seedId: FIXTURE_SEED_ID,
    seededAt: new Date().toISOString(),
  }))));
}

// autoReply 픽스처(P4) — chat-ai.ts:1884-1904의 draft_only/blocked 상태 전이를 그대로 반영한다.
function appendAutoReplyFixtures(ops, counts) {
  // (a) draft_only: 자동 초안이 준비된 채 발송 전 대기 — autoReplyStatus="draft_only" + autoReplyDraftText.
  appendFixtureDoc(ops, counts, "conversations", "conv-autoreply-draft-only", {
    id: "conv-autoreply-draft-only",
    threadId: "conv-autoreply-draft-only",
    contextKey: "mail:conv-autoreply-draft-only",
    creatorId: "c-fixture-draftonly",
    creatorName: "Draftonly Creator",
    creatorEmail: "draftonly.creator@example.com",
    creatorHandle: "@draftonly_creator",
    creatorPlatform: "YouTube",
    type: "direct",
    primaryBucket: "direct",
    locale: "und",
    creatorFollowers: 82000,
    source: "operational-hardening-fixture",
    unread: 1,
    aiActive: true,
    hasCreatorReply: true,
    lastMessageFrom: "creator",
    lastMessageAtIso: "2026-06-24T01:20:00.000Z",
    lastInboundAtIso: "2026-06-24T01:20:00.000Z",
    autoReplyStatus: "draft_only",
    draftStatus: "draft_only",
    autoReplyDraftText: "안녕하세요! 협업 제안 주셔서 감사합니다. 가이드 범위 내 단가로 우선 회신 초안을 준비했습니다 — 발송 전 검토 부탁드립니다.",
    draftRef: "auto_reply_queue/conv-autoreply-draft-only-draft",
    messages: [
      { id: "m1", from: "human", author: "헤세", time: "10:00", createdAtIso: "2026-06-24T01:00:00.000Z", text: "신작 협업 제안 — Draftonly Creator", trackingId: "flu-fixture-draftonly-out-001", messageRef: "msgref_fixture_draftonly_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Draftonly Creator", time: "10:20", createdAtIso: "2026-06-24T01:20:00.000Z", text: "관심 있습니다 — 단가와 일정 알려주세요", trackingId: "flu-fixture-draftonly-in-001", messageRef: "msgref_fixture_draftonly_m2", humanGate: "auto_reply" },
    ],
  });

  // (b) blocked: 가이드 상한 초과 등으로 자동 회신 중단 — autoReplyBlockedReason 존재 + 초안 삭제 상태(미설정).
  // 식별자에는 "blocked"를 쓰지 않는다 — chat-ai.ts runGatewayMock의 seed(conversationId+
  // messageRef+trackingId+intent+signal)가 mailHumanGate.decideHumanGate의 순수 키워드 매칭에
  // 그대로 들어가는데, 그 매칭에 "blocked"/"bounce"/"rate-limit" 룰이 있다(mailHumanGate.ts:196).
  // id/작성자명/본문에 "blocked"가 섞이면 실제 회신 내용과 무관하게 항상 배송-차단으로 오분류돼
  // 온디맨드 재시도(chat-draft-prefill.spec.ts 시나리오 3)가 needs_review 대신 blocked로 떨어진다.
  appendFixtureDoc(ops, counts, "conversations", "conv-autoreply-restricted", {
    id: "conv-autoreply-restricted",
    threadId: "conv-autoreply-restricted",
    contextKey: "mail:conv-autoreply-restricted",
    creatorId: "c-fixture-restricted",
    creatorName: "Restricted Creator",
    creatorEmail: "restricted.creator@example.com",
    creatorHandle: "@restricted_creator",
    creatorPlatform: "YouTube",
    type: "direct",
    primaryBucket: "direct",
    locale: "und",
    creatorFollowers: 45000,
    source: "operational-hardening-fixture",
    unread: 2,
    aiActive: true,
    hasCreatorReply: true,
    lastMessageFrom: "creator",
    lastMessageAtIso: "2026-06-24T02:15:00.000Z",
    lastInboundAtIso: "2026-06-24T02:15:00.000Z",
    autoReplyStatus: "blocked",
    autoReplyBlockedReason: "증거 부족(followers/recentViews/engagement 미충족) — 사람 검수 필요",
    // autoReplyDraftText는 의도적으로 미설정(FieldValue.delete 이후 상태 재현, chat-ai.ts:1887).
    messages: [
      { id: "m1", from: "human", author: "시몬", time: "11:00", createdAtIso: "2026-06-24T02:00:00.000Z", text: "협업 제안 — Restricted Creator", trackingId: "flu-fixture-restricted-out-001", messageRef: "msgref_fixture_restricted_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Restricted Creator", time: "11:15", createdAtIso: "2026-06-24T02:15:00.000Z", text: "계약 조건 협의 가능할까요?", trackingId: "flu-fixture-restricted-in-001", messageRef: "msgref_fixture_restricted_m2", humanGate: "needs_review" },
    ],
  });

  // (c) creator 회신 있는 thread: 온디맨드 dryRun 프리필 대상(자동 초안/차단 상태 미설정 — 신선한 스레드).
  //     human takeover 비교군은 기존 시드 "v2"(aiActive:false)를 재사용 — 별도 픽스처 불필요.
  appendFixtureDoc(ops, counts, "conversations", "conv-autoreply-creator-reply", {
    id: "conv-autoreply-creator-reply",
    threadId: "conv-autoreply-creator-reply",
    contextKey: "mail:conv-autoreply-creator-reply",
    creatorId: "c-fixture-replied",
    creatorName: "Replied Creator",
    creatorEmail: "replied.creator@example.com",
    creatorHandle: "@replied_creator",
    creatorPlatform: "YouTube",
    type: "direct",
    primaryBucket: "direct",
    locale: "und",
    creatorFollowers: 63000,
    source: "operational-hardening-fixture",
    unread: 1,
    aiActive: true,
    hasCreatorReply: true,
    lastMessageFrom: "creator",
    lastMessageAtIso: "2026-06-24T03:10:00.000Z",
    lastInboundAtIso: "2026-06-24T03:10:00.000Z",
    messages: [
      { id: "m1", from: "human", author: "헤세", time: "12:00", createdAtIso: "2026-06-24T03:00:00.000Z", text: "협업 제안 — Replied Creator", trackingId: "flu-fixture-replied-out-001", messageRef: "msgref_fixture_replied_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Replied Creator", time: "12:10", createdAtIso: "2026-06-24T03:10:00.000Z", text: "좋아요, 진행하고 싶습니다!", trackingId: "flu-fixture-replied-in-001", messageRef: "msgref_fixture_replied_m2", humanGate: "auto_reply" },
    ],
  });
}

// coldmail-history 픽스처(P1) — scp_coldmail_history(append-only 원장) + mail_outbound_log(trackingId
// 조인 대상). 3-컬렉션 소유 경계는 functions/scpColdmailHistory.ts 헤더 주석 참조.
function appendColdmailHistoryFixtures(ops, counts) {
  // (a) 회신 linked row: conversationId가 실제 존재하는 대화(v1, 회신 메시지 보유)를 가리킴 —
  //     "열기" 랜딩이 무관한 기본 대화(v-hesse)가 아니라 실제 맥락으로 이동하는지 검증하는 정상 케이스.
  appendFixtureDoc(ops, counts, "scp_coldmail_history", "cmh_flu-fixture-cmh-linked-001", {
    id: "cmh_flu-fixture-cmh-linked-001",
    programId: "scp",
    email: "cmh-linked-fixture@example.com",
    emailLower: "cmh-linked-fixture@example.com",
    emailMasked: "cm***@example.com",
    koreanName: "콜드메일 회신 픽스처",
    youtubeUrl: "https://www.youtube.com/@cmh_linked_fixture",
    subject: "[Flu] 신작 협업 제안 — 콜드메일 회신 픽스처",
    body: "안녕하세요, Flu 운영 하드닝 시드 픽스처 발송 본문입니다.",
    bodyPreview: "안녕하세요, Flu 운영 하드닝 시드 픽스처 발송 본문입니다.",
    bodySha256: createHash("sha256").update("안녕하세요, Flu 운영 하드닝 시드 픽스처 발송 본문입니다.").digest("hex"),
    templateKind: "t1",
    templateRef: "templates/t1",
    campaign: "cp3",
    source: "scp_cold_outreach",
    sourceRef: "candidate_pool/p1",
    trackingId: "flu-fixture-cmh-linked-001",
    mailOutboxRef: "mail_outbound_log/flu-fixture-cmh-linked-001",
    conversationId: "v1",
    conversationRef: "conversations/v1",
    deliveryState: "delivered",
    openCount: 1,
    lastOpenedAtIso: "2026-06-24T05:05:00.000Z",
    hasReply: true,
    sentAtIso: "2026-06-24T05:00:00.000Z",
    createdAtIso: "2026-06-24T05:00:00.000Z",
    createdBy: "seed-script",
    createdByRole: "super_admin",
    createdByTeam: "AIX",
  });

  // (b) unlinked row: 콜드 발송 시점엔 대화가 없어 conversationId="" (appendScpColdmailHistory 호출부
  //     scpOutreach.ts:260-276 / chat-ai.ts:3208-3221이 발송 즉시 기록하는 기본 상태).
  appendFixtureDoc(ops, counts, "scp_coldmail_history", "cmh_flu-fixture-cmh-unlinked-001", {
    id: "cmh_flu-fixture-cmh-unlinked-001",
    programId: "scp",
    email: "cmh-unlinked-fixture@example.com",
    emailLower: "cmh-unlinked-fixture@example.com",
    emailMasked: "cm***@example.com",
    koreanName: "콜드메일 미링크 픽스처",
    youtubeUrl: "https://www.youtube.com/@cmh_unlinked_fixture",
    subject: "[Flu] 신작 협업 제안 — 콜드메일 미링크 픽스처",
    body: "안녕하세요, 아직 회신이 연결되지 않은 발송 픽스처 본문입니다.",
    bodyPreview: "안녕하세요, 아직 회신이 연결되지 않은 발송 픽스처 본문입니다.",
    bodySha256: createHash("sha256").update("안녕하세요, 아직 회신이 연결되지 않은 발송 픽스처 본문입니다.").digest("hex"),
    templateKind: "t1",
    templateRef: "templates/t1",
    campaign: "cp3",
    source: "scp_cold_outreach",
    sourceRef: "candidate_pool/p2",
    trackingId: "flu-fixture-cmh-unlinked-001",
    mailOutboxRef: "mail_outbound_log/flu-fixture-cmh-unlinked-001",
    conversationId: "",
    conversationRef: "",
    deliveryState: "sent",
    openCount: 0,
    lastOpenedAtIso: "",
    hasReply: false,
    sentAtIso: "2026-06-24T05:10:00.000Z",
    createdAtIso: "2026-06-24T05:10:00.000Z",
    createdBy: "seed-script",
    createdByRole: "super_admin",
    createdByTeam: "AIX",
  });

  // (c) stale conversationId row: 발송 시점 대화가 이후 사라진 케이스 — chat/page.tsx의 targeted-load
  //     "missing" 상태(:492,506) 재현 대상. 대응 mail_outbound_log(같은 trackingId)는 실제로는 살아있는
  //     대화(v3)를 가리켜, list-time에 mail_outbound_log를 join해야만 정확한 hasReply/conversationId를
  //     복구할 수 있음을 보여준다(P1 수정 방향 — listMailOutbox 패턴 재사용).
  appendFixtureDoc(ops, counts, "scp_coldmail_history", "cmh_flu-fixture-cmh-stale-001", {
    id: "cmh_flu-fixture-cmh-stale-001",
    programId: "scp",
    email: "cmh-stale-fixture@example.com",
    emailLower: "cmh-stale-fixture@example.com",
    emailMasked: "cm***@example.com",
    koreanName: "콜드메일 stale 픽스처",
    youtubeUrl: "https://www.youtube.com/@cmh_stale_fixture",
    subject: "[Flu] 신작 협업 제안 — 콜드메일 stale 픽스처",
    body: "안녕하세요, 발송 시점 대화가 이후 사라진 픽스처 본문입니다.",
    bodyPreview: "안녕하세요, 발송 시점 대화가 이후 사라진 픽스처 본문입니다.",
    bodySha256: createHash("sha256").update("안녕하세요, 발송 시점 대화가 이후 사라진 픽스처 본문입니다.").digest("hex"),
    templateKind: "t1",
    templateRef: "templates/t1",
    campaign: "cp3",
    source: "scp_cold_outreach",
    sourceRef: "candidate_pool/p3",
    trackingId: "flu-fixture-cmh-stale-001",
    mailOutboxRef: "mail_outbound_log/flu-fixture-cmh-stale-001",
    conversationId: "conv-vanished-fixture-001",
    conversationRef: "conversations/conv-vanished-fixture-001",
    deliveryState: "sent",
    openCount: 0,
    lastOpenedAtIso: "",
    hasReply: false,
    sentAtIso: "2026-06-24T05:20:00.000Z",
    createdAtIso: "2026-06-24T05:20:00.000Z",
    createdBy: "seed-script",
    createdByRole: "super_admin",
    createdByTeam: "AIX",
  });

  // mail_outbound_log 3종 — 각 trackingId 조인 대상. (c)는 의도적으로 conversationId가 위 history row와
  // 다르다(v3=생존 대화) — stale 히스토리 row 자체는 신뢰할 수 없고 join으로만 참값을 얻는 시나리오.
  appendFixtureDoc(ops, counts, "mail_outbound_log", "flu-fixture-cmh-linked-001", {
    trackingId: "flu-fixture-cmh-linked-001",
    to: "cmh-linked-fixture@example.com",
    subject: "[Flu] 신작 협업 제안 — 콜드메일 회신 픽스처",
    deliveryState: "delivered",
    providerMessageId: "fixture-provider-msg-linked-001",
    draftRef: "",
    gameId: "casual-01",
    sentByUserId: "seed-script",
    sentByRole: "super_admin",
    conversationId: "v1",
    conversationRef: "conversations/v1",
    sentAtIso: "2026-06-24T05:00:00.000Z",
    openCount: 1,
    lastOpenedAtIso: "2026-06-24T05:05:00.000Z",
    hasReply: true,
  });
  appendFixtureDoc(ops, counts, "mail_outbound_log", "flu-fixture-cmh-unlinked-001", {
    trackingId: "flu-fixture-cmh-unlinked-001",
    to: "cmh-unlinked-fixture@example.com",
    subject: "[Flu] 신작 협업 제안 — 콜드메일 미링크 픽스처",
    deliveryState: "sent",
    providerMessageId: "fixture-provider-msg-unlinked-001",
    draftRef: "",
    gameId: "casual-01",
    sentByUserId: "seed-script",
    sentByRole: "super_admin",
    conversationId: "",
    conversationRef: "",
    sentAtIso: "2026-06-24T05:10:00.000Z",
    openCount: 0,
    lastOpenedAtIso: "",
    hasReply: false,
  });
  appendFixtureDoc(ops, counts, "mail_outbound_log", "flu-fixture-cmh-stale-001", {
    trackingId: "flu-fixture-cmh-stale-001",
    to: "cmh-stale-fixture@example.com",
    subject: "[Flu] 신작 협업 제안 — 콜드메일 stale 픽스처",
    deliveryState: "delivered",
    providerMessageId: "fixture-provider-msg-stale-001",
    draftRef: "",
    gameId: "casual-01",
    sentByUserId: "seed-script",
    sentByRole: "super_admin",
    conversationId: "v3",
    conversationRef: "conversations/v3",
    conversationSnapshot: {
      id: "v3",
      ref: "conversations/v3",
      threadId: "",
      creatorId: "c3",
      creatorName: "",
      creatorEmailMasked: "",
      creatorHandle: "",
      programId: "",
      campaignId: "",
      lastMessageFrom: "creator",
      lastMessageAtIso: "2026-06-23T01:22:00.000Z",
    },
    sentAtIso: "2026-06-24T05:20:00.000Z",
    openCount: 0,
    lastOpenedAtIso: "",
    hasReply: true,
  });
}

// token-only/콜론-ID submissions 픽스처(P6/P7/P11) — sheet3SubmissionBridge.ts:117-125의 "orphan"
// 브리지 산출물과 동일한 스키마. Sheet3 자체는 라이브 Google Sheets 읽기라(scpSheetReviewService.ts)
// 에뮬레이터에 직접 시드할 수 없어, 브리지가 만드는 submissions/token:<token> 문서로 재현한다.
function appendVideoSubmissionTokenFixtures(ops, counts) {
  const baseSubmission = (overrides) => ({
    programId: "scp",
    leadId: null,
    creatorLinkRef: null,
    campaign: null,
    email: "",
    app: "XPHERO",
    tiktokUrl: "",
    instaUrl: "",
    instagramUrl: "",
    uploadedFileUrl: "",
    contentType: "weaponrpg_scp_video",
    source: "sheet3_bridge",
    sheetStatus: "pending",
    sheetRejectedReason: "",
    sheetMail: "",
    reviewStatus: "pending",
    rejectedReason: "",
    reviewNotes: [],
    reviewMemo: "",
    aiRecommendation: null,
    payment: null,
    payableStatus: "not_payable",
    revisions: [],
    resubmissionCount: 0,
    countsInitialized: true,
    ...overrides,
  });

  // token-only partner 픽스처(P7/P11): submissionId/leadId 없이 token만 있는 제출 — 이름 필드가
  // 없어 raw id/token 폴백(P7)과 partnerRouteId()의 이중 인코딩(%253A, P11) 재현 대상.
  const partnerToken = "scp3fixturetoken0001";
  appendFixtureDoc(ops, counts, "submissions", `token:${partnerToken}`, baseSubmission({
    id: `token:${partnerToken}`,
    creatorId: `CR_${partnerToken}`,
    youtubeUrl: "https://www.youtube.com/watch?v=fixtureTokenOnly1",
    contentUrls: ["https://www.youtube.com/watch?v=fixtureTokenOnly1"],
    submittedAtIso: "2026-06-24T06:00:00.000Z",
    createdAtIso: "2026-06-24T06:00:00.000Z",
    token: partnerToken,
    bridgeKey: `token:${partnerToken}`,
    sourceRowRefs: [{ spreadsheetId: "fixture-sheet3", tabName: "콘텐츠메일송부", rowNumber: 9001 }],
  }));

  // 콜론 ID video submission 픽스처(P6 유령 ID 회귀): 문서 ID 자체가 "token:...". ID 정규화가 콜론을
  // 하이픈으로 치환해 별도 유령 문서("token-llnwm...")에 기록하지 않고, 이 실문서에 aiRecommendation이
  // 기록되는지 검증하는 용도. aiRecommendation은 초기 상태 그대로 null로 둔다.
  const ghostToken = "llnwm00fixtureghost1";
  appendFixtureDoc(ops, counts, "submissions", `token:${ghostToken}`, baseSubmission({
    id: `token:${ghostToken}`,
    creatorId: `CR_${ghostToken}`,
    youtubeUrl: "https://www.youtube.com/watch?v=fixtureGhostId1",
    contentUrls: ["https://www.youtube.com/watch?v=fixtureGhostId1"],
    submittedAtIso: "2026-06-24T06:05:00.000Z",
    createdAtIso: "2026-06-24T06:05:00.000Z",
    token: ghostToken,
    bridgeKey: `token:${ghostToken}`,
    sourceRowRefs: [{ spreadsheetId: "fixture-sheet3", tabName: "콘텐츠메일송부", rowNumber: 9002 }],
  }));
}

function campaignCandidateLinkIdFixture(programId, campaignId, candidateId) {
  const digest = createHash("sha256")
    .update(JSON.stringify([programId, campaignId, candidateId]))
    .digest("hex")
    .slice(0, 40);
  return `ccl_${digest}`;
}

function appendVerifyConsoleMigrationFixtures(ops, counts) {
  const sourceProgramId = "pg-verify-console-source";
  const targetProgramId = "pg-verify-console-target";
  const sourceCampaignId = "cp-verify-console-source";
  const targetCampaignId = "cp-verify-console-target";
  const candidateId = "cand-verify-console-migration";
  appendFixtureDoc(ops, counts, "programs", sourceProgramId, {
    id: sourceProgramId,
    title: "Verify Console Migration Source",
    status: "open",
    candidateCriteria: { keywords: ["snake game"], minFollowers: 1000 },
    source: "verify-console",
  });
  appendFixtureDoc(ops, counts, "programs", targetProgramId, {
    id: targetProgramId,
    title: "Verify Console Migration Target",
    status: "open",
    candidateCriteria: { keywords: ["snake game"], minFollowers: 1000 },
    source: "verify-console",
  });
  appendFixtureDoc(ops, counts, "campaigns", sourceCampaignId, {
    id: sourceCampaignId,
    programId: sourceProgramId,
    canonicalProgramId: sourceProgramId,
    name: "Verify Console Migration Source",
    status: "발송중",
    source: "verify-console",
    counterSource: "syncCampaignFunnel",
    total: 0,
    sent: 0,
    replied: 0,
    negotiating: 0,
    contracted: 0,
    live: 0,
  });
  appendFixtureDoc(ops, counts, "campaigns", targetCampaignId, {
    id: targetCampaignId,
    programId: targetProgramId,
    canonicalProgramId: targetProgramId,
    name: "Verify Console Migration Target",
    status: "발송중",
    source: "verify-console",
    counterSource: "syncCampaignFunnel",
    targetingCriteria: { includeKeywords: ["snake game"], minFollowers: 1000 },
    total: 0,
    sent: 0,
    replied: 0,
    negotiating: 0,
    contracted: 0,
    live: 0,
  });
  appendFixtureDoc(ops, counts, "candidate_pool", candidateId, {
    id: candidateId,
    name: "Verify Migration Creator",
    handle: "@verify_migration_creator",
    email: "verify.migration@example.test",
    platform: "YouTube",
    channelId: "UCVERIFYMIGRATION",
    followers: 50000,
    region: "US",
    category: "gaming",
    publicDescription: "Verify fixture creator plays snake game daily",
    matchedSearchTerms: ["snake game"],
    matchScore: 0.9,
    source: "verify-console",
  });
  appendFixtureDoc(ops, counts, "campaign_candidates", campaignCandidateLinkIdFixture(sourceProgramId, sourceCampaignId, candidateId), {
    candidateId,
    candidateRef: `candidate_pool/${candidateId}`,
    canonicalProgramId: sourceProgramId,
    programId: sourceProgramId,
    campaignId: sourceCampaignId,
    campaignRef: `campaigns/${sourceCampaignId}`,
    stage: "contacted",
    email: "verify.migration@example.test",
    name: "Verify Migration Creator",
    handle: "@verify_migration_creator",
    platform: "YouTube",
    followers: 50000,
    region: "US",
    category: "gaming",
    publicDescription: "Verify fixture creator plays snake game daily",
    matchedSearchTerms: ["snake game"],
    matchScore: 0.9,
    source: "verify-console",
  });
}

function appendOperationalHardeningFixtures(ops, counts) {
  appendAutoReplyFixtures(ops, counts);
  appendColdmailHistoryFixtures(ops, counts);
  appendVideoSubmissionTokenFixtures(ops, counts);
  appendVerifyConsoleMigrationFixtures(ops, counts);
  // The verification ledger must reference a real submission; otherwise pay/check
  // verification can create a partial document that ordered reads cannot see.
  appendFixtureDoc(ops, counts, "submissions", "s-verify-console", {
    id: "s-verify-console",
    creatorId: "verify-creator",
    gameId: "flu-verify",
    contentType: "verification_fixture",
    reviewStatus: "approved",
    payableStatus: "payable",
    source: "seed",
  });
  appendFixtureDoc(ops, counts, "review_ledger", "r-verify-console", {
    reviewId: "r-verify-console",
    submissionId: "s-verify-console",
    creatorId: "verify-creator",
    gameId: "flu-verify",
    status: "pass",
    reasonCode: "approved",
    payableStatus: "payable",
    amount: 1,
    currency: "KRW",
    vatIncluded: true,
    reviewer: "verify-console",
    source: "seed",
  });
}

async function ensureRealmUser(spec, realmAuth, realmLabel) {
  let user = null;
  try {
    user = await realmAuth.getUser(spec.uid);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
  }

  if (user && user.email !== spec.email) {
    await realmAuth.deleteUser(user.uid);
    user = null;
  }
  if (!user) {
    try {
      const emailUser = await realmAuth.getUserByEmail(spec.email);
      if (emailUser.uid === spec.uid) {
        user = emailUser;
      } else {
        await realmAuth.deleteUser(emailUser.uid);
      }
    } catch (error) {
      if (error?.code !== "auth/user-not-found") throw error;
    }
  }
  if (!user) {
    user = await realmAuth.createUser({
      uid: spec.uid,
      email: spec.email,
      password: spec.password,
      emailVerified: true,
    });
    console.log(`[seed] created ${realmLabel} user: ${user.uid} (${spec.email})`);
  } else {
    console.log(`[seed] existing ${realmLabel} user reused: ${user.uid} (${spec.email})`);
  }

  await realmAuth.setCustomUserClaims(user.uid, spec.claims);
  console.log(`[seed] ${realmLabel} custom claims set for ${spec.email}: ${JSON.stringify(spec.claims)}`);
  return user;
}

async function ensureAuthRealmsForAccount(spec) {
  const [parentUser, stagingUser] = await Promise.all([
    ensureRealmUser(spec, authAdmin, "parent"),
    ensureRealmUser(spec, stagingAuthAdmin, `tenant:${STAGING_AUTH_TENANT_ID}`),
  ]);
  if (
    parentUser.uid !== stagingUser.uid ||
    parentUser.email !== stagingUser.email ||
    stagingUser.tenantId !== STAGING_AUTH_TENANT_ID
  ) {
    throw new Error(`[seed] parent and staging Auth fixtures must share the exact email and UID (${spec.email}).`);
  }
  return parentUser.uid;
}

async function ensureAuthRealms() {
  const adminUid = await ensureAuthRealmsForAccount(ADMIN_ACCOUNT);
  // Flu/Task-61: Growth/AI Drama/미매핑 QA 계정도 parent + staging 테넌트 양쪽에 동일하게
  // 미러링한다 — admin 픽스처가 이미 그렇게 하는 이유(스테이징 에뮬레이터 레인도 같은 스크립트를
  // 공유)와 같다.
  for (const account of ORG_SCOPE_QA_ACCOUNTS) {
    await ensureAuthRealmsForAccount(account);
  }
  return adminUid;
}

function appendCommonAdminMemberFixture(ops, counts) {
  appendFixtureDoc(ops, counts, "members", UID, {
    id: UID,
    uid: UID,
    name: "E2E Super Admin",
    email: EMAIL,
    avatar: "SA",
    role: "super_admin",
    team: "AIX",
    status: "active",
    assigned: 0,
    lastActive: "E2E",
    mailAccountIds: ["scp"],
  });
}

// Flu/Task-61 — Growth/AI Drama/미매핑 QA 계정이 실제로 그 조직으로 해석되게 만드는 Firestore
// 쪽 절반. Growth는 의도적으로 아무 것도 쓰지 않는다: settings/mail_routing·
// settings/org_tab_presets 둘 다 매핑이 없는 조직은 기존 기본값(scp 계정·프리셋 제한 없음)이라
// "회귀 0"을 그대로 얻는다(functions/orgTabPresets.ts 헤더 주석과 동일 원칙). AI Drama와
// 전용 admin org만 명시 설정이 필요하다:
//   - mail_accounts/{id}: 매니저가 연결해 둔 개인(workspace_oauth) 메일함 — ① 우선순위로
//     resolveMailAccountForEmail이 org 매핑보다 먼저 이 계정을 고른다.
//   - settings/mail_routing: personalMailAllowedOrgIds·chatPersonalViewDefaultOrgIds에 org를
//     추가해야 개인 메일함 연결 허용 + Chat 기본 뷰가 "내 메일함"이 된다(둘 다 기본값이 아니라
//     명시 설정이 필요 — mailAccounts.ts isPersonalMailConnectAllowedForOrg/defaultView 참고).
//   - settings/org_tab_presets: 이 티켓이 QA 픽스처로 고른 AI Drama 5탭(대시보드·프로그램·후보·
//     파트너·설정) — 프로덕션에 실제 배포된 프리셋과 무관한 테스트용 값이다. "candidates" 포함 +
//     "scp" 미포함이라 파트너 탭도 candidate_reply로 정확히 라우팅된다(functions/orgTabPresets.ts
//     partnerDataSourceFromNavPreset) — 어떤 5탭 조합이든 이 두 조건만 지키면 유효하다.
//   - settings/youtube_quota_pools: byOrgId만 "drama_1" 풀로 매핑(실제 풀 설정은 Task-49 인프라
//     별도 진행 — 매핑이 없는 키는 growth로 안전하게 폴백하므로 여기서 더 채울 필요 없음).
//   - org-e2e-admin: test-admin@demo-flu 전용 emulator fixture 프리셋(전체 관리 탭 조합). Growth
//     프리셋은 의도적으로 추가하지 않아 기존 no-preset 회귀 계약을 유지한다.
function appendOrgScopeTestAccountFixtures(ops, counts) {
  appendFixtureDoc(ops, counts, "members", "u7", {
    id: "u7", name: "QA Growth 매니저", email: GROWTH_MANAGER_ACCOUNT.email, avatar: "G",
    role: "manager", team: "Growth", assigned: 0, status: "active", lastActive: "—",
  });
  appendFixtureDoc(ops, counts, "members", "u8", {
    id: "u8", name: "QA AI Drama 매니저", email: DRAMA_MANAGER_ACCOUNT.email, avatar: "D",
    role: "manager", team: "AI Drama", assigned: 0, status: "active", lastActive: "—",
  });
  appendFixtureDoc(ops, counts, "members", "u9", {
    id: "u9", name: "QA 미매핑 뷰어", email: UNMAPPED_VIEWER_ACCOUNT.email, avatar: "U",
    role: "viewer", team: "—", assigned: 0, status: "active", lastActive: "—",
  });

  // functions/mailAccounts.ts parseMailAccountDoc reads createdAt/updatedAt (plain ISO strings,
  // NOT the createdAtIso/updatedAtIso pair appendFixtureDoc's withIsoFields stamps for every
  // other fixture collection) — set the real MailAccount schema fields explicitly so this doc
  // reads with the same field the type actually declares, instead of relying on parseMailAccountDoc's
  // silent "" default for a field this collection never populates otherwise.
  const dramaPersonalMailboxNowIso = new Date().toISOString();
  appendFixtureDoc(ops, counts, "mail_accounts", DRAMA_PERSONAL_MAILBOX_ACCOUNT_ID, {
    label: "AI Drama 매니저 개인 메일함(QA)",
    mailbox: DRAMA_PERSONAL_MAILBOX,
    kind: "workspace_oauth",
    status: "active",
    ownerEmail: DRAMA_MANAGER_ACCOUNT.email,
    orgIds: [],
    smtp: {},
    imap: {},
    secretRef: `oauth:mail_oauth_credentials/${DRAMA_PERSONAL_MAILBOX_ACCOUNT_ID}`,
    configError: false,
    createdBy: "seed",
    createdAt: dramaPersonalMailboxNowIso,
    updatedBy: "seed",
    updatedAt: dramaPersonalMailboxNowIso,
  });

  counts["settings/mail_routing"] = (counts["settings/mail_routing"] ?? 0) + 1;
  ops.push((batch) => batch.set(db.doc("settings/mail_routing"), {
    personalMailAllowedOrgIds: [DRAMA_ORG_ID],
    chatPersonalViewDefaultOrgIds: [DRAMA_ORG_ID],
    updatedBy: "seed",
    updatedAt: new Date().toISOString(),
  }, { merge: true }));

  counts["settings/org_tab_presets"] = (counts["settings/org_tab_presets"] ?? 0) + 1;
  ops.push((batch) => batch.set(db.doc("settings/org_tab_presets"), {
    byOrgId: {
      [DRAMA_ORG_ID]: ["dashboard", "programs", "candidates", "partners", "settings"],
      "org-e2e-admin": ["dashboard", "programs", "candidates", "scp", "manage", "partners", "feed", "report", "settings"],
    },
    policyVersion: "org-tab-presets-v1",
    updatedBy: "seed",
    updatedAt: new Date().toISOString(),
  }, { merge: true }));

  counts["settings/youtube_quota_pools"] = (counts["settings/youtube_quota_pools"] ?? 0) + 1;
  ops.push((batch) => batch.set(db.doc("settings/youtube_quota_pools"), {
    byOrgId: { [DRAMA_ORG_ID]: "drama_1" },
    policyVersion: "youtube-quota-pools-v1",
    updatedBy: "seed",
    updatedAt: new Date().toISOString(),
  }, { merge: true }));
}

async function seedFirestore() {
  const CHUNK = 450;
  const ops = [];
  const counts = {};
  for (const { collection, docs, idField, seedWrite } of SEED_COLLECTIONS) {
    if (seedWrite === false) continue;
    counts[collection] = docs.length;
    for (const doc of docs) {
      const docId = String(doc[idField] ?? doc.id ?? "");
      if (!docId) continue;
      const ref = db.collection(collection).doc(docId);
      ops.push((batch) => batch.set(ref, { ...withIsoFields(doc), seedId: "flu-emulator-seed", seededAt: new Date().toISOString() }));
    }
  }
  appendOperationalHardeningFixtures(ops, counts);
  appendCommonAdminMemberFixture(ops, counts);
  appendOrgScopeTestAccountFixtures(ops, counts);
  appendBulkSeedOps(ops, counts, bulkConfig);
  for (let start = 0; start < ops.length; start += CHUNK) {
    const batch = db.batch();
    for (const apply of ops.slice(start, start + CHUNK)) apply(batch);
    await batch.commit();
  }
  console.log(`[seed] firestore wrote ${ops.length} docs: ${JSON.stringify(counts)}`);
  if (bulkConfig) console.log(`[seed] bulk config ${JSON.stringify(bulkConfig)}`);
}

async function main() {
  const uid = await ensureAuthRealms();
  console.log(`[seed] ready in parent + ${STAGING_AUTH_TENANT_ID}: ${EMAIL} (${uid}) role=super_admin team=AIX`);
  console.log(`[seed] org-scope QA accounts ready: ${ORG_SCOPE_QA_ACCOUNTS.map((a) => `${a.email}(${a.claims.role}/${a.claims.team})`).join(", ")}`);
  await seedFirestore();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[seed] failed:", error);
    process.exit(1);
  });
