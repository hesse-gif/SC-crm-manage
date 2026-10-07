export const DEFAULT_FIRESTORE_DATABASE = "(default)" as const;
export const STAGING_FIRESTORE_DATABASE = "flu-staging" as const;

export type FirestoreDatabaseId =
  | typeof DEFAULT_FIRESTORE_DATABASE
  | typeof STAGING_FIRESTORE_DATABASE;

export type FluRuntimeEnvironment = "production" | "staging" | "emulator";

export type RuntimeEnvironmentSource = {
  FLU_RUNTIME_ENV?: string;
  FLU_FIRESTORE_DATABASE?: string;
  FLU_FUNCTIONS_CODEBASE?: string;
  FLU_STAGING_AUTH_TENANT_ID?: string;
  FIREBASE_AUTH_EMULATOR_HOST?: string;
  FIRESTORE_EMULATOR_HOST?: string;
  FUNCTIONS_EMULATOR?: string;
  FIREBASE_CONFIG?: string;
  GCLOUD_PROJECT?: string;
  GOOGLE_CLOUD_PROJECT?: string;
  K_SERVICE?: string;
  FUNCTION_TARGET?: string;
};

export type RuntimeEnvironmentResolution = {
  readonly runtimeEnvironment: FluRuntimeEnvironment;
  readonly databaseId: FirestoreDatabaseId;
  readonly isFirestoreEmulator: boolean;
};

function resolveProductionDatabase(databaseId: string | undefined): FirestoreDatabaseId {
  if (databaseId === undefined || databaseId === DEFAULT_FIRESTORE_DATABASE) {
    return DEFAULT_FIRESTORE_DATABASE;
  }

  throw new Error(
    `FLU_RUNTIME_ENV=production requires FLU_FIRESTORE_DATABASE=${DEFAULT_FIRESTORE_DATABASE}; received ${JSON.stringify(databaseId)}.`,
  );
}

function resolveEmulatorDatabase(databaseId: string | undefined): FirestoreDatabaseId {
  if (databaseId === undefined || databaseId === DEFAULT_FIRESTORE_DATABASE) {
    return DEFAULT_FIRESTORE_DATABASE;
  }
  if (databaseId === STAGING_FIRESTORE_DATABASE) {
    return STAGING_FIRESTORE_DATABASE;
  }

  throw new Error(
    `Firestore emulator database must be ${DEFAULT_FIRESTORE_DATABASE} or ${STAGING_FIRESTORE_DATABASE}; received ${JSON.stringify(databaseId)}.`,
  );
}

/**
 * Resolves the only supported runtime/database pairs before an Admin SDK
 * Firestore client is created. Exact matching is deliberate: a misspelled or
 * partially configured staging environment must never fall back to production.
 */
export function resolveRuntimeEnvironment(
  source: RuntimeEnvironmentSource = process.env,
): RuntimeEnvironmentResolution {
  const runtimeEnvironment = source.FLU_RUNTIME_ENV;
  const configuredDatabase = source.FLU_FIRESTORE_DATABASE;
  const isFirestoreEmulator = Boolean(source.FIRESTORE_EMULATOR_HOST);

  if (runtimeEnvironment === undefined) {
    if (isFirestoreEmulator) {
      return {
        runtimeEnvironment: "emulator",
        databaseId: resolveEmulatorDatabase(configuredDatabase),
        isFirestoreEmulator: true,
      };
    }

    if (configuredDatabase !== undefined) {
      throw new Error(
        `FLU_FIRESTORE_DATABASE was set without FLU_RUNTIME_ENV; refusing implicit database selection.`,
      );
    }

    return {
      runtimeEnvironment: "production",
      databaseId: DEFAULT_FIRESTORE_DATABASE,
      isFirestoreEmulator: false,
    };
  }

  if (runtimeEnvironment === "production") {
    return {
      runtimeEnvironment,
      databaseId: resolveProductionDatabase(configuredDatabase),
      isFirestoreEmulator,
    };
  }

  if (runtimeEnvironment === "staging") {
    if (configuredDatabase !== STAGING_FIRESTORE_DATABASE) {
      throw new Error(
        `FLU_RUNTIME_ENV=staging requires FLU_FIRESTORE_DATABASE=${STAGING_FIRESTORE_DATABASE}; received ${JSON.stringify(configuredDatabase)}.`,
      );
    }

    return {
      runtimeEnvironment,
      databaseId: STAGING_FIRESTORE_DATABASE,
      isFirestoreEmulator,
    };
  }

  if (runtimeEnvironment === "emulator") {
    if (!isFirestoreEmulator) {
      throw new Error(
        "FLU_RUNTIME_ENV=emulator requires FIRESTORE_EMULATOR_HOST to be set.",
      );
    }

    return {
      runtimeEnvironment,
      databaseId: resolveEmulatorDatabase(configuredDatabase),
      isFirestoreEmulator: true,
    };
  }

  throw new Error(
    `Unsupported FLU_RUNTIME_ENV ${JSON.stringify(runtimeEnvironment)}; expected production, staging, or emulator.`,
  );
}

export const currentRuntimeEnvironment = Object.freeze(resolveRuntimeEnvironment());

/**
 * Demo fixtures are a local test-harness concern. A privileged hosted caller
 * must never be able to populate them in either the production or staging
 * database, even when the callable remains deployed for emulator parity.
 */
export function assertDemoSeedCreationAllowed(
  resolution: RuntimeEnvironmentResolution = currentRuntimeEnvironment,
): void {
  if (
    resolution.runtimeEnvironment !== "emulator" || !resolution.isFirestoreEmulator
  ) {
    throw Object.assign(
      new Error("failed-precondition: demo seed creation is restricted to the Firestore emulator"),
      { code: "failed-precondition", errorCode: "assert_demo_seed_creation_allowed_demo_seed_creation_restricted" },
    );
  }
}

export const STAGING_FUNCTIONS_FACADE_SYMBOL = Symbol.for(
  "flu.functions.staging-facade",
);

export const STAGING_RELEASE_SOURCE_COMMIT_SYMBOL = Symbol.for(
  "flu.functions.staging-release-source-commit",
);

const EMULATOR_PROJECT_ID = "demo-flu";

function projectIdFromFirebaseConfig(source: RuntimeEnvironmentSource): string {
  const raw = source.FIREBASE_CONFIG;
  if (!raw || !raw.trim().startsWith("{")) return "";

  try {
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    return typeof parsed.projectId === "string" ? parsed.projectId : "";
  } catch {
    return "";
  }
}

function currentProjectIds(source: RuntimeEnvironmentSource): string[] {
  return [
    source.GCLOUD_PROJECT,
    source.GOOGLE_CLOUD_PROJECT,
    projectIdFromFirebaseConfig(source),
  ].filter(
    (value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
  );
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)
  );
}

function isLoopbackEmulatorHost(value: string | undefined): boolean {
  if (!value || value !== value.trim()) return false;

  try {
    const parsed = new URL(`http://${value}`);
    return (
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      /^\d+$/.test(parsed.port) &&
      Number(parsed.port) > 0 &&
      Number(parsed.port) <= 65535 &&
      isLoopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isAttestedLocalFunctionsEmulator(
  source: RuntimeEnvironmentSource,
): boolean {
  const projectIds = currentProjectIds(source);
  return (
    source.FUNCTIONS_EMULATOR === "true" &&
    isLoopbackEmulatorHost(source.FIRESTORE_EMULATOR_HOST) &&
    projectIds.length === 1 &&
    projectIds[0] === EMULATOR_PROJECT_ID
  );
}

/**
 * Synthetic fixtures are permitted only in the fully attested local Functions
 * emulator. Runtime labels or emulator environment variables on their own are
 * insufficient because hosted/staging processes must never opt themselves into
 * demo data by configuration drift.
 */
export function isDemoFixtureRuntimeAllowed(
  source: RuntimeEnvironmentSource = process.env,
  resolution: RuntimeEnvironmentResolution = resolveRuntimeEnvironment(source),
): boolean {
  return resolution.runtimeEnvironment === "emulator"
    && resolution.isFirestoreEmulator
    && isAttestedLocalFunctionsEmulator(source);
}

export function assertFunctionsEntrypointRuntime(
  source: RuntimeEnvironmentSource = process.env,
  resolution: RuntimeEnvironmentResolution = currentRuntimeEnvironment,
): void {
  const stagingFacadeActive =
    (globalThis as Record<PropertyKey, unknown>)[STAGING_FUNCTIONS_FACADE_SYMBOL] === true;
  const configuredCodebase = source.FLU_FUNCTIONS_CODEBASE;
  const functionsEmulatorDeclared = source.FUNCTIONS_EMULATOR === "true";
  const functionsEmulatorPresent = Boolean(source.FUNCTIONS_EMULATOR);
  const localFunctionsEmulator = isAttestedLocalFunctionsEmulator(source);
  const hostedRuntime =
    Boolean(source.K_SERVICE || source.FUNCTION_TARGET) && !localFunctionsEmulator;
  const hostedEmulatorContamination =
    Boolean(source.FIRESTORE_EMULATOR_HOST) ||
    Boolean(source.FIREBASE_AUTH_EMULATOR_HOST) ||
    functionsEmulatorPresent;
  const malformedFunctionsEmulator =
    functionsEmulatorPresent && !localFunctionsEmulator;

  if (stagingFacadeActive) {
    if (
      resolution.runtimeEnvironment !== "staging" ||
      resolution.databaseId !== STAGING_FIRESTORE_DATABASE ||
      configuredCodebase !== "staging" ||
      malformedFunctionsEmulator ||
      (hostedRuntime && hostedEmulatorContamination)
    ) {
      throw new Error(
        "FLU_FUNCTIONS_ENTRYPOINT_GUARD: staging facade requires the staging runtime, flu-staging database, staging codebase, and no hosted emulator contamination.",
      );
    }
    return;
  }

  if (
    hostedRuntime &&
    (
      source.FLU_RUNTIME_ENV !== "production" ||
      source.FLU_FIRESTORE_DATABASE !== DEFAULT_FIRESTORE_DATABASE ||
      configuredCodebase !== "default" ||
      resolution.runtimeEnvironment !== "production" ||
      resolution.databaseId !== DEFAULT_FIRESTORE_DATABASE ||
      hostedEmulatorContamination
    )
  ) {
    throw new Error(
      "FLU_FUNCTIONS_ENTRYPOINT_GUARD: hosted default Functions require the exact production runtime, (default) database, default codebase, and no emulator variables.",
    );
  }

  if (malformedFunctionsEmulator) {
    throw new Error(
      "FLU_FUNCTIONS_ENTRYPOINT_GUARD: FUNCTIONS_EMULATOR=true is allowed only for the demo-flu project with a loopback Firestore emulator.",
    );
  }

  if (configuredCodebase !== undefined && configuredCodebase !== "default") {
    throw new Error(
      "FLU_FUNCTIONS_ENTRYPOINT_GUARD: the default Functions entrypoint requires FLU_FUNCTIONS_CODEBASE=default.",
    );
  }

  if (resolution.runtimeEnvironment === "staging") {
    throw new Error(
      "FLU_FUNCTIONS_ENTRYPOINT_GUARD: the default Functions entrypoint cannot use the staging runtime.",
    );
  }

  if (resolution.databaseId !== DEFAULT_FIRESTORE_DATABASE) {
    throw new Error(
      "FLU_FUNCTIONS_ENTRYPOINT_GUARD: the default Functions entrypoint requires the (default) database.",
    );
  }

}

export function isStagingRuntime(): boolean {
  return currentRuntimeEnvironment.runtimeEnvironment === "staging";
}
