import { promises as dns } from "node:dns";
import {
  emailDomain,
  failedPrecondition,
  looksLikeEmailAddress,
  safeOutboundFailureEvidence,
  type MailSafetyMode,
} from "./mailSafetyShared";
import { readOutboundSafetyBlock, type MailLaneGateDeps } from "./mailOutboundSafety";
import type { MailOutboundLane } from "./mailOutboundLanes";

const MX_LOOKUP_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(failedPrecondition(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function publicRecipientDeliverabilityFailure(error: unknown, scope = "mail-deliverability"): Error {
  const evidence = safeOutboundFailureEvidence(error, scope);
  const message = evidence.failureKind === "no_mx"
    ? `recipient domain has no MX records. Reference code ${evidence.correlationIdHash}.`
    : `recipient domain DNS validation failed. Reference code ${evidence.correlationIdHash}.`;
  return Object.assign(failedPrecondition(message), evidence);
}

export async function assertRecipientDeliverabilityAllowed(
  to: string,
  mode: MailSafetyMode = "auto_send",
  // W118: 발송 직전 재검사도 레인 기준이어야 한다 — 아웃리치 정지가 거래성 메일을 여기서 다시
  // 막으면 상류에서 레인을 나눈 의미가 없다. 인자가 없으면 종전처럼 outreach 로 닫는다.
  lane: MailOutboundLane = "outreach",
  // 잠금 조회기 주입점(기본값 = 프로덕션 Firestore 조회). 이 게이트가 정말 레인을 보는지를
  // 노드 레인에서 값으로 확인하기 위한 것 — mailOutboundSafety.MailLaneGateDeps 와 같은 결.
  deps: MailLaneGateDeps = {},
): Promise<void> {
  if (!looksLikeEmailAddress(to)) throw failedPrecondition("sendEmail live mode: invalid recipient email.");
  const nowIso = new Date().toISOString();
  const block = await (deps.readOutboundSafetyBlock ?? readOutboundSafetyBlock)(nowIso, mode, lane);
  if (block.blocked) {
    const until = block.blockedUntilIso ? ` until ${block.blockedUntilIso}` : "";
    throw failedPrecondition(`outbound mail safety lock active${until}: ${block.reason}`);
  }
  const domain = emailDomain(to);
  try {
    const records = await withTimeout(
      dns.resolveMx(domain),
      MX_LOOKUP_TIMEOUT_MS,
      "recipient domain DNS validation timeout.",
    );
    const deliverableRecords = records.filter((record) => record.exchange && record.exchange !== ".");
    if (deliverableRecords.length === 0) throw failedPrecondition("recipient domain has no MX records.");
  } catch (error) {
    throw publicRecipientDeliverabilityFailure(error, `mail-deliverability:${domain}`);
  }
}
