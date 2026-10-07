// Firebase 클라이언트 초기화. config는 .env.local (NEXT_PUBLIC_FIREBASE_*).
// 검증/개발: NEXT_PUBLIC_USE_EMULATOR=1 이면 demo-flu 프로젝트 + 로컬 에뮬레이터 연결.
// 클라는 읽기 최소 + Auth만. 쓰기/집계/외부호출은 Functions 경유(SEC-P0-004 / NET-P0-012).
import { initializeApp, getApps, type FirebaseOptions } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
// SEC-P0-004: 클라이언트는 Firestore SDK 미사용 — 모든 데이터 접근은 Functions(callable) 경유.

const useEmulator = process.env.NEXT_PUBLIC_USE_EMULATOR === "1";
const independentMixmax = process.env.NEXT_PUBLIC_MIXMAX_INDEPENDENT === "1";
const functionsEmulatorHost = process.env.NEXT_PUBLIC_FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001";
const authEmulatorHost = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";

export type FluRuntimeEnvironment =
  | "emulator"
  | "staging-emulator"
  | "production"
  | "staging";

type ResolveFluRuntimeEnvironmentOptions = {
  useEmulator: boolean;
  configuredEnvironment: string | undefined;
};

type ResolveFluAuthTenantIdOptions = {
  runtimeEnvironment: FluRuntimeEnvironment;
  configuredTenantId: string | undefined;
};

// Hosted builds must declare their data lane explicitly. Emulator calls retain the
// original export names so existing local Firebase suites remain compatible.
export function resolveFluRuntimeEnvironment({
  useEmulator: emulatorEnabled,
  configuredEnvironment,
}: ResolveFluRuntimeEnvironmentOptions): FluRuntimeEnvironment {
  if (emulatorEnabled) {
    return configuredEnvironment === "staging" ? "staging-emulator" : "emulator";
  }
  if (configuredEnvironment === "production" || configuredEnvironment === "staging") {
    return configuredEnvironment;
  }
  throw new Error(
    'NEXT_PUBLIC_FLU_RUNTIME_ENV must be exactly "production" or "staging" for hosted builds. '
    + "로컬 개발은 에뮬레이터 레인이 기본입니다 — .env.development(NEXT_PUBLIC_USE_EMULATOR=1)를 유지한 채 "
    + "npm run dev 를 사용하고, hosted config 개발은 .env.local 에 NEXT_PUBLIC_FLU_RUNTIME_ENV 와 "
    + "NEXT_PUBLIC_FIREBASE_* 값을 설정하세요.",
  );
}

export function resolveFluCallableName(
  logicalName: string,
  runtimeEnvironment: FluRuntimeEnvironment,
): string {
  if (!/^[a-z][A-Za-z0-9]*$/.test(logicalName)) {
    throw new Error("Flu callable logical name must be a non-empty lowerCamel identifier.");
  }
  if (runtimeEnvironment === "production" || runtimeEnvironment === "emulator") {
    return logicalName;
  }
  if (runtimeEnvironment === "staging" || runtimeEnvironment === "staging-emulator") {
    return `staging${logicalName[0].toUpperCase()}${logicalName.slice(1)}`;
  }
  throw new Error("Unsupported Flu callable runtime environment.");
}

function exactFirebaseAuthTenantId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  ) {
    throw new Error(
      "NEXT_PUBLIC_FIREBASE_AUTH_TENANT_ID must be an exact non-empty Firebase Auth tenant ID for staging.",
    );
  }
  return value;
}

/**
 * Hosted staging must use an Identity Platform tenant. Production is pinned to
 * the parent project realm. Staging-emulator follows the same tenant contract;
 * the default emulator remains parent-realm compatible.
 */
export function resolveFluAuthTenantId({
  runtimeEnvironment,
  configuredTenantId,
}: ResolveFluAuthTenantIdOptions): string | null {
  if (
    runtimeEnvironment === "staging" ||
    runtimeEnvironment === "staging-emulator"
  ) {
    return exactFirebaseAuthTenantId(configuredTenantId);
  }

  if (configuredTenantId !== undefined) {
    throw new Error(
      "Production and default emulator builds require the parent Firebase Auth realm; NEXT_PUBLIC_FIREBASE_AUTH_TENANT_ID must be unset.",
    );
  }
  return null;
}

export function assertFluAuthUserTenant(
  userTenantId: string | null | undefined,
  expectedTenantId: string | null,
): void {
  const actualTenantId = userTenantId ?? null;
  if (actualTenantId !== expectedTenantId) {
    throw new Error(
      "The signed-in Firebase user belongs to a different authentication realm.",
    );
  }
}

export const fluRuntimeEnvironment = resolveFluRuntimeEnvironment({
  useEmulator,
  configuredEnvironment: process.env.NEXT_PUBLIC_FLU_RUNTIME_ENV,
});

export const fluAuthTenantId = resolveFluAuthTenantId({
  runtimeEnvironment: fluRuntimeEnvironment,
  configuredTenantId: process.env.NEXT_PUBLIC_FIREBASE_AUTH_TENANT_ID,
});

export const FLU_STAGING_FIREBASE_APP_NAME = "flu-staging";

export function getFluCallableName(logicalName: string): string {
  return resolveFluCallableName(logicalName, fluRuntimeEnvironment);
}

// 에뮬레이터 모드에선 projectId를 반드시 demo-flu로 고정한다.
// (NEXT_PUBLIC_FIREBASE_PROJECT_ID=influchat-77db6 가 설정돼 있으면 callable URL이
//  /influchat-77db6/us-central1/* 가 되어 demo-flu 에뮬레이터에 매칭되지 않고 → 404 → CORS preflight 실패 → SDK "internal".
//  운영(useEmulator=false)에선 실제 config를 그대로 쓴다. cors:true 가 운영 CORS를 처리.)
const firebaseConfig: FirebaseOptions = useEmulator
  ? { apiKey: "demo-key", projectId: independentMixmax ? "demo-mixmax" : "demo-flu", authDomain: independentMixmax ? "demo-mixmax.firebaseapp.com" : "demo-flu.firebaseapp.com" }
  : {
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    };

if (independentMixmax && !useEmulator && firebaseConfig.projectId !== "influencer-crm-296ca") {
  throw new Error("Mixmax must use its own Firebase project: influencer-crm-296ca.");
}

const firebaseAppName =
  fluRuntimeEnvironment === "staging" ||
  fluRuntimeEnvironment === "staging-emulator"
    ? FLU_STAGING_FIREBASE_APP_NAME
    : "[DEFAULT]";
const existingFirebaseApp = getApps().find((app) => app.name === firebaseAppName);
export const firebaseApp = existingFirebaseApp ?? (
  firebaseAppName === "[DEFAULT]"
    ? initializeApp(firebaseConfig)
    : initializeApp(firebaseConfig, firebaseAppName)
);
export const auth = getAuth(firebaseApp);
// Must be assigned before auth persistence is observed or any sign-in starts.
// null explicitly selects the parent realm for production/default emulator.
auth.tenantId = fluAuthTenantId;
export const functions = getFunctions(firebaseApp, independentMixmax ? "asia-northeast3" : "us-central1");
export const db = getFirestore(firebaseApp, "mixmax");
const appCheckSiteKey = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY;
const appCheckDebugToken = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN;

// 로컬 에뮬레이터 연결 (브라우저, 1회). 검증 하네스·ralph가 사용.
declare global {
  // eslint-disable-next-line no-var
  var __FLU_EMU__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __FLU_APP_CHECK__: boolean | undefined;
  // eslint-disable-next-line no-var
  var FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string | undefined;
}
if (!useEmulator && typeof window !== "undefined" && appCheckDebugToken && !globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN) {
  globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = appCheckDebugToken === "true" ? true : appCheckDebugToken;
}
if (!useEmulator && typeof window !== "undefined" && appCheckSiteKey && !globalThis.__FLU_APP_CHECK__) {
  globalThis.__FLU_APP_CHECK__ = true;
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaV3Provider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}
if (useEmulator && typeof window !== "undefined" && !globalThis.__FLU_EMU__) {
  globalThis.__FLU_EMU__ = true;
  const [functionsHost, functionsPort] = functionsEmulatorHost.replace(/^https?:\/\//, "").split(":");
  connectFunctionsEmulator(functions, functionsHost || "127.0.0.1", Number(functionsPort) || 5001);
  connectAuthEmulator(auth, authEmulatorHost.startsWith("http") ? authEmulatorHost : `http://${authEmulatorHost}`, { disableWarnings: true });
  if (independentMixmax) {
    const [host, port] = (process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8480").split(":");
    connectFirestoreEmulator(db, host, Number(port));
  }
}
