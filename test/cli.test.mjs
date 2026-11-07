// CLI end to end in a throwaway git repo, offline: Jev is switched off, so the heuristic runs and nothing is sent.
// Also: the Jev client with a fake fetch (retry, missing answer is an error, key never in output).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../skills/jev-review/scripts/cli.mjs", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "jev-review-home-"));
const repo = mkdtempSync(join(tmpdir(), "jev-review-repo-"));
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".state"), JEV_REVIEW_OFF: "1", TYPESAFE_API_KEY: "" };
delete env.CLAUDECODE;
const sh = (cmd, argv, cwd = repo) => execFileSync(cmd, argv, { cwd, env, encoding: "utf8" });
const cli = (...argv) => JSON.parse(sh("node", [CLI, ...argv, "--json"]));

sh("git", ["init", "-q", "-b", "main"]);
sh("git", ["config", "user.email", "t@example.invalid"]); sh("git", ["config", "user.name", "t"]);
writeFileSync(join(repo, "README.md"), "# demo\n");
sh("git", ["add", "."]); sh("git", ["commit", "-qm", "init"]);
mkdirSync(join(repo, "src/billing"), { recursive: true });
writeFileSync(join(repo, "src/billing/refund.js"), "export const refund = (amount) => { try { pay(amount) } catch {} }\n");
sh("git", ["add", "."]); sh("git", ["commit", "-qm", "feat: refunds\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"]);

test.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });

test("plan: money path → deep, author from trailer excluded, heuristic labelled", () => {
  const p = cli("plan", "HEAD~1..HEAD", "--host", "claude-code");
  assert.equal(p.judge, "heuristic");
  assert.match(p.why, /Jev switched off/);
  assert.equal(p.tier, "deep");
  assert.deepEqual(p.authors, ["opus"]);
  assert.deepEqual(p.reviewers, ["sonnet"]);
  assert.match(p.note, /second pass is skipped/);
  assert.match(p.how[0], /model: "sonnet"/);
});

test("plan: docs-only change → light", () => {
  writeFileSync(join(repo, "README.md"), "# demo\n\nmore words\n");
  sh("git", ["commit", "-qam", "docs: words"]);
  const p = cli("plan", "HEAD~1..HEAD", "--host", "claude-code", "--author", "human");
  assert.equal(p.tier, "light");
  assert.deepEqual(p.reviewers, ["sonnet"]);
});

test("plan: host without configured models says so", () => {
  const p = cli("plan", "HEAD~1..HEAD", "--host", "codex", "--author", "x");
  assert.equal(p.same_model, true);
  assert.match(p.note, /No reviewer models configured for codex/);
});

test("audit: money change → focused security, swallowed catch counts as a marker", () => {
  const r = cli("audit", "HEAD~2..HEAD~1");
  assert.equal(r.security, "focused");
  assert.equal(r.markers, 1);
  assert.ok(r.companions["security-audit"].startsWith("missing: npx skills add"));
});

test("fit: offline verdict lists what was read and sends nothing", () => {
  writeFileSync(join(repo, "AGENTS.md"), "Use Claude and Codex. Review every PR. Contact me@example.com\n");
  const f = cli("fit", "--host", "claude-code");
  assert.equal(f.step, "verdict");
  assert.equal(f.sent_chars, 0);
  assert.ok(f.read.files.some(x => x.path.endsWith("AGENTS.md")));
  assert.ok(["this will help", "partly", "not worth it"].includes(f.verdict));
});

test("doctor runs and reports the missing key as optional", () => {
  const d = JSON.parse(sh("node", [CLI, "doctor", "--json", "--host", "claude-code"]));
  assert.ok(d.checks.find(c => c.name === "TypeSafe key"));
});

test("jev client: retries 429, treats a missing answer as an error, never leaks the key", async () => {
  process.env.TYPESAFE_API_KEY = "test_key_0123456789abcdef";
  const L = await import("../skills/jev-review/scripts/lib.mjs");
  const cfg = { ...L.DEFAULTS };
  let calls = 0;
  const ok = async () => { calls++; return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "0.01" } }) : Response.json({ model: "jev-1.14.0", answers: { a: { noul: 0.81234 } } }); };
  const r = await L.jev({ x: 1 }, { a: { type: "noul", instructions: "?" } }, { cfg, fetchImpl: ok });
  assert.equal(calls, 2); assert.equal(r.signals.a, 0.812);
  const missing = async () => Response.json({ model: "m", answers: {} });
  await assert.rejects(L.jev({}, { a: { type: "noul", instructions: "?" } }, { cfg, fetchImpl: missing }), /missing/);
  const bad = async () => new Response("nope", { status: 401 });
  await assert.rejects(L.jev({}, { a: {} }, { cfg, fetchImpl: bad }), e => !e.message.includes("test_key_0123456789abcdef"));
  delete process.env.TYPESAFE_API_KEY;
});
