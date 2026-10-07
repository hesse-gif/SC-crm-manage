import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { resolveAdminAuthTenantId } from "./authTenantBoundary";
import {
  assertFunctionsEntrypointRuntime,
  currentRuntimeEnvironment,
  DEFAULT_FIRESTORE_DATABASE,
} from "./runtimeEnvironment";

export const adminRuntimeEnvironment = currentRuntimeEnvironment;
assertFunctionsEntrypointRuntime();
export const adminApp = getApps().length ? getApp() : initializeApp();
// Keep the project-root Auth instance available for the rare case where a
// caller must select a tenant other than this runtime's configured tenant.
// `adminAuth` below is deliberately tenant-aware in staging and therefore
// does not itself expose `tenantManager()`.
export const parentAdminAuth = getAuth(adminApp);
export const adminAuthTenantId = resolveAdminAuthTenantId(
  process.env,
  adminRuntimeEnvironment,
);
export const adminAuth = adminAuthTenantId === null
  ? parentAdminAuth
  : parentAdminAuth.tenantManager().authForTenant(adminAuthTenantId);
export const adminDb =
  adminRuntimeEnvironment.databaseId === DEFAULT_FIRESTORE_DATABASE
    ? getFirestore(adminApp)
    : getFirestore(adminApp, adminRuntimeEnvironment.databaseId);
export const adminStorage = getStorage(adminApp);
// undefined 필드(예: 인플루언서의 agencyId)를 가진 문서 set이 Firestore에서 거부되는 것을 방지.
// upsertCreator 등 라이브 쓰기에서 선택 필드가 undefined여도 안전하게 무시하고 저장한다.
try {
  adminDb.settings({ ignoreUndefinedProperties: true });
} catch {
  /* 이미 설정/사용됨 — 무시 */
}
