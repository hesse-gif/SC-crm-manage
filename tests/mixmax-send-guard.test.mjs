import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const gmailCoreUrl = new URL("../.mixmax-functions/lib/gmail-core.js", import.meta.url);

assert.ok(
  existsSync(gmailCoreUrl),
  "Mixmax send guard tests require a fresh build: node scripts/build-mixmax-functions.mjs",
);

const require = createRequire(import.meta.url);
const { encodeSimpleRawEmail } = require("../.mixmax-functions/lib/gmail-core.js");

test("automatic raw Gmail messages include auto-reply suppression headers", () => {
  const raw = encodeSimpleRawEmail({
    from: "me@example.com",
    to: ["creator@example.com"],
    subject: "Partnership",
    text: "Thanks for reaching out.",
    automatic: true,
  });

  assert.match(raw, /\r\nAuto-Submitted: auto-replied\r\n/);
  assert.match(raw, /\r\nX-Auto-Response-Suppress: All\r\n/);
});

test("manual raw Gmail messages do not include auto-reply suppression headers", () => {
  const raw = encodeSimpleRawEmail({
    from: "me@example.com",
    to: ["creator@example.com"],
    subject: "Partnership",
    text: "Thanks for reaching out.",
  });

  assert.doesNotMatch(raw, /Auto-Submitted:/);
  assert.doesNotMatch(raw, /X-Auto-Response-Suppress:/);
});
