import type {
  RuntimeEnvironmentResolution,
  RuntimeEnvironmentSource,
} from "./runtimeEnvironment";

export type AdminAuthTenantId = string | null;

type CallableAuthShape = {
  uid?: unknown;
  token?: unknown;
};

type TenantClaim = {
  readonly present: boolean;
  readonly value: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exactTenantId(value: unknown, variableName: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  ) {
    throw new Error(
      `${variableName} must be an exact non-empty Firebase Auth tenant ID.`,
    );
  }
  return value;
}

function callableBoundaryError(
  code: "unauthenticated" | "permission-denied",
  message: string,
): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function tenantClaimFromToken(token: unknown): TenantClaim {
  const tokenClaims = asRecord(token);
  const firebaseClaims = asRecord(tokenClaims.firebase);
  if (!Object.prototype.hasOwnProperty.call(firebaseClaims, "tenant")) {
    return { present: false, value: null };
  }

  const tenant = firebaseClaims.tenant;
  if (typeof tenant !== "string" || tenant.length === 0) {
    return { present: true, value: null };
  }
  return { present: true, value: tenant };
}

/**
 * Selects the only Admin Auth realm allowed for the resolved runtime. Staging
 * must declare a tenant exactly; production/emulator must stay in the parent
 * project realm and reject leaked tenant configuration.
 */
export function resolveAdminAuthTenantId(
  source: RuntimeEnvironmentSource,
  resolution: RuntimeEnvironmentResolution,
): AdminAuthTenantId {
  const configuredTenantId = source.FLU_STAGING_AUTH_TENANT_ID;

  if (resolution.runtimeEnvironment === "staging") {
    return exactTenantId(
      configuredTenantId,
      "FLU_STAGING_AUTH_TENANT_ID",
    );
  }

  if (configuredTenantId !== undefined) {
    throw new Error(
      `${resolution.runtimeEnvironment} runtime requires the parent Firebase Auth realm; FLU_STAGING_AUTH_TENANT_ID must be unset.`,
    );
  }
  return null;
}

/**
 * Enforces the Auth realm before a Firebase callable request is projected into
 * the application's reduced auth shape. Anonymous public callables retain
 * their existing contract, while authenticated staging traffic must use the
 * exact tenant and production must use the parent realm.
 */
export function assertCallableAuthTenantBoundary(
  auth: CallableAuthShape | undefined,
  source: RuntimeEnvironmentSource,
  resolution: RuntimeEnvironmentResolution,
): void {
  const expectedTenantId = resolveAdminAuthTenantId(source, resolution);
  const tenantClaim = tenantClaimFromToken(auth?.token);

  if (expectedTenantId === null) {
    if (tenantClaim.present) {
      throw callableBoundaryError(
        "permission-denied",
        "Tenant-scoped credentials cannot call the parent production realm.",
      );
    }
    return;
  }

  // Public callables preserve their existing anonymous contract. Any request
  // that does present Firebase Auth, however, must belong to the stage tenant.
  if (auth === undefined) return;

  if (typeof auth.uid !== "string" || auth.uid.length === 0) {
    throw callableBoundaryError(
      "unauthenticated",
      "Staging callable access requires a tenant-scoped Firebase session.",
    );
  }
  if (!tenantClaim.present || tenantClaim.value !== expectedTenantId) {
    throw callableBoundaryError(
      "permission-denied",
      "The Firebase Auth tenant does not match the staging runtime.",
    );
  }
}
