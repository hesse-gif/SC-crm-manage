import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const PRIVATE_COLLECTIONS = [
  "mixmax_credentials",
  "mixmax_oauth_states",
  "mixmax_sync_jobs",
  "mixmax_sync_leases",
  "mixmax_import_backups",
  "mixmax_automation_budgets",
];

export function extractLiteralList(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  assert.ok(open > start && close > open, `${marker} must contain a literal list`);
  return [...source.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

export function verifyMixmaxRules({ rulesSource, firebaseSource }) {
  const firebaseConfig = JSON.parse(firebaseSource);
  assert.equal(firebaseConfig.firestore?.database, "mixmax", "Firestore deploy config must target the named mixmax database");
  assert.equal(firebaseConfig.firestore?.rules, "firestore.mixmax.rules", "Mixmax deploy config must use mixmax-only rules");

  assert.match(rulesSource, /match \/databases\/\{database\}\/documents/, "rules must be database-scoped");
  const scopeFunction = rulesSource.match(/function scope\(\) \{([^}]+)\}/)?.[1] ?? "";
  assert.match(scopeFunction, /resource\.data\.workspaceId\s*==/, "reads must compare resource workspace to member workspace");
  assert.match(scopeFunction, /mixmax_members\/\$\(request\.auth\.uid\)/, "workspace comparison must use the signed-in member document");
  assert.match(rulesSource, /allow write: if false;/, "clients must not write Mixmax runtime data directly");

  const sharedReadable = extractLiteralList(rulesSource, "collection in ['mixmax_threads'");
  const ownerReadable = extractLiteralList(rulesSource, "collection in ['mixmax_connections'");
  const readable = new Set([...sharedReadable, ...ownerReadable, "mixmax_drafts", "mixmax_members"]);

  assert.deepEqual(sharedReadable, [
    "mixmax_threads",
    "mixmax_messages",
    "mixmax_contacts",
    "mixmax_templates",
    "mixmax_cases",
    "mixmax_sequences",
  ]);
  assert.deepEqual(ownerReadable, ["mixmax_connections", "mixmax_sends", "mixmax_automation_runs"]);

  for (const collection of PRIVATE_COLLECTIONS) {
    assert.equal(readable.has(collection), false, `${collection} must stay server-only`);
    assert.doesNotMatch(rulesSource, new RegExp(`collection\\s*==\\s*['"]${collection}['"]`));
  }

  return { readableCollections: [...readable].sort(), privateCollections: PRIVATE_COLLECTIONS };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyMixmaxRules({
    rulesSource: readFileSync(resolve(root, "firestore.mixmax.rules"), "utf8"),
    firebaseSource: readFileSync(resolve(root, "firebase.mixmax.json"), "utf8"),
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
