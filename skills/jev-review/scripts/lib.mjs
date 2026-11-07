// Shared I/O: config, TypeSafe key lookup, the Jev client, git/gh helpers, local logs.
// The key is read from the environment or the OS keychain and is never printed, logged or written to a file.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const XDG = (v, d) => process.env[v] || join(homedir(), d);
export const CONFIG_PATH = process.env.JEV_REVIEW_CONFIG || join(XDG("XDG_CONFIG_HOME", ".config"), "jev-review", "config.json");
export const STATE_DIR = join(XDG("XDG_STATE_HOME", ".local/state"), "jev-review");

// Defaults. Override any key in CONFIG_PATH (see README "Config"). `reviewers` is strongest-first.
export const DEFAULTS = {
  model: "jev-latest",
  bands: { yes: 0.7, no: 0.3 },
  keychain: { service: "jev-review", account: "typesafe" },
  log: true,
  hosts: {
    "claude-code": { reviewers: ["opus", "sonnet"], ask_first: [], how: "Agent tool with model: \"{model}\" (fresh context, read-only review prompt)" },
    codex: { reviewers: [], ask_first: [], how: "codex exec -m {model} -s read-only \"<review prompt>\"" },
    opencode: { reviewers: [], ask_first: [], how: "a subagent with model: {model} (mode: subagent), or opencode run -m {model} \"<review prompt>\"" },
    grok: { reviewers: [], ask_first: [], how: "grok -m {model} -p \"<review prompt>\"" },
    generic: { reviewers: [], ask_first: [], how: "run the review prompt on {model} in a fresh context" }
  }
};

const merge = (a, b) => {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in (a ?? {}) && typeof a[k] === "object" && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  return out;
};
export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS, _source: "defaults" };
  try { return { ...merge(DEFAULTS, JSON.parse(readFileSync(CONFIG_PATH, "utf8"))), _source: CONFIG_PATH }; }
  catch (e) { throw new Error(`config ${CONFIG_PATH} is not valid JSON: ${e.message}`); }
}

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"], timeout: 30000, ...opts });
export const tryRun = (cmd, argv, opts) => { try { return run(cmd, argv, opts); } catch { return null; } };
export const has = cmd => tryRun(platform() === "win32" ? "where" : "which", [cmd]) !== null;

// ---------- TypeSafe key ----------
// Order: TYPESAFE_API_KEY env var, then the OS keychain (macOS Keychain, Linux Secret Service). Returns { key, source }.
export function findKey(cfg = loadConfig()) {
  if (process.env.TYPESAFE_API_KEY) return { key: process.env.TYPESAFE_API_KEY, source: "env TYPESAFE_API_KEY" };
  const { service, account } = cfg.keychain;
  if (platform() === "darwin") {
    const k = tryRun("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { timeout: 5000 })?.trim();
    if (k) return { key: k, source: `macOS Keychain (service ${service})` };
  } else if (platform() === "linux" && has("secret-tool")) {
    const k = tryRun("secret-tool", ["lookup", "service", service, "account", account], { timeout: 5000 })?.trim();
    if (k) return { key: k, source: `Secret Service (service ${service})` };
  }
  return { key: null, source: null };
}

export const KEY_SHAPE = /^[A-Za-z0-9._-]{16,256}$/;

// Store a key read by the caller (never from argv). Returns where it went, or throws with what to do instead.
export function storeKey(secret, cfg = loadConfig()) {
  if (!KEY_SHAPE.test(secret)) throw new Error("that does not look like a TypeSafe API key (letters, digits, . _ - only); nothing stored");
  const { service, account } = cfg.keychain;
  if (platform() === "darwin") {
    // `security -i` reads the command from stdin, so the key never appears in the process list.
    execFileSync("security", ["-i"], { input: `add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`, stdio: ["pipe", "ignore", "pipe"] });
    return `macOS Keychain (service ${service}, account ${account})`;
  }
  if (platform() === "linux" && has("secret-tool")) {
    execFileSync("secret-tool", ["store", "--label=TypeSafe API key (jev-review)", "service", service, "account", account], { input: secret, stdio: ["pipe", "ignore", "pipe"] });
    return `Secret Service (service ${service}, account ${account})`;
  }
  throw new Error("no OS keychain found: set TYPESAFE_API_KEY in your shell profile or your OS secret store instead");
}

// ---------- Jev client (docs.typesafe.ai/api/system-one) ----------
const API = "https://api.typesafe.ai";
export async function jev(state, questions, { cfg = loadConfig(), timeoutMs = 20000, retries = 3, fetchImpl = fetch } = {}) {
  const { key } = findKey(cfg);
  if (!key) throw new Error("no TypeSafe key");
  const body = JSON.stringify({ model: cfg.model, state, questions });
  let res;
  for (let attempt = 0; attempt < retries; attempt++) {
    res = await fetchImpl(`${API}/v1/systemone`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status !== 429 && res.status !== 529) break;
    const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
    await new Promise(r => setTimeout(r, wait));
  }
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const signals = {};
  for (const k of Object.keys(questions)) {
    const p = data.answers?.[k]?.noul;
    if (typeof p !== "number") throw new Error(`TypeSafe answer for ${k} missing`); // a failed answer is an error, never a "no"
    signals[k] = Number(p.toFixed(3));
  }
  return { signals, model: data.model, usage: data.usage };
}

export async function checkKey(cfg = loadConfig(), fetchImpl = fetch) {
  const { key, source } = findKey(cfg);
  if (!key) return { ok: false, source: null, detail: "no key found" };
  try {
    const res = await fetchImpl(`${API}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, source, detail: res.ok ? "key accepted by api.typesafe.ai" : `api.typesafe.ai answered ${res.status}` };
  } catch (e) { return { ok: false, source, detail: `could not reach api.typesafe.ai: ${e.message}` }; }
}

export const jevOff = cfg => process.env.JEV_REVIEW_OFF === "1" || cfg.jev === false;

// ---------- git / gh ----------
export const git = argv => run("git", argv).trimEnd();
export const gh = argv => run("gh", argv).trimEnd();

// Lockfiles and generated output say nothing about risk and eat Jev's 32k-token per-question budget.
export const NOISE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$|(^|\/)(dist|build|out|\.next|vendor|node_modules)\/|\.min\.(js|css)$|\.generated\.|\.snap$/;

// target: PR number (via gh), or a git range like main..HEAD.
export function loadChange(target) {
  const isPr = /^\d+$/.test(target);
  const diff = isPr ? gh(["pr", "diff", target]) : git(["diff", target]);
  const files = (isPr ? gh(["pr", "diff", target, "--name-only"]) : git(["diff", "--name-only", target])).split("\n").filter(Boolean);
  const title = isPr ? JSON.parse(gh(["pr", "view", target, "--json", "title"])).title : target;
  const range = isPr ? null : target;
  const messages = isPr ? JSON.parse(gh(["pr", "view", target, "--json", "commits"])).commits.map(c => `${c.messageHeadline}\n${c.messageBody}`).join("\n")
    : tryRun("git", ["log", "--format=%B", target]) ?? "";
  return { isPr, diff, files, title, range, messages };
}

export function shapeDiff(diff, { max = 80000, perFile = null } = {}) {
  const hunks = diff.split(/^(?=diff --git )/m).filter(h => !NOISE.test(h.match(/^diff --git a\/(\S+)/)?.[1] ?? ""));
  const kept = (perFile ? hunks.map(h => h.slice(0, perFile)) : hunks).join("");
  const cut = kept.length > max;
  const lines = hunks.join("").split("\n");
  return {
    text: cut ? kept.slice(0, max) : kept, cut, max,
    added: lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1)),
    changed: diff.split("\n").filter(l => /^[+-](?![+-])/.test(l)).length
  };
}

// ---------- host ----------
const HOST_PATTERNS = [["claude-code", /(^|\/)claude$/], ["codex", /(^|\/)codex/], ["opencode", /(^|\/)opencode/], ["grok", /(^|\/)grok/]];
export function detectHost(flag) {
  if (flag) return { host: flag, how: "--host flag" };
  if (process.env.CLAUDECODE) return { host: "claude-code", how: "CLAUDECODE env" };
  if (platform() !== "win32") {
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      const line = tryRun("ps", ["-o", "ppid=,comm=", "-p", String(pid)])?.trim();
      if (!line) break;
      const [, ppid, comm] = line.match(/^(\d+)\s+(.*)$/) ?? [];
      const hit = HOST_PATTERNS.find(([, re]) => re.test(comm ?? ""));
      if (hit) return { host: hit[0], how: `parent process ${comm.split("/").pop()}` };
      pid = Number(ppid);
    }
  }
  return { host: "generic", how: "no known agent found; pass --host" };
}

// ---------- logs (signals and verdicts only, never diffs or text) ----------
export function log(cfg, name, entry) {
  if (!cfg.log) return;
  try { mkdirSync(STATE_DIR, { recursive: true }); appendFileSync(join(STATE_DIR, `${name}.jsonl`), JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n"); } catch { /* logging is best effort */ }
}

export function args(argv, flags = []) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); o[k] = flags.includes(k) ? true : argv[++i]; }
    else o._.push(a);
  }
  return o;
}
