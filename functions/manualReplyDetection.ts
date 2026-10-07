/**
 * **수동 회신 감지 — 자동회신 이중발송 방어 (defense-in-depth)**
 *
 * ■ 왜 필요한가
 *   scp@supercent.io Sent 편지함에서 편입된 발송(`mailExternalSentImport.ts`,
 *   `source: external_sent_mail_import`)은 대화(`conversations/{id}/messages`)에 물질화되어야
 *   비로소 `conversation.lastMessageFrom` 이 "human"으로 갱신된다(`externalSentConversationStitch.ts`).
 *   그런데 프로드 실측(2026-09-25): 편입분 2,068건 중 8건만 `mailAccountId` 를 갖고, 상시 재시도
 *   레인(`retryUnstitchedSentImportStitches`)은 `mailAccountId` 로만 창을 잡아 나머지 ~99.6%가
 *   영영 재시도되지 않았다 — 그래서 scp 가 Gmail 에서 직접 수동으로 답장한 대화도
 *   `lastMessageFrom == "creator"` 로 남아 "안 답장한 것"처럼 보이고, 백필/재시도 레인이 이번
 *   변경으로 스티칭을 따라잡더라도(externalSentConversationStitch.ts 참고) **스티칭이 아직 못
 *   따라잡은 창**이나 **스티칭 자체가 실패하는 행**은 여전히 존재할 수 있다.
 *
 *   그래서 자동회신을 큐잉/발송하는 두 지점(`requeueAutoReplyBacklog`, `sendAutoReplyJob`) 모두
 *   **스티칭 결과에 의존하지 않고** 같은 원장(`message_sources`)을 직접 대조한다 — 스티칭이
 *   실패했어도, 아직 안 돌았어도 이 판정은 그대로 작동한다.
 *
 * ■ 무엇을 보는가
 *   수신자(toHash) 앞으로 scp 메일함(fromHash)이 보낸 **아웃바운드** `message_sources` 문서 중
 *   대화의 마지막 인바운드(`lastInboundAtIso`)보다 **나중에** 보낸 것이 있는지. Gmail 이모지
 *   반응("🙌 … emojireactionemail" 류)도 이 원장에 동일한 형태(outbound, toHash/fromHash)로
 *   적재되므로 별도 예외 없이 회신으로 집계된다(헤세 결정 — 2026-09-25 백로그 감사).
 *
 * ■ 범위
 *   scp@supercent.io 메일함만 본다. 개인 메일함(예: hesse@)은 범위 밖 — 그 대화는 이미 자동회신
 *   대상에서 전면 제외되어 있다.
 */
import { adminDb } from "./firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import { recipientIdentityHash } from "./recipientIdentityHash";
import { asRecord, asString } from "./shared";

const MESSAGE_SOURCES_COLLECTION = "message_sources";

/**
 * 회당 대조할 message_sources 후보 상한.
 *
 * ■ 창이 꽉 차면 "없다"고 말하지 않는다 (Codex gate round 1 HIGH — 실측 재현됨)
 *   이 쿼리는 orderBy 가 없다(등가 3축만 — 복합 색인 불요, 아래 쿼리 주석 참고). orderBy 가 없으면
 *   Firestore 가 반환하는 문서 순서는 **시간순이 보장되지 않는다** — 이 수신자에게 간 scp 발신이
 *   이 상한을 넘으면, 정작 마지막 인바운드보다 나중인 진짜 수동 회신이 **잘려서 못 보인** 채
 *   "회신 없음"으로 오판될 수 있다. 발송 가드(sendAutoReplyJob)가 이 오판을 신뢰하면 이미 사람이
 *   답장한 대화에 자동회신이 이중으로 나간다 — 이 레인에서 가장 나쁜 실패 방향이다.
 *   그래서 창이 꽉 찼는데(=더 있을 수 있는데) 그 안에서 매칭을 못 찾으면 "회신 없음"이 아니라
 *   **"모른다"** 로 끝내고, "모른다"는 안전한 쪽(감지됨=발송 보류)으로 접는다 — 이 파일의 자매
 *   레인(externalSentConversationStitch.ts `resolveToolSentDuplicate` 의 `ToolDuplicateVerdict.
 *   "unknown"`)과 같은 원리이되 안전한 방향이 반대다: 그쪽은 "못 봤다"를 "숨기지 않는다"(더 보수적인
 *   건 화면에 보여주는 쪽)로 접지만, 여기는 "못 봤다"를 "보낸다"가 아니라 "보류한다"로 접는다 —
 *   둘 다 불확실성을 안전한 방향으로 접는다는 점은 같다.
 *   orderBy(sentAtIso desc) 를 붙여 "최근 것부터 보고 상한 안에서 끊기면 나머지는 항상 더 오래된
 *   것"이라는 형태로 만드는 대안도 있지만, 그러면 (toHash+fromHash+direction) 등가 3축에 orderBy 가
 *   더해져 **새 복합 색인**이 필요해진다 — 이건 발송 시점(sendAutoReplyJob)에서 매 자동회신마다
 *   도는 쿼리라, 색인이 배포 전 상태로 걸리면 이 가드 자체가 FAILED_PRECONDITION 으로 죽어
 *   자동회신 전체가 막힌다(이 레포 도처에 기록된 사고 형상과 같다). 그 배포 순서 리스크를 지기보다
 *   상한을 넉넉히 잡고(TOOL_DUPLICATE_PROBE_LIMIT=20 보다 크게) "꽉 차면 보류"로 안전하게 접는다.
 */
const MANUAL_REPLY_PROBE_LIMIT = 50;

/** scp 메일함 자신의 발신 해시. 편입분(스탬프 유무 무관)과 툴 발송 전부 이 값으로 fromHash 를 남긴다. */
export const SCP_MAILBOX_FROM_HASH = recipientIdentityHash(CANONICAL_OPERATIONAL_MAILBOX_V1);

export type ManualReplyDetection =
  | { detected: true; sourceRef: string; sentAtIso: string; certain: boolean }
  | { detected: false };

export type DetectManualReplySinceInboundInput = {
  creatorEmail: string;
  /** conversation.lastInboundAtIso. 비어 있으면(인바운드 기록이 없으면) 아무것도 "그 이후"일 수 없다 — 감지하지 않는다. */
  lastInboundAtIso: string;
  /** Optional fixed Firestore snapshot used by the background pending-count traversal. */
  readTime?: Timestamp;
};

function parseMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * scp 메일함이 이 수신자에게 마지막 인바운드 이후 보낸 아웃바운드 발송이 있는지 판정한다.
 * 스티칭 여부와 무관하게 원장을 직접 읽으므로, 스티칭이 실패했거나 아직 못 돈 창에서도 작동한다.
 *
 * `certain: false` (감지됨 + 근거 없음)는 창이 꽉 찼는데 그 안에서 매칭을 못 찾은 경우다 — 실제
 * 회신이 있는지 확정할 수 없으니 안전한 쪽(발송 보류)으로 접은 결과다. 호출부는 `certain` 값과
 * 무관하게 `detected` 만 보고 동일하게 처리한다(둘 다 "보내지 않는다"가 맞는 판정이다) — 관측용으로만 남긴다.
 */
export async function detectManualReplySinceInbound(
  input: DetectManualReplySinceInboundInput,
  deps: { db?: FirebaseFirestore.Firestore } = {},
): Promise<ManualReplyDetection> {
  const toHash = recipientIdentityHash(input.creatorEmail);
  const lastInboundAtMs = parseMs(input.lastInboundAtIso);
  if (!toHash || !SCP_MAILBOX_FROM_HASH || !Number.isFinite(lastInboundAtMs)) {
    return { detected: false };
  }
  const db = deps.db ?? adminDb;
  const query = db
    .collection(MESSAGE_SOURCES_COLLECTION)
    .where("toHash", "==", toHash)
    .where("fromHash", "==", SCP_MAILBOX_FROM_HASH)
    .where("direction", "==", "outbound")
    .limit(MANUAL_REPLY_PROBE_LIMIT);
  const snapshot = input.readTime
    ? await db.runTransaction((transaction) => transaction.get(query), { readOnly: true, readTime: input.readTime })
    : await query.get();
  let latest: { sourceRef: string; sentAtIso: string; sentAtMs: number } | null = null;
  for (const doc of snapshot.docs) {
    const data = asRecord(doc.data());
    const sentAtIso = asString(data.sentAtIso, "");
    const sentAtMs = parseMs(sentAtIso);
    if (!Number.isFinite(sentAtMs) || sentAtMs <= lastInboundAtMs) continue;
    if (!latest || sentAtMs > latest.sentAtMs) {
      latest = { sourceRef: doc.ref.path, sentAtIso, sentAtMs };
    }
  }
  if (latest) return { detected: true, sourceRef: latest.sourceRef, sentAtIso: latest.sentAtIso, certain: true };
  // 창이 꽉 찼다 = 이 수신자에게 간 scp 발신이 상한보다 많을 수 있다는 뜻이다. orderBy 가 없으므로
  // 못 본 나머지 중에 마지막 인바운드보다 나중인 진짜 회신이 있을 수 있다 — "없다"고 말하지 않는다.
  if (snapshot.docs.length >= MANUAL_REPLY_PROBE_LIMIT) {
    console.warn("[manual-reply-detection] probe window saturated — failing closed (holding auto-reply)", {
      toHash,
      probeLimit: MANUAL_REPLY_PROBE_LIMIT,
    });
    return { detected: true, sourceRef: "", sentAtIso: "", certain: false };
  }
  return { detected: false };
}
