import { createHash } from "node:crypto";
import { envEmail } from "./opsDefaults";
import { compileOutboundMailArtifact } from "./mailSignature";
import { resolveMailSubject } from "./mailCompiler";
import { mailAssetManifest, mailAssetPreviewContents } from "./mailAssets";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";

const PREVIEW_ROLES = ["super_admin", "admin", "manager"] as const;
const UNRESOLVED_VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

function unresolvedVars(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(UNRESOLVED_VAR_RE)) found.add(match[1]);
  }
  return [...found].slice(0, 20);
}

function previewTrackingId(data: Record<string, unknown>): string {
  const supplied = asString(data.trackingId, "").trim();
  if (/^[A-Za-z0-9_-]{4,120}$/.test(supplied)) return supplied;
  const seed = `${asString(data.draftRef, "preview")}\u0000${asString(data.subject, "")}`;
  return `preview-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

// Pure callable: no Firestore mutation, no provider call, and no raw body/PII
// in logs. The returned artifact is the same server compile contract used by
// sendEmailLive when the same trackingId/template revision is supplied.
export async function previewEmailDraft(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_preview.render", PREVIEW_ROLES);
  const data = asRecord(request.data);
  const body = asString(data.body, asString(data.text));
  const subject = resolveMailSubject(data.subject, asRecord(data.templateValues));
  const recipient = asString(data.recipient, asString(data.to));
  const sender = asString(data.sender, asString(data.from));
  const conversationId = asString(data.conversationId);
  const artifact = await compileOutboundMailArtifact({
    body,
    bodyFormat: data.bodyFormat,
    values: asRecord(data.templateValues),
    templateRevision: data.templateRevision,
  }, { trackingId: previewTrackingId(data) });

  const warnings: string[] = [];
  if (!recipient) warnings.push("수신자 미지정 — 대화/리드 컨텍스트에서 수신 이메일을 확인하세요.");
  if (!subject) warnings.push("제목 미지정.");
  if (!body.trim()) warnings.push("본문이 비어 있습니다.");
  const vars = unresolvedVars(body, asString(data.subject));
  if (vars.length) warnings.push(`치환되지 않은 변수: ${vars.map((v) => `{{${v}}}`).join(", ")}`);

  return {
    ok: true,
    // 응답 artifact는 manifest만 담고, 이미지 원문은 assetContents로 분리 전달
    // (프리뷰 iframe이 cid:를 data:로 로컬 치환 — 원격 요청 0 유지).
    artifact: { ...artifact, assets: mailAssetManifest(artifact.assets) },
    assetContents: mailAssetPreviewContents(artifact.assets),
    // Compatibility fields are aliases of the artifact, never a second render.
    html: artifact.compiledHtml,
    text: artifact.text,
    resolvedSubject: subject,
    recipientLabel: recipient || "(수신자 미지정)",
    senderLabel: sender || envEmail("FLU_DEFAULT_SIGNATURE_EMAIL"),
    conversationId,
    warnings,
    sideEffects: "none",
    behaviorLog: makeBehaviorLog(auth, "mail_preview.render", "success"),
  };
}
