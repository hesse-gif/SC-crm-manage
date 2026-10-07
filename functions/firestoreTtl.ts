import { Timestamp } from "firebase-admin/firestore";

export const FIRESTORE_TTL_180_DAYS_MS = 180 * 24 * 60 * 60 * 1000;

function finiteBasisMs(value: number, source: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot derive Firestore TTL from invalid ${source}`);
  }
  return value;
}

export function expireAt180DaysFromDate(basis: Date): Timestamp {
  return Timestamp.fromMillis(finiteBasisMs(basis.getTime(), "Date") + FIRESTORE_TTL_180_DAYS_MS);
}

export function expireAt180DaysFromIso(basisIso: string): Timestamp {
  return Timestamp.fromMillis(finiteBasisMs(Date.parse(basisIso), "ISO timestamp") + FIRESTORE_TTL_180_DAYS_MS);
}

export function expireAt180DaysFromTimestamp(basis: Timestamp): Timestamp {
  return Timestamp.fromMillis(finiteBasisMs(basis.toMillis(), "Timestamp") + FIRESTORE_TTL_180_DAYS_MS);
}
