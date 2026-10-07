import { expect, type Page } from "@playwright/test";

const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "demo-flu";
const firestoreHost = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").replace(/^https?:\/\//, "");
const databaseBase = `http://${firestoreHost}/v1/projects/${project}/databases/(default)`;
const firestoreBase = `${databaseBase}/documents`;

type FirestoreValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

type FirestoreDoc = {
  name: string;
  fields?: Record<string, FirestoreValue>;
};

export function fieldValue(value: FirestoreValue | undefined): unknown {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue?.values ?? []).map(fieldValue);
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue?.fields ?? {}).map(([key, item]) => [key, fieldValue(item)]),
    );
  }
  return undefined;
}

export async function readCollection(name: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let pageToken = "";
  do {
    const url = new URL(`${firestoreBase}/${name}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers: { Authorization: "Bearer owner" } });
    if (!response.ok) throw new Error(`Failed to read ${name}: ${response.status} ${await response.text()}`);
    const json = await response.json() as { documents?: FirestoreDoc[]; nextPageToken?: string };
    rows.push(...(json.documents ?? []).map((doc) => ({
      id: doc.name.split("/").pop(),
      ...Object.fromEntries(Object.entries(doc.fields ?? {}).map(([key, item]) => [key, fieldValue(item)])),
    })));
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return rows;
}

function toFirestoreValue(value: unknown): FirestoreValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value && typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
            .map(([key, item]) => [key, toFirestoreValue(item)]),
        ),
      },
    };
  }
  return { nullValue: null };
}

/** 에뮬레이터 Firestore 에 문서 하나를 쓴다(REST commit, owner 토큰). 스펙마다 복제되던 헬퍼의 공용본. */
export async function commitDocument(path: string, record: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${databaseBase}/documents:commit`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({
      writes: [{
        update: {
          name: `projects/${project}/databases/(default)/documents/${path}`,
          fields: Object.fromEntries(
            Object.entries(record)
              .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
              .map(([key, value]) => [key, toFirestoreValue(value)]),
          ),
        },
      }],
    }),
  });
  if (!response.ok) throw new Error(`Failed to seed ${path}: ${response.status} ${await response.text()}`);
}

export async function deleteDocument(name: string, id: string): Promise<void> {
  const response = await fetch(`${firestoreBase}/${name}/${id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer owner" },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete ${name}/${id}: ${response.status} ${await response.text()}`);
  }
}

/**
 * Flu/Task-61: 모든 e2e가 test-admin@demo-flu(super_admin) 하나로만 로그인했던 근본 원인을
 * 고친다 — src/app/login/page.tsx가 이제 ?testAccount= 를 읽어 src/lib/auth.ts
 * signInWithGoogleOrEmulator(emulatorTestAccountId)로 넘긴다(에뮬레이터 전용, production 경로엔
 * 영향 없음). scripts/seed-emulator.mjs가 Firebase Auth 에뮬레이터에 만드는 계정과 정확히 같은
 * testAccountId 키를 써야 한다.
 */
async function loginAsTestAccount(page: Page, next: string, testAccountId: string) {
  const params = new URLSearchParams({ next, testAccount: testAccountId });
  await page.goto(`/login?${params.toString()}`);
  await page.getByRole("button", { name: /Google로 로그인/ }).click();
  // Tolerate ChunkErrorReloader's (src/components/shell/ChunkErrorReloader.tsx) documented
  // one-time self-heal reload — under heavy system load a dynamic-import chunk fetch can
  // genuinely fail, and the app correctly recovers via location.replace(url + "?_cb=<ts>") (or
  // "&_cb=<ts>" — ChunkErrorReloader uses URL.searchParams.set, so a destination that already has
  // query params gets "&_cb=", never a second "?") on the SAME intended destination, permanently
  // leaving that harmless cache-buster param in the URL. Without this, every login on a loaded
  // machine could spuriously fail here even though the app landed on exactly the right page —
  // Codex review 2026-09-28 round 2: the first version only matched "?_cb=", so this still broke
  // for every destination already carrying a query string (e.g. "/flu/scp?tab=review",
  // "/chat?conversationId=..."). "[?&]_cb=\d+" accepts either separator while the escaped `next`
  // prefix still pins the exact destination path/params otherwise.
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[?&]_cb=\\d+)?$`), { timeout: 20_000 });
}

export async function loginAsAdmin(page: Page, next: string) {
  await loginAsTestAccount(page, next, "admin");
}

/** Growth 조직으로 해석되는 manager 계정 — 조직 탭 프리셋 매핑이 없어 현행(opt-in 제외) 탭 전체가 보인다. */
export async function loginAsGrowthManager(page: Page, next: string) {
  await loginAsTestAccount(page, next, "growth-manager");
}

/** AI Drama 조직으로 해석되는 manager 계정 — org_tab_presets 5탭 프리셋 + 개인 메일함 기본 뷰. */
export async function loginAsDramaManager(page: Page, next: string) {
  await loginAsTestAccount(page, next, "drama-manager");
}

/** Peoply 픽스처에 없는 이메일 — actorOrgId가 항상 null인 미매핑 viewer 계정. */
export async function loginAsUnmappedViewer(page: Page, next: string) {
  await loginAsTestAccount(page, next, "unmapped-viewer");
}
