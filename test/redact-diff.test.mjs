// Fake secrets in a diff never reach the Jev request body or the heuristic input. All values here are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactDiff } from "../skills/review-router/scripts/rules.mjs";
import * as L from "../skills/review-router/scripts/lib.mjs";

const SECRETS = [
  "sk_live_FAKE1234567890abcdef", "FakeEnvValue42", "AKIAABCDEFGHIJKLMNOP", "FakePass123", "MIIEowIBAAKCAQEAfakefakefake",
  "correct horse battery", "FAKETOKENabc123456", "ghp_FAKEabcdefghijklmnopqrstuvwxyz1234", "Zx9fAKEhighENTROPYsecretVALUE1234567890ab",
  "xoxb-FAKE-1234567890-abcdef", "s3cr3t-client-value"
];
const DIFF = [
  "diff --git a/.env b/.env",
  "index 0000000..1111111 100644",
  "--- a/.env",
  "+++ b/.env",
  "@@ -0,0 +1,2 @@",
  "+STRIPE_SECRET=sk_live_FAKE1234567890abcdef",
  "+PLAIN_VALUE=FakeEnvValue42",
  "diff --git a/src/config.js b/src/config.js",
  "--- a/src/config.js",
  "+++ b/src/config.js",
  "@@ -1,3 +1,14 @@",
  ' const region = "eu-west-1"',
  '+const aws = "AKIAABCDEFGHIJKLMNOP"',
  '+const db = "postgres://admin:FakePass123@db.example.internal/app"',
  "+const pem = `",
  "+-----BEGIN RSA PRIVATE KEY-----",
  "+MIIEowIBAAKCAQEAfakefakefake",
  "+-----END RSA PRIVATE KEY-----`",
  '+password: "correct horse battery",',
  '+headers: { Authorization: "Bearer FAKETOKENabc123456" },',
  "+GITHUB_TOKEN=ghp_FAKEabcdefghijklmnopqrstuvwxyz1234",
  '+const k = "Zx9fAKEhighENTROPYsecretVALUE1234567890ab"',
  '+const slack = "xoxb-FAKE-1234567890-abcdef"',
  "+clientSecret: 's3cr3t-client-value',",
  "+const key = process.env.API_KEY",
  '+import x from "src/components/very/long/path/name/that/is/really/long.ts"',
  ""
].join("\n");

test("redactDiff keeps the line count and the diff structure", () => {
  const out = redactDiff(DIFF);
  assert.equal(out.split("\n").length, DIFF.split("\n").length);
  for (const keep of ["diff --git a/.env b/.env", "@@ -1,3 +1,14 @@", ' const region = "eu-west-1"', "+const key = process.env.API_KEY", "src/components/very/long/path/name/that/is/really/long.ts"])
    assert.ok(out.includes(keep), `kept: ${keep}`);
});

test("no fake secret reaches the heuristic input or the Jev request body", async () => {
  const d = L.shapeDiff(DIFF);
  for (const s of SECRETS) {
    assert.ok(!d.text.includes(s), `diff text leaks ${s}`);
    assert.ok(!d.added.some(l => l.includes(s)), `heuristic input leaks ${s}`);
  }
  process.env.TYPESAFE_API_KEY = "test_key_0123456789abcdef";
  let body = "";
  const capture = async (_u, o) => { body = o.body; return Response.json({ model: "m", answers: { q: { noul: 0.5 } } }); };
  await L.jev(L.changeState("feat: rotate key sk_live_FAKE1234567890abcdef", ["src/config.js"], d), { q: { type: "noul", instructions: "?" } }, { cfg: L.DEFAULTS, fetchImpl: capture });
  delete process.env.TYPESAFE_API_KEY;
  assert.ok(body.length > 0);
  for (const s of SECRETS) assert.ok(!body.includes(s), `request body leaks ${s}`);
  assert.ok(body.includes("process.env.API_KEY"), "env references are not secrets and stay readable");
});

test(".env.example values stay readable", () => {
  const out = redactDiff("diff --git a/.env.example b/.env.example\n+PORT=3000\n");
  assert.match(out, /PORT=3000/);
});
