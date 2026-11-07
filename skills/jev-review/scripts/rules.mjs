// Pure decision code. Jev (or the documented heuristic) supplies signals; these truth tables pick the outcome.
// No I/O here, so every row is unit-tested in test/rules.test.mjs.
import { REVIEW_RISK, AUDIT_SEC } from "./questions.mjs";

export const DEFAULT_BANDS = { yes: 0.7, no: 0.3 };
export const band = (p, b = DEFAULT_BANDS) => (p >= b.yes ? "yes" : p <= b.no ? "no" : "unsettled");
const isYes = (p, b) => band(p, b) === "yes";

// ---------- Review tier ----------
// facts: { changed: lines added+removed, files: number of files }
export function reviewTier(s, facts, b = DEFAULT_BANDS) {
  const yes = REVIEW_RISK.filter(k => isYes(s[k], b));
  const unsettled = [...REVIEW_RISK, "subtle"].filter(k => band(s[k], b) === "unsettled");
  const big = facts.changed > 400 || facts.files > 10; // size is code's job, never Jev's
  if (isYes(s.docs_only, b)) return { tier: "light", reason: "docs only: prose cannot change behaviour" };
  if (yes.length) return { tier: "deep", reason: `touches ${yes.join(", ")}` };
  if (unsettled.length >= 2) return { tier: "deep", reason: `unsettled on ${unsettled.join(", ")}: stronger review` };
  if (isYes(s.subtle, b)) return { tier: "standard", reason: "subtle logic" };
  if (big) return { tier: "standard", reason: `large diff (${facts.changed} lines, ${facts.files} files)` };
  if (unsettled.length) return { tier: "standard", reason: `unsettled on ${unsettled[0]}` };
  if (facts.changed <= 80) return { tier: "light", reason: `small diff (${facts.changed} lines)` };
  return { tier: "standard", reason: "ordinary code change" };
}

// Map an author string ("claude-opus-5-5", "Opus", "gpt-5-codex") to a reviewer id from the host's list.
export function matchModel(author, models) {
  if (!author) return null;
  const a = author.toLowerCase();
  return models.find(m => a === m.toLowerCase()) ?? models.find(m => a.includes(m.toLowerCase())) ?? null;
}

// Pull model names out of Co-Authored-By trailers in commit messages.
export function authorFromTrailers(messages, models) {
  const found = new Set();
  for (const line of messages.split("\n")) {
    const m = line.match(/^co-authored-by:\s*(.+)$/i);
    if (!m) continue;
    const id = matchModel(m[1], models);
    if (id) found.add(id);
  }
  return [...found];
}

// host: { reviewers: strongest-first ids, ask_first: ids that need the user's yes (premium) }
// authors: ids that wrote the change (never review their own work).
export function pickReviewers(tier, host, authors = []) {
  const r = host.reviewers ?? [];
  const order = tier === "deep" ? [...r, ...(host.ask_first ?? [])] : [r[1], r[0], ...r.slice(2)].filter(Boolean);
  const allowed = order.filter(m => !authors.includes(m));
  const n = tier === "deep" ? 2 : 1; // deep risk gets a second pass
  const reviewers = allowed.slice(0, n);
  return {
    reviewers,
    ask_first: reviewers.filter(m => (host.ask_first ?? []).includes(m)),
    fallback: allowed[n] ?? null,
    same_model: reviewers.length === 0,
    note: reviewers.length === 0
      ? "No model other than the author's is configured: review in a fresh context with the same model, and say so in the review."
      : reviewers.length < n ? "Only one other model is configured: the second pass is skipped; say so in the review." : null
  };
}

// ---------- Audit gate ----------
// facts: { changed, files, markers, routine, auditAgeDays (null = never), days }
export function auditModes(s, f, b = DEFAULT_BANDS) {
  const yes = AUDIT_SEC.filter(k => isYes(s[k], b));
  const unsettled = AUDIT_SEC.filter(k => band(s[k], b) === "unsettled");
  let security, security_reason;
  if (isYes(s.docs_only, b)) { security = "none"; security_reason = "docs only"; }
  else if (f.routine && (f.auditAgeDays === null || f.auditAgeDays >= f.days) && (yes.length || unsettled.length >= 2)) {
    security = "full";
    security_reason = `${f.auditAgeDays === null ? "no full audit yet" : `last full audit ${f.auditAgeDays} days ago`}; changes touch ${[...yes, ...unsettled].join(", ")}`;
  } else if (yes.length >= 2 || (yes.length && (f.changed > 400 || f.files > 10))) { security = "scoped"; security_reason = `touches ${yes.join(", ")} across ${f.files} files`; }
  else if (yes.length || unsettled.length >= 2) { security = "focused"; security_reason = yes.length ? `touches ${yes[0]}` : `unsettled on ${unsettled.join(", ")}`; }
  else { security = "none"; security_reason = "no trust-boundary changes"; }

  const tangle = isYes(s.copies, b) + isYes(s.special_case, b) + (f.markers >= 3);
  const untangle = isYes(s.docs_only, b) ? "none" : f.routine && tangle >= 2 ? "propose" : tangle ? "watch" : "none";
  const untangle_reason = untangle === "none" ? "no new copies or special cases"
    : [isYes(s.copies, b) && "duplicated logic", isYes(s.special_case, b) && "special cases added", f.markers >= 3 && `${f.markers} sleep/retry/skip/ignore markers`].filter(Boolean).join(", ");
  return { security, security_reason, untangle, untangle_reason };
}

// ---------- Fit check ----------
// facts: { prs_90d: number|null (null = gh unavailable), commits_90d, authors_90d, review_models }
export function fitVerdict(s, f, b = DEFAULT_BANDS) {
  const y = k => isYes(s[k], b), u = k => band(s[k], b) === "unsettled";
  const activity = f.prs_90d >= 4 || (f.prs_90d === null && f.commits_90d >= 30) ? "active"
    : (f.prs_90d ?? 0) === 0 && f.commits_90d < 10 ? "idle" : "some";
  const modelsOk = f.review_models >= 2 || y("multi_model");
  const why = [];

  why.push(activity === "active" ? `you change this repo often (${f.prs_90d ?? "?"} PRs, ${f.commits_90d} commits in 90 days)`
    : activity === "idle" ? `this repo barely changes (${f.prs_90d ?? 0} PRs, ${f.commits_90d} commits in 90 days)`
    : `this repo changes now and then (${f.prs_90d ?? "?"} PRs, ${f.commits_90d} commits in 90 days)`);
  if (y("risky_domain")) why.push("it handles money, sign-in or a database, where a second model's review pays off");
  else if (u("risky_domain")) why.push("not clear from your files whether it handles money, sign-in or a database");
  if (y("wants_review")) why.push("your agent notes already ask for a review before merging");
  why.push(modelsOk ? `a model other than the author is available to review (${f.review_models} configured)` : "only one model is set up, so every review would be the author's own model");
  if (y("has_ai_reviewer")) why.push("an AI reviewer already runs on your PRs; this would mostly duplicate it");
  if (y("team") || f.authors_90d > 1) why.push("other people work on this code, so a risk-ranked review gives them a smaller diff to worry about");
  if (y("mostly_prose")) why.push("the repo is mostly prose, where the light tier is all you would ever get");

  let verdict;
  if (activity === "idle" || y("mostly_prose")) verdict = "not worth it";
  else if (activity === "active" && (y("risky_domain") || y("wants_review")) && modelsOk && !y("has_ai_reviewer")) verdict = "this will help";
  else verdict = "partly";
  return { verdict, activity, why };
}

// ---------- Code-only heuristic (no TypeSafe key, or Jev switched off) ----------
// Not probabilities: a strong path match scores 0.8, a keyword only in changed lines 0.5 (counts as unsettled),
// nothing 0.1. Documented in README "Without Jev".
const H = {
  money: { path: /(pay|billing|invoice|checkout|stripe|pric|refund|payout|subscription|wallet)/i, line: /\b(amount|currency|charge|refund|price|invoice|payout)\b/i },
  database: { path: /(migrations?\/|schema|\.sql$|prisma|drizzle|supabase|\/db\/|models?\/)/i, line: /\b(SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE TABLE|ALTER TABLE|CREATE POLICY)\b/ },
  auth: { path: /(auth|login|session|oauth|jwt|permission|roles?\b|middleware)/i, line: /\b(password|session|token|jwt|role|permission|isAdmin|signIn|signOut)\b/i },
  security: { path: /(secret|crypto|csp|cors|headers|sanitiz|\.env)/i, line: /\b(secret|apiKey|api_key|sanitize|escape|validate|CSP|CORS|crypto)\b/i },
  subtle: { path: /(queue|worker|cron|cache|scheduler)/i, line: /\b(setTimeout|setInterval|mutex|lock|retry|cache|timezone|toLocale|Promise\.all|race|debounce|throttle)\b/i },
  untrusted_input: { path: /(routes?\/|api\/|handlers?\/|webhooks?|upload|parser|forms?\/|controllers?\/)/i, line: /\b(req\.body|request\.json|formData|searchParams|JSON\.parse|params\.)\b/i },
  access: { path: /(auth|session|rls|polic|permission|roles?\b|tenant)/i, line: /\b(role|permission|owner_id|tenant|user_id|auth\.uid|isAdmin)\b/i },
  secrets_infra: { path: /(\.github\/workflows|wrangler|dockerfile|deploy|\.env|vercel\.json|netlify\.toml|_headers)/i, line: /\b(secret|CORS|Content-Security-Policy|Access-Control)\b/i },
  llm: { path: /(llm|prompt|openai|anthropic|agent|ai\/)/i, line: /\b(openai|anthropic|completion|messages\.create|prompt|systemPrompt|tool_use)\b/i }
};
const PROSE = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(docs|\.planning)\//i;

export function heuristicSignals(keys, { files, added, markers = 0 }) {
  const out = {};
  for (const k of keys) {
    if (k === "docs_only") { out[k] = files.length && files.every(f => PROSE.test(f)) ? 0.9 : 0.05; continue; }
    if (k === "copies") { out[k] = 0.1; continue; } // not judged without Jev
    if (k === "special_case") { out[k] = markers > 0 ? 0.8 : 0.1; continue; }
    const h = H[k];
    out[k] = files.some(f => h.path.test(f)) ? 0.8 : added.some(l => h.line.test(l)) ? 0.5 : 0.1;
  }
  return out;
}

const FIT_H = {
  risky_domain: t => H.money.path.test(t) || H.auth.path.test(t) || H.database.path.test(t),
  wants_review: t => /\b(review|reviewer|pull request|PR)\b/i.test(t),
  multi_model: t => (t.match(/\b(claude|opus|sonnet|haiku|gpt|codex|gemini|grok|opencode|cursor|copilot|llama|mistral)\b/gi) ?? []).map(x => x.toLowerCase()).filter((x, i, a) => a.indexOf(x) === i).length >= 2,
  team: t => /\b(team|teammate|colleague|client|reviewer|we review)\b/i.test(t),
  has_ai_reviewer: t => /\b(coderabbit|pr-agent|qodo|copilot review|greptile|ellipsis|sourcery|codium)\b/i.test(t),
  mostly_prose: null
};
export function heuristicFit({ instructions, sensitivePaths, titles, ci, samplePaths }) {
  const txt = `${instructions}\n${titles.join("\n")}`;
  return {
    risky_domain: sensitivePaths.length >= 3 ? 0.8 : FIT_H.risky_domain(txt) ? 0.5 : 0.1,
    wants_review: FIT_H.wants_review(instructions) ? 0.5 : 0.1,
    multi_model: FIT_H.multi_model(instructions) ? 0.8 : 0.1,
    team: FIT_H.team(instructions) ? 0.5 : 0.1,
    has_ai_reviewer: FIT_H.has_ai_reviewer(`${instructions}\n${ci}`) ? 0.8 : 0.1,
    mostly_prose: samplePaths.length && samplePaths.filter(p => PROSE.test(p)).length / samplePaths.length > 0.7 ? 0.8 : 0.1
  };
}

// ---------- Redaction before anything leaves the machine ----------
const SECRETS = [
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g
];
export function redact(text) {
  let t = text;
  for (const re of SECRETS) t = t.replace(re, "[redacted-secret]");
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]");
  t = t.replace(/(\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*)\S+/gi, "$1[redacted]");
  return t;
}
