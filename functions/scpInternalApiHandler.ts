// G007 — composition of the internal video-submissions request pipeline.
// Pure and dependency-injected so it is exhaustively testable without the emulator; the
// production onRequest mount (firebase-functions HTTPS + real OIDC verification + Firestore
// fetch) is the G008B cutover step and is intentionally NOT wired in this release_candidate.

import { toErrorResponse, apiError, type ErrorResponse } from "./scpInternalApiErrors";
import {
  extractBearerToken,
  verifyPortalSubject,
  assertPartnerEntitlement,
  assertPartnerProgramOwnership,
  type PortalAuthConfig,
  type OidcClaims,
  type PartnerProgramOwnership,
  type IncomingHeaders,
} from "./scpInternalApiAuth";
import {
  buildSubmissionsPage,
  parseSubmissionsQuery,
  type SubmissionsPage,
} from "./scpInternalApiProjection";
import { buildObservation, type SloObservation } from "./scpInternalApiObservability";
import type { RawCreatorRow, RawSubmissionRow } from "./scpVideoSubmissionsProjection";

export type InternalApiRequest = {
  method: string;
  headers: IncomingHeaders;
  acceptsJson: boolean;
  partnerId: string;
  programId: string;
  query: Record<string, string | string[] | undefined>;
};

export type SubmissionsDataSource = {
  // Injected read of the canonical serving read model, scoped + generation-stamped.
  loadOwnership: (partnerId: string) => Promise<PartnerProgramOwnership | undefined>;
  loadScope: (partnerId: string, programId: string) => Promise<{
    rows: RawSubmissionRow[];
    creators: RawCreatorRow[];
    generation: string;
  }>;
};

export type HandlerDeps = {
  authConfig: PortalAuthConfig;
  verifyOidcToken: (token: string) => Promise<OidcClaims>;
  dataSource: SubmissionsDataSource;
  cursorSecret: string;
  requestId: string;
  nowMs?: number;
  nowSec?: number;
  environment?: string;
};

export type HandlerResult =
  | { ok: true; status: 200; headers: Record<string, string>; body: SubmissionsPage; observation: SloObservation }
  | { ok: false; status: number; headers: Record<string, string>; body: ErrorResponse["body"]; observation: SloObservation };

const ROUTE = "/internal/scp/v1/partners/{partnerId}/programs/{programId}/video-submissions";

export async function handleVideoSubmissionsRequest(
  request: InternalApiRequest,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const nowSec = deps.nowSec ?? Math.floor(nowMs / 1000);
  const started = nowMs;
  let readCount = 0;
  let status = 200;

  const observe = (bytes: number, backlog: number, includePerformance: boolean): SloObservation =>
    buildObservation({
      runId: "scp-firestore-ux-20260713T122413Z",
      environment: deps.environment ?? "emulator",
      route: ROUTE,
      operation: "list_video_submissions",
      source: "firestore_serving_read_model",
      status,
      latencyMs: Math.max(0, (deps.nowMs ?? Date.now()) - started),
      responseBytes: bytes,
      readCount,
      backlog,
      includePerformance,
    });

  try {
    if (request.method.toUpperCase() !== "GET") throw apiError.methodNotAllowed();
    if (!request.acceptsJson) throw apiError.notAcceptable();

    // Auth: bearer OIDC only -> verify token -> allowlisted subject (REQ-API-002/003).
    const token = extractBearerToken(request.headers, request.query);
    const claims = await deps.verifyOidcToken(token);
    const caller = verifyPortalSubject(claims, deps.authConfig, nowSec);

    // Entitlement BEFORE ownership BEFORE read (REQ-API-004).
    assertPartnerEntitlement(caller, request.partnerId);
    const ownership = await deps.dataSource.loadOwnership(request.partnerId);
    readCount += 1;
    assertPartnerProgramOwnership(ownership, request.partnerId, request.programId);

    const query = parseSubmissionsQuery(request.query);
    const scope = await deps.dataSource.loadScope(request.partnerId, request.programId);
    readCount += scope.rows.length;

    const page = buildSubmissionsPage({
      rows: scope.rows,
      creators: scope.creators,
      query,
      scope: { partnerId: request.partnerId, programId: request.programId, generation: scope.generation },
      secret: deps.cursorSecret,
      nowMs,
    });

    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    const backlog = page.hasMore ? 1 : 0;
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": deps.requestId,
      "x-schema-version": page.schemaVersion,
    };
    return { ok: true, status: 200, headers, body: page, observation: observe(bytes, backlog, query.includePerformance) };
  } catch (error) {
    const response = toErrorResponse(error, deps.requestId);
    status = response.status;
    const includePerformance = request.query?.includePerformance === "true";
    const bytes = Buffer.byteLength(JSON.stringify(response.body), "utf8");
    return { ok: false, status: response.status, headers: response.headers, body: response.body, observation: observe(bytes, 0, includePerformance) };
  }
}
