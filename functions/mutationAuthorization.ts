export type MutationActorRole = "super_admin" | "admin" | "manager" | string;

export type MutationAuthorizationActor = {
  uid: string;
  role: MutationActorRole;
  trustedService?: boolean;
};

function cleanUid(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 180) : "";
}

export function mutationOwnerUids(
  record: Record<string, unknown> | null | undefined,
  options: { includeCreatedBy?: boolean } = {},
): string[] {
  if (!record) return [];
  const attributedOwners = [
    record.ownerUid,
    record.programOwnerUid,
  ];
  const owners = [...new Set(attributedOwners.map(cleanUid).filter(Boolean))];
  if (owners.length || !options.includeCreatedBy) return owners;
  const createdBy = cleanUid(record.createdBy);
  return createdBy ? [createdBy] : [];
}

export function assertMutationOwner(
  actor: MutationAuthorizationActor,
  ownerUids: readonly string[],
  resource = "resource",
): void {
  if (actor.trustedService || actor.role === "super_admin" || actor.role === "admin") return;
  if (actor.role !== "manager" || !cleanUid(actor.uid)) {
    throw permissionDenied(`${resource} mutation requires an authenticated manager or admin`);
  }
  const owners = [...new Set(ownerUids.map(cleanUid).filter(Boolean))];
  if (owners.length !== 1 || owners[0] !== cleanUid(actor.uid)) {
    throw permissionDenied(`${resource} ownership is missing, ambiguous, or belongs to another account`);
  }
}

export function permissionDenied(message: string): Error {
  return Object.assign(new Error(`permission-denied: ${message}`), { code: "permission-denied", errorCode: "permission_denied_unauthorized" });
}
