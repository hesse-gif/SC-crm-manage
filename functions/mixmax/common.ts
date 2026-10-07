import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";

export const PROJECT = "influencer-crm-296ca";
export const REGION = "asia-northeast3";
export const ownerEmail = defineString("MIXMAX_OWNER_EMAIL", { default: "" });
export const app = getApps().find(a => a.name === "mixmax") ?? initializeApp({}, "mixmax");
export const db = getFirestore(app, "mixmax");
db.settings({ ignoreUndefinedProperties: true });
export const callableOptions = { region: REGION, maxInstances: 5, minInstances: 0, timeoutSeconds: 120 } as const;
export interface Member { uid: string; email: string; workspaceId: string; role: "owner" | "member" }

export function assertTargetProject() {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || app.options.projectId;
  if (project !== PROJECT && !(project === "demo-mixmax" && process.env.FIRESTORE_EMULATOR_HOST)) {
    throw new HttpsError("failed-precondition", "Handle project configuration is invalid.");
  }
}
export function verifiedIdentity(request: CallableRequest): { uid: string; email: string } {
  assertTargetProject();
  if (!request.auth || request.auth.token.email_verified !== true || typeof request.auth.token.email !== "string") {
    throw new HttpsError("unauthenticated", "Google 계정으로 로그인해 주세요.");
  }
  return { uid: request.auth.uid, email: request.auth.token.email.toLowerCase() };
}
export async function requireMember(request: CallableRequest): Promise<Member> {
  const identity = verifiedIdentity(request);
  const member = (await db.doc(`mixmax_members/${identity.uid}`).get()).data();
  if (!member || member.disabled || member.email !== identity.email || typeof member.workspaceId !== "string") {
    throw new HttpsError("permission-denied", "이 Handle 워크스페이스에 접근할 수 없습니다.");
  }
  return { ...identity, workspaceId: member.workspaceId, role: member.role };
}
export function inputString(value: unknown, name: string, max = 1000, optional = false): string {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpsError("invalid-argument", `${name} 값을 확인해 주세요.`);
  return value.trim();
}
export function inputId(value: unknown, name = "id"): string {
  const result = inputString(value, name, 240);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new HttpsError("invalid-argument", `${name} 값이 올바르지 않습니다.`);
  return result;
}
export function assertResolvedTemplate(value: string) {
  if (/\{\{[^{}\r\n]{1,100}\}\}/.test(value)) throw new HttpsError("failed-precondition", "템플릿에 남아 있는 링크·변수 값을 채운 뒤 발송해 주세요.");
}
export async function ownedDocument(collection: string, id: string, member: Member) {
  const ref = db.collection(collection).doc(inputId(id));
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data || data.workspaceId !== member.workspaceId) throw new HttpsError("not-found", "항목을 찾을 수 없습니다.");
  return { ref, data };
}
