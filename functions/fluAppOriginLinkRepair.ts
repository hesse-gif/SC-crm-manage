// Operator callable that rewrites persisted `flu.supercent.io` links to the live production
// origin `https://sc-flu.web.app`.
//
// WHY: flu.supercent.io never had a DNS record (NXDOMAIN) — it was an assumed-future custom
// domain that shipped as a code default in mailOAuth.ts / submissionTasks.ts /
// scpEncouragement.ts. Before the defaults were repointed, minted links were already persisted
// into submission_tasks / program_sheet_leads / program_applications and propagated into
// reminder targets/jobs and queued mail outboxes. Code defaults alone can't fix those rows —
// this sweep is the remediation.
//
// SCOPE (deliberately narrow):
//   * Top-level string fields only; a field is rewritten iff it contains the literal dead
//     origin `https://flu.supercent.io` / `http://flu.supercent.io` / bare `flu.supercent.io`.
//   * Only the dead origin substring is replaced — path, query, and fragment survive.
//   * Sent-mail history (`mail_outbound_log`, `scp_coldmail_history`) is deliberately absent:
//     those are audit records of what actually went out and must not be rewritten.
//
// SAFETY RAILS (same family as videoReviewSubjectRepair.ts):
//   * `dryRun` defaults true; applying needs dryRun:false + the confirmation literal.
//   * Per-document transaction: each flagged field is re-read inside the transaction and the
//     write is skipped if the dead origin is no longer present (idempotent re-runs are safe —
//     a rewritten doc simply stops matching).
//   * Audit (LOG-P0-010): one run row per invocation + one row per updated document.
//   * SEC-P0-009: audit stores collection/doc id + field names + sha256-16 of before/after —
//     never the URL itself, which carries an opaque submit capability token.
//
// PAGINATION: each collection is scanned in documentId order up to `limitPerCollection`;
// pass back `nextCursors` to continue. Re-running without cursors is also correct — already
// rewritten docs no longer match, so the sweep is self-draining.

import { createHash } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type CallableRequestShape,
  type Role,
} from "./shared";

export const FLU_APP_ORIGIN_LINK_REPAIR_ACTION = "maintenance.repair_flu_app_origin_links";
export const FLU_APP_ORIGIN_LINK_REPAIR_AUDIT_COLLECTION =
  "flu_app_origin_link_repair_audit";
export const FLU_APP_ORIGIN_LINK_REPAIR_CONFIRMATION =
  "rewrite_flu_supercent_links" as const;

const ADMIN_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin"];

const DEAD_HOST = "flu.supercent.io";
const LIVE_ORIGIN = "https://sc-flu.web.app";
// Right boundary (?![a-zA-Z0-9.-]) so `flu.supercent.ioo` / `flu.supercent.io.evil.com` never
// match; left lookbehind so `notflu.supercent.io` never matches either.
const DEAD_ORIGIN_PATTERN = /https?:\/\/flu\.supercent\.io(?![a-zA-Z0-9.-])|(?<![a-zA-Z0-9.-])flu\.supercent\.io(?![a-zA-Z0-9.-])/g;

const MAX_LIMIT_PER_COLLECTION = 2000;
const DEFAULT_LIMIT_PER_COLLECTION = 500;
const MAX_REPORT_ROWS = 200;

/** Link-source + queued-mail collections. Sent-history collections are excluded on purpose. */
const SWEEP_COLLECTIONS: readonly string[] = [
  "submission_tasks",
  "program_sheet_leads",
  "program_applications",
  "submissions",
  "gem_grants",
  "scp_video_submission_reminder_targets",
  "scp_video_submission_reminder_occurrences",
  "scp_video_submission_reminder_triggers",
  "scp_video_submission_reminder_events",
  "scp_video_submission_second_mail_jobs",
  "scp_video_submission_reminder_settings",
  "scp_application_video_reminder_outbox",
  "scp_video_result_mail_outbox",
  "scp_resubmission_nudge_mail_outbox",
  "scp_content_submitted_mail_outbox",
  "scp_application_confirmed_mail_outbox",
  "scp_onboarding_outbox",
  "scp_integration_event_v2_uid_guide_outbox",
];

function sha256Short(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/** Rewrite every dead-origin occurrence in `value`; returns null when nothing matched. */
export function rewriteDeadAppOrigin(value: string): string | null {
  if (!value.includes(DEAD_HOST)) return null;
  const rewritten = value.replace(
    DEAD_ORIGIN_PATTERN,
    (match) => (match.startsWith("http") ? LIVE_ORIGIN : LIVE_ORIGIN.replace("https://", "")),
  );
  return rewritten === value ? null : rewritten;
}

/** Top-level string fields of `data` that contain the dead origin, mapped to replacements. */
export function deadOriginFieldUpdates(
  data: Record<string, unknown>,
): Record<string, string> {
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;
    const rewritten = rewriteDeadAppOrigin(value);
    if (rewritten !== null) updates[key] = rewritten;
  }
  return updates;
}

type SweepInput = {
  dryRun: boolean;
  confirmation: string;
  limitPerCollection: number;
  cursors: Record<string, string>;
  collections: string[];
};

function parseInput(raw: unknown): SweepInput {
  const data = asRecord(raw);
  const dryRun = data.dryRun !== false; // default true
  const confirmation = asString(data.confirmation);
  if (!dryRun && confirmation !== FLU_APP_ORIGIN_LINK_REPAIR_CONFIRMATION) {
    throw Object.assign(
      new Error(
        `Apply requires confirmation: "${FLU_APP_ORIGIN_LINK_REPAIR_CONFIRMATION}"`,
      ),
      { code: "failed-precondition", errorCode: "flu_app_origin_link_repair_confirmation_required" },
    );
  }
  const rawLimit = Number(data.limitPerCollection);
  const limitPerCollection = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIMIT_PER_COLLECTION, Math.trunc(rawLimit))
    : DEFAULT_LIMIT_PER_COLLECTION;
  const allowed = new Set(SWEEP_COLLECTIONS);
  const requested = Array.isArray(data.collections)
    ? data.collections.map((item) => asString(item)).filter(Boolean)
    : [];
  const collections = requested.length ? requested : [...SWEEP_COLLECTIONS];
  for (const name of collections) {
    if (!allowed.has(name)) {
      throw Object.assign(new Error(`collection not sweepable: ${name}`), {
        code: "invalid-argument",
        errorCode: "flu_app_origin_link_repair_collection_not_allowed",
      });
    }
  }
  const cursors: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(data.cursors))) {
    const cursor = asString(value);
    if (key && cursor) cursors[key] = cursor;
  }
  return { dryRun, confirmation, limitPerCollection, cursors, collections };
}

type CollectionReport = {
  collection: string;
  scanned: number;
  matched: number;
  updated: number;
  hasMore: boolean;
  nextCursor: string;
};

type DocReport = {
  collection: string;
  docId: string;
  fields: string[];
  occurrences: number;
};

export async function repairFluAppOriginLinksHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, FLU_APP_ORIGIN_LINK_REPAIR_ACTION, ADMIN_ROLES);
  const input = parseInput(request.data);
  const db = adminDb;
  const nowIso = new Date().toISOString();
  const runRef = db.collection(FLU_APP_ORIGIN_LINK_REPAIR_AUDIT_COLLECTION).doc();

  const collections: CollectionReport[] = [];
  const docs: DocReport[] = [];
  let totalUpdated = 0;

  await runRef.create({
    action: FLU_APP_ORIGIN_LINK_REPAIR_ACTION,
    kind: "run",
    actorUid: auth.userId,
    actorRole: auth.role,
    actorTeam: auth.team,
    dryRun: input.dryRun,
    limitPerCollection: input.limitPerCollection,
    collections: input.collections,
    result: "started",
    createdAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    for (const collection of input.collections) {
      const report: CollectionReport = {
        collection,
        scanned: 0,
        matched: 0,
        updated: 0,
        hasMore: false,
        nextCursor: "",
      };
      let query = db
        .collection(collection)
        .orderBy(FieldPath.documentId())
        .limit(input.limitPerCollection);
      const cursor = input.cursors[collection];
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      report.scanned = page.size;
      report.hasMore = page.size === input.limitPerCollection;
      report.nextCursor = report.hasMore ? (page.docs.at(-1)?.id ?? "") : "";

      for (const doc of page.docs) {
        const data = doc.data() ?? {};
        const updates = deadOriginFieldUpdates(data);
        const fields = Object.keys(updates);
        if (!fields.length) continue;
        report.matched += 1;
        const occurrences = fields.reduce(
          (sum, field) =>
            sum + (String(data[field]).match(DEAD_ORIGIN_PATTERN)?.length ?? 0),
          0,
        );
        if (docs.length < MAX_REPORT_ROWS) {
          docs.push({ collection, docId: doc.id, fields, occurrences });
        }
        if (input.dryRun) continue;

        // Per-doc transaction: re-read and re-verify inside so a concurrent fix can't be
        // clobbered and a re-run is a natural no-op.
        const updated = await db.runTransaction(async (transaction) => {
          const fresh = await transaction.get(doc.ref);
          if (!fresh.exists) return null;
          const freshData = fresh.data() ?? {};
          const freshUpdates = deadOriginFieldUpdates(freshData);
          if (!Object.keys(freshUpdates).length) return null;
          transaction.update(doc.ref, {
            ...freshUpdates,
            fluAppOriginLinkRepairedAtIso: nowIso,
            fluAppOriginLinkRepairedBy: auth.userId,
          });
          return freshUpdates;
        });
        if (!updated) continue;
        report.updated += 1;
        totalUpdated += 1;
        await db.collection(FLU_APP_ORIGIN_LINK_REPAIR_AUDIT_COLLECTION).add({
          action: FLU_APP_ORIGIN_LINK_REPAIR_ACTION,
          kind: "document",
          runId: runRef.id,
          actorUid: auth.userId,
          collection,
          docId: doc.id,
          fields: Object.keys(updated),
          beforeHash: sha256Short(fields.map((f) => String(data[f])).join("")),
          afterHash: sha256Short(Object.values(updated).join("")),
          createdAtIso: nowIso,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      collections.push(report);
    }
  } catch (error) {
    try {
      await runRef.update({
        result: "failed",
        errorCode: asString(asRecord(error).code, "internal"),
        closedAtIso: new Date().toISOString(),
      });
    } catch (auditError) {
      console.warn(
        "[flu-app-origin-link-repair] run_audit_close_failed",
        JSON.stringify({ runId: runRef.id, code: asString(asRecord(auditError).code, "unknown") }),
      );
    }
    throw error;
  }

  await runRef.update({
    result: input.dryRun ? "dry_run" : "applied",
    totalMatched: collections.reduce((sum, c) => sum + c.matched, 0),
    totalUpdated,
    closedAtIso: new Date().toISOString(),
  });

  return {
    ok: true,
    dryRun: input.dryRun,
    mode: input.dryRun ? "dry_run" : "actual",
    collections,
    totalMatched: collections.reduce((sum, c) => sum + c.matched, 0),
    totalUpdated,
    docs,
    runId: runRef.id,
    behaviorLog: makeBehaviorLog(auth, FLU_APP_ORIGIN_LINK_REPAIR_ACTION, "success", "global", 0),
  };
}
