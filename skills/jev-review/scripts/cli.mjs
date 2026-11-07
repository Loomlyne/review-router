#!/usr/bin/env node
// jev-review: risk-ranked PR review on your own agent subscription.
//   doctor                         check node, git, gh, host, TypeSafe key, companion skills
//   key store|check|where          keep the TypeSafe key in the OS keychain (read from stdin or a hidden prompt)
//   fit [--send|--offline]         is this worth it for you? reads your agent notes and repo history locally
//   plan <pr | base..head>         tier + reviewer models (never the author's), second pass on deep risk
//   audit <pr | base..head> | --routine [--days 30]   security-audit mode + untangle-codebase proposal
//   config init|show               write or print the config file
// Common flags: --host <claude-code|codex|opencode|grok|generic>  --author <model>  --json
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./lib.mjs";
import * as R from "./rules.mjs";
import { REVIEW, AUDIT, FIT } from "./questions.mjs";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(SKILL_DIR, "scripts", "cli.mjs");
const a = L.args(process.argv.slice(2), ["json", "send", "offline", "routine", "show-payload", "from-clipboard"]);
const [cmd, sub] = a._;
const print = (obj, text) => console.log(a.json || !text ? JSON.stringify(obj, null, a.json ? 2 : 0) : text);

// Ask Jev when a key is there and Jev is on; otherwise the documented heuristic. A failed call is an error, never an answer.
async function judge(cfg, state, questions, heuristic) {
  if (L.jevOff(cfg)) return { judge: "heuristic", why: "Jev switched off (JEV_REVIEW_OFF=1 or config jev:false)", signals: heuristic() };
  if (!L.findKey(cfg).key) return { judge: "heuristic", why: "no TypeSafe key: code-only heuristic, not Jev", signals: heuristic() };
  const r = await L.jev(state, questions, { cfg });
  return { judge: "jev", jev_model: r.model, usage: r.usage, signals: r.signals };
}

const COMPANIONS = {
  "security-audit": "npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit",
  "untangle-codebase": "npx skills add caldoai/skills --skill untangle-codebase"
};
const SKILL_ROOTS = () => [".claude/skills", ".agents/skills", ".opencode/skills", ".grok/skills"].flatMap(d => [join(process.cwd(), d), join(homedir(), d)]).concat(join(homedir(), ".config/opencode/skills"));
const findSkill = name => SKILL_ROOTS().map(r => join(r, name, "SKILL.md")).find(existsSync) ?? null;

// ---------------- plan ----------------
async function plan() {
  const target = a._[1];
  if (!target) throw usage("plan <pr-number | base..head> [--author <model>] [--host <host>]");
  const cfg = L.loadConfig();
  const { host, how: hostHow } = L.detectHost(a.host);
  const hcfg = cfg.hosts[host] ?? cfg.hosts.generic;
  const ch = L.loadChange(target);
  const d = L.shapeDiff(ch.diff);
  const all = [...hcfg.reviewers, ...(hcfg.ask_first ?? [])];
  const authors = [...new Set([R.matchModel(a.author, all), ...R.authorFromTrailers(ch.messages, all)].filter(Boolean))];
  const facts = { changed: d.changed, files: ch.files.length };
  const out = { target, title: ch.title, host, host_detected_by: hostHow, author_flag: a.author ?? null, authors, ...facts, truncated: d.cut };
  try {
    const j = await judge(cfg, { title: ch.title, files: ch.files, diff: d.text, ...(d.cut && { note: `diff truncated to the first ${d.max} characters; every changed file is listed in files` }) },
      REVIEW, () => R.heuristicSignals(Object.keys(REVIEW), { files: ch.files, added: d.added }));
    Object.assign(out, j, R.reviewTier(j.signals, facts, cfg.bands));
  } catch (e) {
    Object.assign(out, { judge: "error", error: e.message, tier: "deep", reason: "Jev call failed: deep review by default" });
    process.exitCode = 1;
  }
  const pick = R.pickReviewers(out.tier, hcfg, authors);
  Object.assign(out, pick, { how: pick.reviewers.map(m => hcfg.how.replace(/\{model\}/g, m)), prompt: join(SKILL_DIR, "references", "review-prompt.md") });
  if (!hcfg.reviewers.length) out.note = `No reviewer models configured for ${host}: add them strongest-first to hosts.${host}.reviewers in ${L.CONFIG_PATH} (run: node ${CLI} config init).`;
  if (!a.author && !authors.length) out.warning = "author model unknown: pass --author so the author never reviews its own change";
  L.log(cfg, "plan", { ...out, title: undefined });
  print(out);
}

// ---------------- audit ----------------
async function audit() {
  const routine = !!a.routine, days = Number(a.days) || 30, target = a._[1];
  if (!routine && !target) throw usage("audit <pr-number | base..head> | --routine [--days 30]");
  const cfg = L.loadConfig();
  const repo = basename(L.git(["rev-parse", "--show-toplevel"]));
  const auditDir = join(homedir(), "security-audit-skill", repo); // security-audit's default output folder
  const runs = existsSync(auditDir) ? readdirSync(auditDir).filter(x => x.startsWith("run-")).map(x => statSync(join(auditDir, x)).mtimeMs) : [];
  const last = runs.length ? Math.max(...runs) : 0;
  const auditAgeDays = last ? Math.floor((Date.now() - last) / 864e5) : null;
  let ch;
  if (routine) {
    const since = last ? new Date(last).toISOString() : `${days} days ago`;
    const base = L.tryRun("git", ["rev-list", "-1", `--before=${since}`, "HEAD"])?.trim() || L.git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0];
    ch = { diff: L.git(["diff", `${base}..HEAD`]), files: L.git(["diff", "--name-only", `${base}..HEAD`]).split("\n").filter(Boolean), title: `${repo}: changes since ${last ? "last full audit" : `${days} days ago`}` };
  } else ch = L.loadChange(target);
  const d = L.shapeDiff(ch.diff, routine ? { max: 40000, perFile: 1200 } : {});
  const MARKERS = /setTimeout\(|sleep\(|catch\s*(\(\w*\))?\s*\{\s*\}|\.skip\(|\bxit\(|@ts-ignore|eslint-disable|retry/i;
  const markers = d.added.filter(l => MARKERS.test(l)).length;
  const facts = { changed: d.changed, files: ch.files.length, markers, routine, auditAgeDays, days };
  const out = { repo, mode: routine ? "routine" : "change", target: target ?? null, ...facts, truncated: d.cut };
  if (!ch.files.length) Object.assign(out, { judge: "none", security: "none", untangle: "none", reason: "no changes" });
  else {
    try {
      const j = await judge(cfg, { title: ch.title, files: ch.files, diff: d.text, ...(d.cut && { note: `diff truncated to the first ${d.max} characters; every changed file is listed in files` }) },
        AUDIT, () => R.heuristicSignals(Object.keys(AUDIT), { files: ch.files, added: d.added, markers }));
      Object.assign(out, j, R.auditModes(j.signals, facts, cfg.bands));
    } catch (e) {
      // Fail toward caution for security (a focused review), never toward a refactor.
      Object.assign(out, { judge: "error", error: e.message, security: "focused", security_reason: "Jev call failed: focused review by default", untangle: "none" });
      process.exitCode = 1;
    }
  }
  const SEC_HOW = {
    none: null,
    focused: "Load the security-audit skill in guidance mode and review only this diff's trust boundaries.",
    scoped: "Run security-audit's workflow scoped to the changed files (quick pass, no report artifacts unless asked).",
    full: "Propose a full security-audit run to the user. Do not start it without their yes."
  };
  out.security_how = SEC_HOW[out.security] ?? null;
  out.untangle_how = out.untangle === "propose" ? "Propose /untangle-codebase to the user as its own branch and PR. Never start it unasked." : out.untangle === "watch" ? "Mention the tangle signal in the review; no refactor." : null;
  out.companions = Object.fromEntries(Object.entries(COMPANIONS).map(([n, cmd]) => [n, findSkill(n) ? "installed" : `missing: ${cmd}`]));
  L.log(cfg, "audit", out);
  print(out);
}

// ---------------- fit ----------------
function readNotes() {
  const cwd = process.cwd(), h = homedir();
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const candidates = [
    [join(h, ".claude/CLAUDE.md"), "Claude Code, user"], [join(cwd, "CLAUDE.md"), "Claude Code, project"], [join(cwd, ".claude/CLAUDE.md"), "Claude Code, project"],
    [join(h, ".claude/projects", slug, "memory/MEMORY.md"), "Claude Code memory index"],
    [join(h, ".codex/AGENTS.md"), "Codex, user"], [join(cwd, "AGENTS.md"), "AGENTS.md, project"],
    [join(h, ".config/opencode/AGENTS.md"), "OpenCode, user"], [join(h, ".grok/AGENTS.md"), "Grok, user"]
  ];
  // *.local.md files hold machine-only facts (hosts, databases): listed, never sent.
  const read = [join(cwd, "CLAUDE.local.md")].filter(existsSync).map(p => ({ path: p.replace(h, "~"), label: "local-only, skipped", bytes: statSync(p).size, sent_chars: 0 })), parts = [];
  let budget = 24000;
  for (const [p, label] of candidates) {
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const raw = readFileSync(p, "utf8");
    const take = Math.min(raw.length, 6000, budget);
    budget -= take;
    read.push({ path: p.replace(h, "~"), label, bytes: raw.length, sent_chars: take });
    if (take > 0) parts.push(`## ${label}\n${R.redact(raw.slice(0, take))}`);
  }
  return { read, text: parts.join("\n\n") };
}

function repoFacts(cfg, host) {
  const inRepo = L.tryRun("git", ["rev-parse", "--show-toplevel"]) !== null;
  if (!inRepo) return { inRepo, commits_90d: 0, authors_90d: 0, prs_90d: null, titles: [], sensitive: [], sample: [], ci: "" };
  const commits_90d = Number(L.tryRun("git", ["rev-list", "--count", "--since=90.days", "HEAD"])?.trim() || 0);
  const authors_90d = (L.tryRun("git", ["shortlog", "-sne", "--since=90.days", "HEAD"]) ?? "").split("\n").filter(Boolean).length;
  let prs_90d = null, titles = [];
  if (L.has("gh")) {
    const raw = L.tryRun("gh", ["pr", "list", "--state", "all", "--limit", "100", "--json", "title,createdAt"]);
    if (raw) {
      const prs = JSON.parse(raw), cut = Date.now() - 90 * 864e5;
      prs_90d = prs.filter(p => Date.parse(p.createdAt) >= cut).length;
      titles = prs.slice(0, 20).map(p => R.redact(p.title));
    }
  }
  if (!titles.length) titles = (L.tryRun("git", ["log", "-20", "--format=%s"]) ?? "").split("\n").filter(Boolean).map(R.redact);
  const files = (L.tryRun("git", ["ls-files"]) ?? "").split("\n").filter(Boolean);
  const SENS = /(pay|billing|invoice|checkout|stripe|refund|payout|auth|login|session|oauth|permission|migrations?\/|schema|\.sql$|prisma|drizzle|supabase)/i;
  const sensitive = files.filter(f => SENS.test(f)).slice(0, 40);
  const step = Math.max(1, Math.floor(files.length / 60));
  const sample = files.filter((_, i) => i % step === 0).slice(0, 60);
  const wf = join(process.cwd(), ".github/workflows");
  const ci = existsSync(wf) ? readdirSync(wf).map(f => `${f}: ${(readFileSync(join(wf, f), "utf8").match(/^\s*-?\s*uses:\s*\S+/gm) ?? []).map(s => s.trim()).join(", ")}`).join("\n") : "";
  return { inRepo, commits_90d, authors_90d, prs_90d, titles, sensitive, sample, ci, review_models: (cfg.hosts[host] ?? cfg.hosts.generic).reviewers.length };
}

async function fit() {
  const cfg = L.loadConfig();
  const { host } = L.detectHost(a.host);
  const notes = readNotes();
  const f = repoFacts(cfg, host);
  const clis = ["claude", "codex", "opencode", "grok"].filter(L.has);
  const state = { agent_instructions: notes.text || "(no agent instruction files found)", repo: { recent_titles: f.titles, sensitive_paths: f.sensitive, sample_paths: f.sample, ci_workflows: f.ci || "(none)" } };
  const payloadChars = JSON.stringify(state).length;
  const read = {
    files: notes.read,
    git: f.inRepo ? `git log (90 days): ${f.commits_90d} commits, ${f.authors_90d} authors; git ls-files (${f.sensitive.length} sensitive paths, ${f.sample.length} sample paths)` : "not a git repo",
    github: f.prs_90d === null ? "gh unavailable or not a GitHub repo" : `gh pr list: ${f.prs_90d} PRs in 90 days`,
    ci: f.ci ? ".github/workflows `uses:` lines" : "none",
    clis
  };
  const keyed = !!L.findKey(cfg).key && !L.jevOff(cfg);
  if (keyed && !a.send && !a.offline) {
    const out = { step: "consent", read, would_send: { to: "api.typesafe.ai (Jev)", chars: payloadChars, questions: Object.keys(FIT), redacted: "emails, tokens and key-like strings are replaced before sending" },
      next: [`node ${CLI} fit --send          # ask Jev the ${Object.keys(FIT).length} questions`, `node ${CLI} fit --offline       # code-only heuristic, sends nothing`, `node ${CLI} fit --show-payload  # print exactly what would be sent`] };
    if (a["show-payload"]) out.payload = state;
    return print(out, fitText(out));
  }
  let j;
  try {
    j = a.offline || !keyed
      ? { judge: "heuristic", why: keyed ? "--offline: nothing sent" : "no TypeSafe key: code-only heuristic, not Jev", signals: R.heuristicFit({ instructions: notes.text, sensitivePaths: f.sensitive, titles: f.titles, ci: f.ci, samplePaths: f.sample }) }
      : await judge(cfg, state, FIT, null);
  } catch (e) { process.exitCode = 1; return print({ step: "error", error: e.message, read }, `Fit check failed: ${e.message}. Nothing was decided.`); }
  const facts = { prs_90d: f.prs_90d, commits_90d: f.commits_90d, authors_90d: f.authors_90d, review_models: f.review_models };
  const v = R.fitVerdict(j.signals, facts, cfg.bands);
  const out = { step: "verdict", host, ...v, judge: j.judge, ...(j.why && { judge_note: j.why }), ...(j.jev_model && { jev_model: j.jev_model }), signals: j.signals, facts, read, sent_chars: j.judge === "jev" ? payloadChars : 0 };
  L.log(cfg, "fit", { verdict: v.verdict, judge: j.judge, signals: j.signals, facts });
  print(out, fitText(out));
}

function fitText(o) {
  const lines = ["What was read (locally, read-only):"];
  for (const r of o.read.files) lines.push(`  ${r.path}  (${r.label}, ${r.bytes} bytes, ${r.sent_chars} chars eligible to send)`);
  if (!o.read.files.length) lines.push("  no agent instruction files found");
  lines.push(`  ${o.read.git}`, `  ${o.read.github}`, `  CI: ${o.read.ci}`, `  agent CLIs on PATH: ${o.read.clis.join(", ") || "none"}`);
  if (o.step === "consent") {
    lines.push("", `Nothing sent yet. With --send, ${o.would_send.chars} characters (redacted) go to ${o.would_send.to} for ${o.would_send.questions.length} yes/no judgments:`, `  ${o.would_send.questions.join(", ")}`, "", ...o.next);
    if (o.payload) lines.push("", JSON.stringify(o.payload, null, 2));
    return lines.join("\n");
  }
  const src = o.judge === "jev" ? `Jev ${o.jev_model} judged, code decided; ${o.sent_chars} chars sent` : `${o.judge_note}`;
  lines.push("", `Verdict: ${o.verdict.toUpperCase()}`, ...o.why.map(w => `  - ${w}`), "", o.judge === "jev" ? `Judgments (${src}):` : `Heuristic scores, not probabilities (${src}):`);
  for (const [k, p] of Object.entries(o.signals)) lines.push(`  ${k.padEnd(16)} ${p.toFixed(3)}  ${R.band(p)}`);
  return lines.join("\n");
}

// ---------------- key ----------------
async function readSecret() {
  if (a["from-clipboard"]) {
    const v = L.tryRun("pbpaste", [])?.trim();
    if (!v) throw new Error("clipboard is empty (or pbpaste is unavailable: macOS only)");
    L.tryRun("pbcopy", [], { input: "", stdio: ["pipe", "ignore", "ignore"] });
    return v;
  }
  if (!process.stdin.isTTY) return readFileSync(0, "utf8").trim();
  process.stderr.write("Paste your TypeSafe API key (input hidden), then Enter: ");
  process.stdin.setRawMode(true);
  return new Promise(res => {
    let s = "";
    process.stdin.on("data", b => {
      for (const c of b.toString("utf8")) {
        if (c === "\r" || c === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write("\n"); return res(s.trim()); }
        if (c === "\u0003") process.exit(130);
        s = c === "\u007f" ? s.slice(0, -1) : s + c;
      }
    });
  });
}

async function key() {
  const cfg = L.loadConfig();
  if (sub === "store") {
    const where = L.storeKey(await readSecret(), cfg);
    const chk = await L.checkKey(cfg);
    return print({ stored: where, check: chk }, `Stored in ${where}. Check: ${chk.detail}.`);
  }
  if (sub === "check") { const c = await L.checkKey(cfg); if (!c.ok) process.exitCode = 1; return print(c, `${c.ok ? "OK" : "NOT OK"}: ${c.detail}${c.source ? ` (from ${c.source})` : ""}`); }
  const { source } = L.findKey(cfg);
  print({ source }, source ? `Key found in ${source} (value not shown).` : "No key found.");
}

// ---------------- doctor ----------------
async function doctor() {
  const cfg = L.loadConfig();
  const checks = [], steps = [];
  const add = (name, ok, detail, fix) => { checks.push({ name, ok, detail }); if (!ok && fix) steps.push(fix); };
  const [maj] = process.versions.node.split(".").map(Number);
  add("node", maj >= 20, `v${process.versions.node}`, "Install Node.js 20 or newer.");
  add("git", L.has("git"), L.tryRun("git", ["--version"])?.trim() ?? "missing", "Install git.");
  add("git repo", L.tryRun("git", ["rev-parse", "--show-toplevel"]) !== null, process.cwd(), null);
  const ghOk = L.has("gh") && L.tryRun("gh", ["auth", "status"]) !== null;
  add("gh", ghOk, L.has("gh") ? (ghOk ? "signed in" : "installed, not signed in") : "missing (PR numbers need it; base..head ranges work without)", L.has("gh") ? "Run: gh auth login" : "Optional: install GitHub CLI (https://cli.github.com) to review PRs by number.");
  const { host, how } = L.detectHost(a.host);
  const hc = cfg.hosts[host] ?? cfg.hosts.generic;
  add("host", host !== "generic", `${host} (${how})`, `Pass --host <claude-code|codex|opencode|grok> when the agent is not detected.`);
  add("reviewer models", hc.reviewers.length >= 2, hc.reviewers.length ? `${host}: ${hc.reviewers.join(" > ")} (config: ${cfg._source})` : `none configured for ${host}`,
    `List at least two models your ${host} subscription offers, strongest first, in hosts.${host}.reviewers of ${L.CONFIG_PATH} (node ${CLI} config init writes a starter file).`);
  const k = L.findKey(cfg);
  if (L.jevOff(cfg)) add("TypeSafe key", true, "Jev switched off: heuristic only", null);
  else if (k.key) { const c = await L.checkKey(cfg); add("TypeSafe key", c.ok, `${c.source}: ${c.detail}`, "The key was found but not accepted: create a new one at https://console.typesafe.ai/keys and store it again."); }
  else {
    add("TypeSafe key", false, "not found: plans use the code-only heuristic, not Jev", null);
    steps.push(
      "Optional, for Jev judgments: 1) Create an API key at https://console.typesafe.ai/keys (current prices: https://docs.typesafe.ai/models).",
      `2) In your own terminal (not in the agent chat), copy the key, then run: node ${CLI} key store --from-clipboard   (macOS; or run 'node ${CLI} key store' and paste at the hidden prompt; elsewhere set TYPESAFE_API_KEY in your shell profile). Never paste the key into the chat or a repo file.`,
      `3) node ${CLI} key check`);
  }
  for (const [n, cmd] of Object.entries(COMPANIONS)) { const p = findSkill(n); add(`skill ${n}`, !!p, p ? p.replace(homedir(), "~") : "not installed (the audit gate points to it)", `Install ${n}: ${cmd}`); }
  const out = { checks, next_steps: steps, config: cfg._source, logs: cfg.log ? L.STATE_DIR : "off" };
  print(out, [...checks.map(c => `${c.ok ? "ok  " : "todo"}  ${c.name.padEnd(24)} ${c.detail}`), "", steps.length ? "Next steps:" : "Ready.", ...steps.map(s => `  - ${s}`)].join("\n"));
}

// ---------------- config ----------------
function config() {
  if (sub === "init") {
    if (existsSync(L.CONFIG_PATH)) return print({ exists: L.CONFIG_PATH }, `${L.CONFIG_PATH} already exists; edit it by hand.`);
    mkdirSync(dirname(L.CONFIG_PATH), { recursive: true });
    writeFileSync(L.CONFIG_PATH, JSON.stringify(L.DEFAULTS, null, 2) + "\n");
    return print({ wrote: L.CONFIG_PATH }, `Wrote ${L.CONFIG_PATH}. Fill hosts.<your host>.reviewers with your models, strongest first.`);
  }
  const { _source, ...cfg } = L.loadConfig();
  print({ source: _source, ...cfg }, JSON.stringify({ source: _source, ...cfg }, null, 2));
}

const usage = s => Object.assign(new Error(`usage: node ${CLI} ${s}`), { usage: true });
const COMMANDS = { doctor, key, fit, plan, audit, config };
try {
  if (!COMMANDS[cmd]) throw usage("<doctor | key store|check|where | fit | plan <target> | audit <target>|--routine | config init|show> [--host h] [--author m] [--json]");
  await COMMANDS[cmd]();
} catch (e) {
  console.error(e.usage ? e.message : `jev-review: ${e.message}`);
  process.exitCode = e.usage ? 2 : 1;
}
