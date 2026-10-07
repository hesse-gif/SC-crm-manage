import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { envSecret, liveIntegrationsEnabled } from "./liveIntegrations";
import { currentRuntimeEnvironment } from "./runtimeEnvironment";
import {
  getPeoplyClient,
  PeoplyClientError,
} from "./peoplyClient";
import { readMailOAuthConfiguration } from "./mailOAuth";
import { normalizeImapPublicConfiguration } from "./mailImapConfiguration";
import {
  MAIL_TRANSPORT_PROBE_STATUS_PATH,
  readMailTransportProbeStatus,
  type MailTransportProbeStatus,
} from "./mailTransportDiagnostics";
import {
  readMailProviderAttestationProjection,
  type MailProviderAttestationPublicProjection,
} from "./mailProviderAttestation";
import { resolveOperationalMailIdentity } from "./mailProfiles";

type IntegrationKey = "mailSmtp" | "mailImap" | "gateway" | "externalApi" | "aiHub";

type IntegrationDefinition = {
  key: IntegrationKey;
  label: string;
  secretFields: string[];
  publicFields: string[];
};

const INTEGRATIONS: IntegrationDefinition[] = [
  {
    key: "mailSmtp",
    label: "메일 SMTP",
    secretFields: ["password"],
    publicFields: ["host", "port", "secure", "username", "fromAddress", "warmupDailyLimit"],
  },
  {
    key: "mailImap",
    label: "메일 IMAP",
    secretFields: ["password"],
    publicFields: ["host", "port", "secure", "username", "mailbox", "bounceMailbox", "sentMailbox"],
  },
  {
    key: "gateway",
    label: "Gateway",
    secretFields: ["apiKey"],
    publicFields: ["endpoint", "model", "dailyBudgetKRW", "timeoutMs"],
  },
  {
    key: "externalApi",
    label: "외부 API",
    secretFields: ["youtubeApiKey", "reviApiKey", "emailFinderKey", "appsflyerOneLinkToken"],
    publicFields: [
      "youtubeProject",
      "quotaDaily",
      "youtubeAuthToolName",
      "youtubeAuthPolicyVersion",
      "youtubeAuthCallbackEnabled",
      "youtubeAuthMode",
      "emailFinderEndpoint",
      "reviEndpoint",
      "appsflyerOneLinkDomain",
      "appsflyerOneLinkTemplateId",
      "appsflyerApiMode",
    ],
  },
  {
    key: "aiHub",
    label: "AI Hub",
    secretFields: ["projectKey"],
    publicFields: ["projectId", "region", "cacheTtlMinutes", "endpoint"],
  },
];

const docRef = adminDb.collection("integrations").doc("default");

type RuntimeMode = "hosted_staging" | "production" | "emulator";

type CapabilityReadiness = {
  configured: boolean;
  ready: boolean;
  code: string | null;
};

function runtimeMode(): RuntimeMode {
  switch (currentRuntimeEnvironment.runtimeEnvironment) {
    case "staging": return "hosted_staging";
    case "emulator": return "emulator";
    case "production": return "production";
  }
}

function readPeoplyReadiness(): CapabilityReadiness {
  try {
    const client = getPeoplyClient();
    return client.configured
      ? { configured: true, ready: true, code: null }
      : { configured: false, ready: false, code: "missing_key" };
  } catch (error) {
    if (error instanceof PeoplyClientError && error.kind === "invalid_base_url") {
      return { configured: false, ready: false, code: "invalid_base_url" };
    }
    throw error;
  }
}

function readMailRoutingReadiness(): CapabilityReadiness {
  // Routing is a local Firestore/account-resolution capability. The presence or absence of a
  // configured account is returned by the account/status callables, so it must not make this
  // capability appear unavailable or tempt the UI to infer provider health from it.
  return { configured: true, ready: true, code: null };
}

export async function getIntegrations(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "integrations.read", ["super_admin", "admin", "manager", "viewer"]);
  const identity = await resolveOperationalMailIdentity();
  const [snapshot, mailTransportProbe, mailProviderAttestation] = await Promise.all([
    docRef.get(),
    readMailTransportProbeStatus(identity),
    readMailProviderAttestationProjection(identity),
  ]);
  const data = snapshot.exists ? asRecord(snapshot.data()) : {};
  const mailOAuth = readMailOAuthConfiguration();
  const mode = runtimeMode();

  return {
    ok: true,
    integrations: INTEGRATIONS.map((definition) => toPublicIntegration(
      definition,
      asRecord(data[definition.key]),
      mailTransportProbe,
      mailProviderAttestation,
    )),
    mailTransportProbe,
    mailProviderAttestation,
    mode: liveIntegrationsEnabled() ? "blaze_live" : "emulator_mock",
    runtimeMode: mode,
    capabilities: {
      peoply: readPeoplyReadiness(),
      mailOAuth: {
        configured: mailOAuth.configured,
        ready: mailOAuth.ready,
        code: mailOAuth.code,
        callbackUrl: mailOAuth.callbackUrl,
        appOrigin: mailOAuth.appOrigin,
        appOriginFromEnv: mailOAuth.appOriginFromEnv,
      },
      mailRouting: readMailRoutingReadiness(),
    },
    behaviorLog: makeBehaviorLog(auth, "integrations.read", "success", "global", 0),
  };
}

export async function updateIntegration(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "integrations.write", ["super_admin", "admin"]);
  const data = asRecord(request.data);
  const key = asString(data.key) as IntegrationKey;
  const definition = INTEGRATIONS.find((item) => item.key === key);
  if (!definition) throw Object.assign(new Error("Unknown integration key."), { code: "invalid-argument", errorCode: "update_integration_unknown_integration_key" });

  const values = asRecord(data.values);
  const snapshot = await docRef.get();
  const currentRoot = snapshot.exists ? asRecord(snapshot.data()) : {};
  const current = asRecord(currentRoot[definition.key]);
  const allowlistedCurrentPublic = allowlistedPublicValues(definition, asRecord(current.public));
  const currentPublic = definition.key === "mailImap"
    ? normalizeImapPublicConfiguration(allowlistedCurrentPublic)
    : allowlistedCurrentPublic;
  const currentSecrets = asRecord(current.secrets);
  const publicValues = Object.fromEntries(
    definition.publicFields
      .filter((field) => values[field] !== undefined)
      .map((field) => [field, normalizePublicValue(values[field])]),
  );
  const secretValues = Object.fromEntries(
    definition.secretFields
      .filter((field) => typeof values[field] === "string" && (values[field] as string).trim().length > 0)
      .map((field) => {
        const raw = (values[field] as string).trim();
        return [field, { masked: maskSecret(raw), fingerprint: fingerprint(raw), updatedAt: new Date().toISOString(), source: "write_only" }];
      }),
  );

  const mergedPublic = { ...currentPublic, ...publicValues };
  const nextPublic = definition.key === "mailImap"
    ? normalizeImapPublicConfiguration(mergedPublic)
    : mergedPublic;
  const nextSecrets = { ...currentSecrets, ...secretValues };
  const next = {
    label: definition.label,
    public: nextPublic,
    secrets: nextSecrets,
    configured: Object.keys(nextPublic).length > 0 || Object.keys(nextSecrets).length > 0,
    updatedBy: auth.userId,
    updatedAt: new Date().toISOString(),
  };

  if (definition.key === "mailSmtp" || definition.key === "mailImap") {
    const batch = adminDb.batch();
    batch.set(docRef, { [definition.key]: next }, { merge: true });
    batch.set(adminDb.doc(MAIL_TRANSPORT_PROBE_STATUS_PATH), {
      valid: false,
      invalidatedAtIso: new Date().toISOString(),
      invalidatedByHash: createHash("sha256").update(auth.userId).digest("hex").slice(0, 20),
    }, { merge: true });
    await batch.commit();
  } else {
    await docRef.set({ [definition.key]: next }, { merge: true });
  }

  return {
    ok: true,
    integration: toPublicIntegration(definition, next, null, null),
    behaviorLog: makeBehaviorLog(auth, `integrations.write(${definition.key})`, "success", "global", 0),
  };
}

function toPublicIntegration(
  definition: IntegrationDefinition,
  stored: Record<string, unknown>,
  mailTransportProbe: MailTransportProbeStatus | null,
  mailProviderAttestation: MailProviderAttestationPublicProjection | null,
) {
  const storedPublicValues = allowlistedPublicValues(definition, asRecord(stored.public));
  const publicValues = definition.key === "mailImap"
    ? normalizeImapPublicConfiguration(storedPublicValues)
    : storedPublicValues;
  const secrets = asRecord(stored.secrets);
  const configurationSaved = Object.keys(storedPublicValues).length > 0;
  const credentialConfigured = definition.secretFields.some((field) => (
    asString(asRecord(secrets[field]).fingerprint, "").length > 0
  ));
  const runtimeSecretBound = definition.secretFields.some((field) => (
    envSecret(envSecretName(definition.key, field)).length > 0
  ));
  const configured = stored.configured === true || configurationSaved || credentialConfigured;
  const probeLane = definition.key === "mailSmtp"
    ? mailTransportProbe?.smtp
    : definition.key === "mailImap"
      ? mailTransportProbe?.imap
      : undefined;
  const operationalReady = Boolean(
    mailTransportProbe?.valid
    && mailTransportProbe.operationalReady
    && mailProviderAttestation?.providerSubjectVerified
    && probeLane?.status === "ok"
    && runtimeSecretBound
    && liveIntegrationsEnabled(featureForIntegration(definition.key)),
  );
  return {
    key: definition.key,
    label: definition.label,
    configured,
    configurationSaved,
    credentialConfigured,
    runtimeSecretBound,
    operationalReady,
    liveReady: operationalReady,
    runtimeEnabled: liveIntegrationsEnabled(featureForIntegration(definition.key)),
    public: publicValues,
    secrets: Object.fromEntries(
      definition.secretFields.map((field) => [field, asString(asRecord(secrets[field]).masked, "미설정")]),
    ),
    requiredEnv: Object.fromEntries(definition.secretFields.map((field) => [field, envSecretName(definition.key, field)])),
    updatedAt: asString(stored.updatedAt, ""),
  };
}

function allowlistedPublicValues(
  definition: IntegrationDefinition,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    definition.publicFields
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );
}

function featureForIntegration(key: IntegrationKey) {
  const featureMap: Record<IntegrationKey, string> = {
    mailSmtp: "smtp",
    mailImap: "imap",
    gateway: "gateway",
    externalApi: "youtube",
    aiHub: "aihub",
  };
  return featureMap[key];
}

function normalizePublicValue(value: unknown) {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().slice(0, 180);
  return "";
}

function maskSecret(value: string) {
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function envSecretName(key: IntegrationKey, field: string) {
  const names: Record<IntegrationKey, Record<string, string>> = {
    mailSmtp: { password: "SMTP_PASSWORD" },
    mailImap: { password: "IMAP_PASSWORD" },
    gateway: { apiKey: "GATEWAY_API_KEY" },
    externalApi: { youtubeApiKey: "YOUTUBE_API_KEY", reviApiKey: "REVI_API_KEY", emailFinderKey: "EMAIL_FINDER_API_KEY", appsflyerOneLinkToken: "APPSFLYER_ONELINK_TOKEN" },
    aiHub: { projectKey: "AIHUB_PROJECT_KEY" },
  };
  return names[key][field] ?? field.toUpperCase();
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
