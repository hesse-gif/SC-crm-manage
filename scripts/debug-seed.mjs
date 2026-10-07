// 에뮬레이터에서 createSeedData/deleteSeedData를 super_admin 토큰으로 직접 호출해 실제 에러를 본다.
// 실행: firebase emulators:exec --project demo-flu "node scripts/seed-emulator.mjs && node scripts/debug-seed.mjs"
const PROJECT = "demo-flu";
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FN = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";

async function idToken() {
  const res = await fetch(
    `http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "test-admin@demo-flu", password: "test1234", returnSecureToken: true }) },
  );
  const json = await res.json();
  if (!json.idToken) throw new Error(`signin failed: ${JSON.stringify(json)}`);
  return json.idToken;
}

async function callCallable(name, token, data = {}) {
  const res = await fetch(`http://${FN}/${PROJECT}/us-central1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function fsCount(collection) {
  const r = await fetch(`http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents/${collection}?pageSize=300`, { headers: { Authorization: "Bearer owner" } });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.documents) ? j.documents.length : 0;
}

const token = await idToken();
console.log("[debug] got idToken");
const before = await fsCount("creators");
console.log(`[debug] creators BEFORE upsert: ${before}`);
const calls = [
  ["recommendCreators", { limit: 5, gameId: "flu-casual" }],
  ["upsertCreator", { id: "UC_test_channel_001", name: "Test YT Channel", handle: "@testyt", type: "influencer", platform: "YouTube", followers: 123000, region: "US", category: "Gaming", stage: "contact", owner: "헤세" }],
];
for (const [name, data] of calls) {
  const r = await callCallable(name, token, data);
  console.log(`\n[debug] ${name} → HTTP ${r.status}\n${r.body.slice(0, 700)}`);
}
const after = await fsCount("creators");
console.log(`\n[debug] creators AFTER upsert: ${after} (delta ${after - before})`);
process.exit(0);
