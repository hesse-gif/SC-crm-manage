const PROJECT = "demo-flu";
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FN = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";

async function idToken() {
  const res = await fetch(
    `http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test-admin@demo-flu",
        password: "test1234",
        returnSecureToken: true,
      }),
    },
  );
  const json = await res.json();
  if (!json.idToken) throw new Error(`signin failed: ${JSON.stringify(json)}`);
  return json.idToken;
}

let token = "";

async function callCallable(name, data = {}) {
  const res = await fetch(`http://${FN}/${PROJECT}/us-central1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  const payload = json.result ?? json.data;
  console.log(`[probe] ${name} HTTP ${res.status} ${JSON.stringify(payload?.counts ?? payload ?? json).slice(0, 700)}`);
  return payload;
}

token = await idToken();
await callCallable("deleteSeedData");
await callCallable("createSeedData");
const dataset = await callCallable("getDataset", { keys: ["campaigns"] });

console.log(JSON.stringify({
  loadedKeys: dataset.loadedKeys,
  campaignCount: dataset.campaigns?.length,
  campaignNames: dataset.campaigns?.map((campaign) => campaign.name),
  counts: dataset.counts,
}, null, 2));
