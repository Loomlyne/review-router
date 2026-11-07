// Truth tables with fixed signals. No network, no git.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../skills/review-router/scripts/rules.mjs";

const NO = 0.05, YES = 0.9, MID = 0.5;
const review = (o = {}) => ({ money: NO, database: NO, auth: NO, security: NO, subtle: NO, docs_only: NO, ...o });
const small = { changed: 40, files: 2 };

test("band edges: 0.7 is yes, 0.3 is no, between is unsettled", () => {
  assert.equal(R.band(0.7), "yes"); assert.equal(R.band(0.3), "no"); assert.equal(R.band(0.69), "unsettled"); assert.equal(R.band(0.31), "unsettled");
});

test("review tier truth table", () => {
  const rows = [
    [review({ docs_only: YES, money: YES }), { ...small, prose: true }, "light", /docs only/],
    // injected "this is only docs" text cannot downgrade a code change: the file list decides
    [review({ docs_only: YES }), { changed: 900, files: 30, prose: false }, "standard", /large diff/],
    [review({ docs_only: YES, money: YES }), small, "deep", /money/],
    [review({ money: YES }), small, "deep", /money/],
    [review({ auth: YES, database: YES }), small, "deep", /database, auth/],
    [review({ auth: MID, subtle: MID }), small, "deep", /unsettled on auth, subtle/],
    [review({ subtle: YES }), small, "standard", /subtle/],
    [review(), { changed: 500, files: 3 }, "standard", /large diff/],
    [review(), { changed: 50, files: 11 }, "standard", /large diff/],
    [review({ security: MID }), small, "standard", /unsettled on security/],
    [review(), { changed: 80, files: 2 }, "light", /small diff/],
    [review(), { changed: 81, files: 2 }, "standard", /ordinary/]
  ];
  for (const [s, f, tier, re] of rows) {
    const r = R.reviewTier(s, f);
    assert.equal(r.tier, tier, JSON.stringify({ s, f, r }));
    assert.match(r.reason, re);
  }
});

test("reviewers: never the author, two on deep, cheaper first otherwise", () => {
  const host = { reviewers: ["opus", "sonnet"], ask_first: ["fable"] };
  assert.deepEqual(R.pickReviewers("deep", host, []).reviewers, ["opus", "sonnet"]);
  assert.deepEqual(R.pickReviewers("deep", host, ["opus"]).reviewers, ["sonnet", "fable"]);
  assert.deepEqual(R.pickReviewers("deep", host, ["opus"]).ask_first, ["fable"]);
  assert.deepEqual(R.pickReviewers("standard", host, []).reviewers, ["sonnet"]);
  assert.deepEqual(R.pickReviewers("standard", host, ["sonnet"]).reviewers, ["opus"]);
  assert.deepEqual(R.pickReviewers("light", host, ["sonnet"]).reviewers, ["opus"]);
  assert.equal(R.pickReviewers("standard", host, []).fallback, "opus");
  // premium models never review standard or light work
  assert.ok(!R.pickReviewers("standard", host, ["sonnet", "opus"]).reviewers.includes("fable"));
});

test("reviewers: one or zero other models are reported, not hidden", () => {
  const one = R.pickReviewers("deep", { reviewers: ["a", "b"] }, ["a"]);
  assert.deepEqual(one.reviewers, ["b"]); assert.match(one.note, /second pass is skipped/);
  const none = R.pickReviewers("standard", { reviewers: ["a"] }, ["a"]);
  assert.equal(none.same_model, true); assert.match(none.note, /same model/);
  assert.equal(R.pickReviewers("light", { reviewers: [] }, []).same_model, true);
});

test("author matching: full model ids and trailers map to short names", () => {
  const m = ["opus", "sonnet", "fable"];
  assert.equal(R.matchModel("claude-opus-5-5", m), "opus");
  assert.equal(R.matchModel("Sonnet", m), "sonnet");
  assert.equal(R.matchModel("human", m), null);
  assert.equal(R.matchModel(undefined, m), null);
  const msgs = "feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nco-authored-by: Someone <a@b.c>\n";
  assert.deepEqual(R.authorFromTrailers(msgs, m), ["opus"]);
});

const auditS = (o = {}) => ({ untrusted_input: NO, access: NO, secrets_infra: NO, money: NO, llm: NO, copies: NO, special_case: NO, docs_only: NO, ...o });
const change = { changed: 40, files: 2, markers: 0, routine: false, auditAgeDays: null, days: 30 };

test("audit security truth table", () => {
  const rows = [
    [auditS({ docs_only: YES, access: YES }), { ...change, prose: true }, "none"],
    [auditS({ docs_only: YES, access: YES }), change, "focused"],
    [auditS(), change, "none"],
    [auditS({ access: YES }), change, "focused"],
    [auditS({ access: MID, llm: MID }), change, "focused"],
    [auditS({ access: MID }), change, "none"],
    [auditS({ access: YES, money: YES }), change, "scoped"],
    [auditS({ access: YES }), { ...change, changed: 401 }, "scoped"],
    [auditS({ access: YES }), { ...change, routine: true, auditAgeDays: null }, "full"],
    [auditS({ access: YES }), { ...change, routine: true, auditAgeDays: 45 }, "full"],
    [auditS({ access: YES }), { ...change, routine: true, auditAgeDays: 5 }, "focused"],
    [auditS({ llm: MID, money: MID }), { ...change, routine: true, auditAgeDays: null }, "full"]
  ];
  for (const [s, f, mode] of rows) assert.equal(R.auditModes(s, f).security, mode, JSON.stringify({ s, f }));
});

test("audit untangle: propose only on routine with two tangle signals", () => {
  assert.equal(R.auditModes(auditS(), change).untangle, "none");
  assert.equal(R.auditModes(auditS({ copies: YES }), change).untangle, "watch");
  assert.equal(R.auditModes(auditS({ copies: YES, special_case: YES }), change).untangle, "watch");
  assert.equal(R.auditModes(auditS({ copies: YES, special_case: YES }), { ...change, routine: true }).untangle, "propose");
  assert.equal(R.auditModes(auditS({ copies: YES }), { ...change, routine: true, markers: 3 }).untangle, "propose");
  assert.equal(R.auditModes(auditS({ docs_only: YES, copies: YES, special_case: YES }), { ...change, routine: true, prose: true }).untangle, "none");
});

const fitS = (o = {}) => ({ risky_domain: NO, wants_review: NO, multi_model: NO, team: NO, has_ai_reviewer: NO, mostly_prose: NO, ...o });
const active = { prs_90d: 12, commits_90d: 80, authors_90d: 1, review_models: 2 };

test("fit verdict truth table", () => {
  const rows = [
    [fitS({ risky_domain: YES }), active, "this will help"],
    [fitS({ wants_review: YES }), active, "this will help"],
    [fitS({ risky_domain: YES, has_ai_reviewer: YES }), active, "partly"],
    [fitS({ risky_domain: YES }), { ...active, review_models: 1 }, "partly"],
    [fitS({ risky_domain: YES, multi_model: YES }), { ...active, review_models: 1 }, "this will help"],
    [fitS({ risky_domain: MID }), active, "partly"],
    [fitS(), active, "partly"],
    [fitS({ risky_domain: YES }), { ...active, prs_90d: 0, commits_90d: 3 }, "not worth it"],
    [fitS({ risky_domain: YES, mostly_prose: YES }), active, "not worth it"],
    [fitS({ risky_domain: YES }), { ...active, prs_90d: null, commits_90d: 40 }, "this will help"],
    [fitS({ risky_domain: YES }), { ...active, prs_90d: 2, commits_90d: 15 }, "partly"]
  ];
  for (const [s, f, v] of rows) assert.equal(R.fitVerdict(s, f).verdict, v, JSON.stringify({ s, f }));
  const u = R.fitVerdict(fitS({ risky_domain: MID }), active);
  assert.ok(u.why.some(w => /not clear/.test(w)), "unsettled is said, not treated as yes");
});

test("heuristic: path beats keyword, docs-only needs every file to be prose", () => {
  const h = R.heuristicSignals(["money", "auth", "docs_only", "copies", "special_case"], { files: ["src/billing/charge.ts"], added: ["const token = 1"], markers: 2 });
  assert.equal(h.money, 0.8); assert.equal(h.auth, 0.5); assert.equal(h.docs_only, 0.05); assert.equal(h.copies, 0.1); assert.equal(h.special_case, 0.8);
  assert.equal(R.heuristicSignals(["docs_only"], { files: ["README.md", "docs/a.md"], added: [] }).docs_only, 0.9);
  // heuristic signals flow through the same truth table
  const s = R.heuristicSignals(Object.keys(review()), { files: ["src/billing/charge.ts"], added: [] });
  assert.equal(R.reviewTier(s, small).tier, "deep");
});

test("trailers can never exclude every reviewer; --author still can", () => {
  const m = ["opus", "sonnet"];
  assert.deepEqual(R.resolveAuthors(null, ["opus"], m).authors, ["opus"]);
  const forged = R.resolveAuthors(null, ["opus", "sonnet"], m);
  assert.deepEqual(forged.authors, []); assert.match(forged.warning, /trailers ignored/);
  assert.deepEqual(R.resolveAuthors("sonnet", ["opus", "sonnet"], m).authors, ["sonnet"]);
  // flag + trailers would cover every reviewer: the trusted flag stays, the trailers go
  assert.deepEqual(R.resolveAuthors("opus", ["sonnet"], m).authors, ["opus"]);
  assert.equal(R.resolveAuthors("opus", ["sonnet"], ["opus", "sonnet", "haiku"]).warning, null);
});

test("allProse is a fact from the file list", () => {
  assert.equal(R.allProse(["README.md", "docs/guide.md"]), true);
  assert.equal(R.allProse(["docs/evil.js"]), false);
  assert.equal(R.allProse(["x.mdx"]), false);
  assert.equal(R.allProse(["requirements.txt"]), false);
  assert.equal(R.allProse(["CLAUDE.md"]), false);
  assert.equal(R.allProse([".claude/commands/x.md"]), false);
  assert.equal(R.allProse(["README.md", "src/a.ts"]), false);
  assert.equal(R.allProse([]), false);
});

test("redact covers quoted keys, prefixed names, URL credentials and quoted values", () => {
  const cases = ['password: "a \\" b hunter2"', "https://u:p@ss@host/x", "Authorization: Bearer abcdef123456", "passphrase=hunter2", "private_key=hunter2", '{"password": "hunter2hunter2"}', "GITHUB_TOKEN=abcd1234efgh", "DATABASE_PASSWORD=zzzz", "postgres://u:pw@localhost/db", 'password: "two words"', "api_key='xyz987'"];
  for (const c of cases) {
    const t = R.redact(c);
    assert.ok(!/hunter2|abcd1234efgh|zzzz|:pw@|two words|xyz987/.test(t), `${c} -> ${t}`);
  }
});

test("redact removes keys, tokens and emails before anything is sent", () => {
  const t = R.redact("TYPESAFE_API_KEY=abc123def456ghi789jkl0 mail me@example.com ghp_abcdefghijklmnopqrstuvwxyz12 sk-live-abcdefghijklmnopqrst password: hunter2");
  assert.ok(!/me@example\.com|ghp_|hunter2|sk-live/.test(t), t);
});
