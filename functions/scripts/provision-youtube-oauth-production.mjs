import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { provisionScpPortalCreatorBinding } from "../lib/scpPortalCreatorBinding.js";

const FLU_PROJECT_ID = "influchat-77db6";
const PORTAL_PROJECT_ID = "scp-creator-portal";
const PROGRAM_ID = "view-cpm";
const POLICY_VERSION = "view-cpm-2026-07-v1";
const MANIFEST_SCHEMA = "scp.youtube-oauth-mapping-provision.v1";

const options = parseArgs(process.argv.slice(2));
const app = initializeApp({ credential: applicationDefault(), projectId: FLU_PROJECT_ID }, "youtube-oauth-production-provision");
const db = getFirestore(app);
const apiKey = execFileSync("gcloud", [
  "secrets", "versions", "access", "latest",
  "--secret=YOUTUBE_API_KEY",
  `--project=${FLU_PROJECT_ID}`,
], { encoding: "utf8" }).trim();

const candidates = await loadCandidates(db, apiKey);
const safePlan = candidates.map(({ email: _email, ...candidate }) => candidate)
  .sort((a, b) => a.portalCreatorId.localeCompare(b.portalCreatorId));
const planHash = sha256(JSON.stringify({ schemaVersion: MANIFEST_SCHEMA, mappings: safePlan }));

if (!options.apply) {
  console.log(JSON.stringify({ action: "dry-run", count: candidates.length, planHash }, null, 2));
  process.exit(0);
}
if (options.expectedPlanHash !== planHash) throw new Error("plan_hash_mismatch");

for (const candidate of candidates) {
  await canonicalizeChannelAuthority(db, candidate, planHash);
  const data = {
    channelId: candidate.channelId,
    dryRun: true,
    enrollmentId: candidate.enrollmentId,
    fluCreatorId: candidate.fluCreatorId,
    partnerId: candidate.partnerId,
    portalCreatorId: candidate.portalCreatorId,
    programId: PROGRAM_ID,
    sourceApplicationId: candidate.sourceApplicationId,
  };
  const request = {
    auth: { uid: "youtube-oauth-production-provisioner", token: { role: "super_admin", team: "aix" } },
    data,
  };
  await provisionScpPortalCreatorBinding(request, { db });
  await provisionScpPortalCreatorBinding({ ...request, data: { ...data, dryRun: false } }, { db });
}

await writeFile(options.manifestPath, JSON.stringify({
  mappings: candidates.map((candidate) => ({
    channelId: candidate.channelId,
    email: candidate.email,
    enrollmentId: candidate.enrollmentId,
    fluCreatorId: candidate.fluCreatorId,
    partnerId: candidate.partnerId,
    policyVersion: POLICY_VERSION,
    portalCreatorId: candidate.portalCreatorId,
    programId: PROGRAM_ID,
    sourceApplicationId: candidate.sourceApplicationId,
  })),
  schemaVersion: MANIFEST_SCHEMA,
}, null, 2), { mode: 0o600 });

console.log(JSON.stringify({
  action: "applied",
  bindingCount: candidates.length,
  manifestPath: options.manifestPath,
  planHash,
  portalProjectId: PORTAL_PROJECT_ID,
}, null, 2));

function parseArgs(argv) {
  const values = new Map();
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    const key = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? "" : argument.slice(separator + 1);
    if (!["--expected-plan-hash", "--manifest", "--mode"].includes(key) || !value || values.has(key)) {
      throw new Error("invalid_cli_arguments");
    }
    values.set(key, value);
  }
  const mode = values.get("--mode") ?? "dry-run";
  const apply = mode === "apply";
  const expectedPlanHash = values.get("--expected-plan-hash");
  const manifestPath = values.get("--manifest") ?? "/tmp/scp-youtube-oauth-production-manifest.json";
  if (!["apply", "dry-run"].includes(mode) || apply !== Boolean(expectedPlanHash)) throw new Error("invalid_cli_arguments");
  if (expectedPlanHash && !/^[a-f0-9]{64}$/.test(expectedPlanHash)) throw new Error("invalid_cli_arguments");
  if (!manifestPath.startsWith("/tmp/") || !manifestPath.endsWith(".json")) throw new Error("invalid_cli_arguments");
  return { apply, expectedPlanHash, manifestPath };
}

async function loadCandidates(firestore, youtubeApiKey) {
  const snapshot = await firestore.collection("program_applications").where("status", "==", "approved").get();
  const candidates = [];
  for (const document of snapshot.docs) {
    const application = document.data();
    if (application.source !== "scp" || application.programId !== "scp" || !validIso(application.workflowSyncedAtIso)) continue;
    const creatorId = string(application.creatorId);
    const leadId = string(application.leadId);
    if (!creatorId || !leadId || string(application.leadRef) !== `program_sheet_leads/${leadId}`) throw new Error("authority_conflict");
    const [creatorSnapshot, leadSnapshot] = await Promise.all([
      firestore.collection("creators").doc(creatorId).get(),
      firestore.collection("program_sheet_leads").doc(leadId).get(),
    ]);
    if (!creatorSnapshot.exists || !leadSnapshot.exists) throw new Error("authority_missing");
    const creator = creatorSnapshot.data();
    const lead = leadSnapshot.data();
    if (creator.source !== "program_application" || string(creator.programId) !== "scp") throw new Error("creator_authority_conflict");
    if (lead.qualificationStatus !== "pass"
      || string(lead.bridgedApplicationRef) !== document.ref.path
      || string(lead.bridgedCreatorId) !== creatorId) throw new Error("lead_authority_conflict");
    const emails = [application.email, creator.email, lead.email].map((value) => string(value).toLowerCase()).filter(Boolean);
    if (emails.length < 2 || new Set(emails).size !== 1 || !/^\S+@\S+\.\S+$/.test(emails[0])) throw new Error("email_authority_conflict");
    const youtubeUrl = string(application.youtubeUrl || lead.youtubeUrl || lead.applicant?.youtubeUrl);
    const channelId = await resolveChannelId(youtubeUrl, youtubeApiKey);
    const suffix = sha256(`${document.id}\0${creatorId}`).slice(0, 24);
    candidates.push({
      channelId,
      email: emails[0],
      enrollmentId: `enrollment-${suffix}`,
      fluCreatorId: creatorId,
      leadId,
      partnerId: `partner-${suffix}`,
      portalCreatorId: `creator-${suffix}`,
      sourceApplicationId: document.id,
      youtubeUrlHash: sha256(youtubeUrl),
    });
  }
  if (candidates.length === 0 || candidates.length > 50) throw new Error("candidate_count_out_of_bounds");
  for (const key of ["channelId", "email", "enrollmentId", "fluCreatorId", "portalCreatorId"]) {
    if (new Set(candidates.map((candidate) => candidate[key])).size !== candidates.length) throw new Error("candidate_identity_conflict");
  }
  return candidates;
}

async function resolveChannelId(youtubeUrl, key) {
  const handle = /youtube\.com\/@([^/?#]+)/i.exec(youtubeUrl)?.[1];
  const channelFromUrl = /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i.exec(youtubeUrl)?.[1];
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  if (channelFromUrl) url.searchParams.set("id", channelFromUrl);
  else if (handle) url.searchParams.set("forHandle", handle);
  else throw new Error("unsupported_youtube_url");
  url.searchParams.set("key", key);
  const response = await fetch(url);
  const value = await response.json();
  const channelId = value?.items?.[0]?.id;
  if (!response.ok || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId ?? "")) throw new Error("youtube_channel_resolution_failed");
  return channelId;
}

async function canonicalizeChannelAuthority(firestore, candidate, planHash) {
  const applicationRef = firestore.collection("program_applications").doc(candidate.sourceApplicationId);
  const leadRef = firestore.collection("program_sheet_leads").doc(candidate.leadId);
  const auditRef = firestore.collection("scp_youtube_channel_resolution_audit")
    .doc(sha256(`${candidate.sourceApplicationId}\0${candidate.channelId}`).slice(0, 40));
  await firestore.runTransaction(async (transaction) => {
    const [applicationSnapshot, leadSnapshot, auditSnapshot] = await Promise.all([
      transaction.get(applicationRef), transaction.get(leadRef), transaction.get(auditRef),
    ]);
    const application = applicationSnapshot.data() ?? {};
    const lead = leadSnapshot.data() ?? {};
    if (string(application.creatorId) !== candidate.fluCreatorId
      || string(lead.bridgedApplicationRef) !== applicationRef.path
      || string(lead.bridgedCreatorId) !== candidate.fluCreatorId) throw new Error("authority_changed");
    for (const existing of [application.youtubeChannelId, lead.youtubeEnrichment?.channelId]) {
      if (existing && existing !== candidate.channelId) throw new Error("channel_authority_conflict");
    }
    if (auditSnapshot.exists) {
      const audit = auditSnapshot.data();
      if (audit.channelId !== candidate.channelId || audit.planHash !== planHash) throw new Error("audit_conflict");
    }
    transaction.set(applicationRef, { youtubeChannelId: candidate.channelId }, { merge: true });
    transaction.set(leadRef, {
      youtubeEnrichment: {
        ...(lead.youtubeEnrichment ?? {}),
        channelId: candidate.channelId,
        resolveKind: "oauth_provisioning_live_api",
        status: "success",
      },
    }, { merge: true });
    if (!auditSnapshot.exists) transaction.create(auditRef, {
      channelId: candidate.channelId,
      planHash,
      resolver: "youtube-data-api-v3",
      sourceApplicationHash: sha256(candidate.sourceApplicationId),
      youtubeUrlHash: candidate.youtubeUrlHash,
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function string(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
