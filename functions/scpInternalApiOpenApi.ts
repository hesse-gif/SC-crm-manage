// G007-L01 — OpenAPI source of truth for the Creator Portal internal video-submissions API
// (REQ-API-001/015). docs/scp-video-submissions.v1.openapi.json is generated from this
// object and validated by the contract test; examples use synthetic IDs only.

export const SCP_VIDEO_SUBMISSIONS_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Flu SCP Video Submissions Internal API",
    version: "scp-video-submissions.v1",
    description:
      "Server-to-server read API the SCP Creator Portal uses to poll approved/pending video submissions and optional performance. Flu-owned; release_candidate only. Portal never reads Flu Firestore directly.",
  },
  servers: [{ url: "https://internal.flu.invalid", description: "Flu-owned internal API (App Hosting server runtime only)" }],
  paths: {
    "/internal/scp/v1/partners/{partnerId}/programs/{programId}/video-submissions": {
      get: {
        operationId: "listVideoSubmissions",
        summary: "List video submissions for a partner/program scope",
        security: [{ portalWorkloadOidc: [] }],
        parameters: [
          { name: "partnerId", in: "path", required: true, schema: { type: "string" }, example: "partner_synthetic_001" },
          { name: "programId", in: "path", required: true, schema: { type: "string" }, example: "program_synthetic_001" },
          { name: "updatedAfter", in: "query", required: false, schema: { type: "string", format: "date-time" }, description: "Inclusive lower bound (canonical ISO-8601 UTC)." },
          { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Opaque signed, scope/filter/generation-bound, expiring cursor." },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "includePerformance", in: "query", required: false, schema: { type: "boolean", default: false } },
        ],
        responses: {
          "200": {
            description: "A page of submissions ordered by (sourceUpdatedAt ASC, submissionId ASC).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoSubmissionsPage" } } },
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "403": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "405": { $ref: "#/components/responses/Error" },
          "406": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "422": { $ref: "#/components/responses/Error" },
          "429": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
          "503": { $ref: "#/components/responses/Error" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      portalWorkloadOidc: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Google-signed workload OIDC ID token for the Portal App Hosting runtime service account. No browser/client/creator OAuth, API key, or cookie.",
      },
    },
    responses: {
      Error: {
        description: "Typed error with redacted details, retryability, and headers.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
    },
    schemas: {
      VideoSubmissionsPage: {
        type: "object",
        required: ["schemaVersion", "partnerId", "programId", "generation", "items", "creators", "hasMore", "sourceWatermark"],
        properties: {
          schemaVersion: { type: "string", const: "scp-video-submissions.v1" },
          partnerId: { type: "string" },
          programId: { type: "string" },
          generation: { type: "string" },
          items: { type: "array", items: { oneOf: [{ $ref: "#/components/schemas/VideoSubmission" }, { $ref: "#/components/schemas/VideoSubmissionTombstone" }] } },
          creators: { type: "array", items: { $ref: "#/components/schemas/CreatorRef" } },
          nextCursor: { type: ["string", "null"] },
          hasMore: { type: "boolean" },
          sourceWatermark: { type: "string" },
        },
      },
      VideoSubmission: {
        type: "object",
        required: ["submissionId", "partnerId", "programId", "portalCreatorId", "enrollmentId", "videoUrl", "reviewStatus", "reviewRevision", "sourceUpdatedAt", "removed"],
        properties: {
          submissionId: { type: "string", example: "submission_synthetic_001" },
          partnerId: { type: "string" },
          programId: { type: "string" },
          portalCreatorId: { type: "string", example: "portal_creator_synthetic_001" },
          enrollmentId: { type: "string", example: "enrollment_synthetic_001" },
          videoUrl: { type: "string" },
          reviewStatus: { type: "string", enum: ["pending", "approved", "rejected", "needs_review"] },
          reviewRevision: { type: "string" },
          sourceUpdatedAt: { type: "string", format: "date-time" },
          removed: { type: "boolean", const: false },
          performance: { $ref: "#/components/schemas/Performance" },
        },
      },
      VideoSubmissionTombstone: {
        type: "object",
        required: ["submissionId", "partnerId", "programId", "sourceUpdatedAt", "removed", "reason"],
        properties: {
          submissionId: { type: "string" },
          partnerId: { type: "string" },
          programId: { type: "string" },
          sourceUpdatedAt: { type: "string", format: "date-time" },
          removed: { type: "boolean", const: true },
          reason: { type: "string" },
        },
      },
      Performance: {
        type: "object",
        required: ["coverage", "eligibleViews", "excludedViews", "performanceDays", "primaryAudienceCountry", "dailyViewerCountries"],
        properties: {
          coverage: { type: "string", enum: ["complete", "partial"] },
          eligibleViews: { type: "string", description: "Decimal string; never a JSON number." },
          excludedViews: { type: "string", description: "Decimal string; never a JSON number." },
          performanceDays: { type: "integer", maximum: 28 },
          primaryAudienceCountry: { type: "string", description: "Raw country only; no CPM/tier/policy/reward/payout." },
          dailyViewerCountries: {
            type: "array",
            items: {
              type: "object",
              required: ["date", "country", "views"],
              properties: { date: { type: "string", format: "date" }, country: { type: "string" }, views: { type: "string" } },
            },
          },
        },
      },
      CreatorRef: {
        type: "object",
        required: ["portalCreatorId", "displayName", "handle"],
        properties: { portalCreatorId: { type: "string" }, displayName: { type: "string" }, handle: { type: "string" } },
      },
      ApiError: {
        type: "object",
        required: ["schemaVersion", "error"],
        properties: {
          schemaVersion: { type: "string", const: "scp-video-submissions.v1" },
          error: {
            type: "object",
            required: ["code", "message", "retryable", "requestId", "details"],
            properties: {
              code: {
                type: "string",
                enum: ["invalid_request", "unauthenticated", "forbidden", "not_found", "method_not_allowed", "not_acceptable", "cursor_conflict", "unprocessable_source", "rate_limited", "internal", "unavailable"],
              },
              message: { type: "string" },
              retryable: { type: "boolean" },
              requestId: { type: "string" },
              details: { type: "array", items: { type: "object", required: ["reason"], properties: { field: { type: "string" }, reason: { type: "string" } } } },
            },
          },
        },
      },
    },
  },
} as const;

export function openApiJson(): string {
  return `${JSON.stringify(SCP_VIDEO_SUBMISSIONS_OPENAPI, null, 2)}\n`;
}
