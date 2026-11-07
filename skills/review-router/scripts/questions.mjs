// Every Jev question this skill asks, in one place. Jev judges; code in rules.mjs decides.
// Wording follows the TypeSafe guidance: one observable judgment per Noul, concrete true/false criteria.
const q = (instructions, t, f) => ({ type: "noul", instructions, criteria: { true: t, false: f } });

// Review tier: which risks does the change touch?
export const REVIEW = {
  money: q("Does the diff in `diff` change code that charges, prices, refunds or pays out money?", "Payment, pricing, invoice, refund or payout code changes", "How money is charged, priced or paid out stays the same"),
  database: q("Does the diff in `diff` change a database schema, migration, query or row-level security policy?", "Schema, migration, query or policy code changes", "The database layer is untouched"),
  auth: q("Does the diff in `diff` change sign-in, sessions, roles, permissions or tokens?", "Login, session, role, permission or token code changes", "Who can sign in and what they may do stays the same"),
  security: q("Does the diff in `diff` change secrets handling, security headers, input validation or access to files and data?", "A security control is added, removed or weakened", "No security control changes"),
  subtle: q("Does the diff in `diff` change logic whose mistakes tests often miss, such as concurrency, state machines, caching, retries, or date and time-zone math?", "Such logic changes", "The logic is straightforward: markup, copy, styling, simple mapping or wiring"),
  docs_only: q("Does the diff in `diff` change only documentation, planning notes or comments?", "Every changed file is prose: markdown, planning files or comments", "At least one changed file is code, config, a migration or a test")
};

// Audit gate: trust boundaries (security-audit) and tangle signals (untangle-codebase).
export const AUDIT = {
  untrusted_input: q("Does the change in `diff` touch code where input from outside the system enters: HTTP routes, API handlers, webhooks, forms, uploads, parsers, deep links or queue consumers?", "An entry point for outside input is added or changed", "No entry point for outside input changes"),
  access: q("Does the change in `diff` change who may read or write which data: sign-in, sessions, roles, tenant or owner checks, row-level security?", "An access rule or the code enforcing it changes", "Who may read or write what stays the same"),
  secrets_infra: q("Does the change in `diff` change secrets handling, CI workflows, deploy config, CORS, CSP or other security headers?", "Secrets, CI, deploy or header config changes", "None of these change"),
  money: REVIEW.money,
  llm: q("Does the change in `diff` pass user or external text to an LLM, or let an LLM call tools or write output a user sees?", "Outside text reaches a model, or a model's output or tool call reaches users or data", "No LLM input, tool or output path changes"),
  copies: q("Does the change in `diff` copy logic or values that the code shows exist elsewhere, so both must now change together?", "Logic or a value is duplicated", "Nothing is duplicated"),
  special_case: q("Does the change in `diff` add a special case: an if for one value, a parameter for one caller, a swallowed exception, a retry or sleep, or a disabled test?", "At least one such special case is added", "No special case is added"),
  docs_only: REVIEW.docs_only
};

// Fit check: small judgments about the user's own setup. Counts (PRs, authors, CLIs) are facts code gathers.
export const FIT = {
  risky_domain: q("Do the file paths in `repo.sensitive_paths` and the titles in `repo.recent_titles` show this code handles money, sign-in or a database?", "Payment, login, session or database code is part of this repository", "The repository is content, styling, tooling or other code with no money, sign-in or database"),
  wants_review: q("Do the notes in `agent_instructions` ask for code to be reviewed before it is merged or shipped?", "The notes ask for a review step, a second check or a PR before merging", "The notes say nothing about reviewing changes before they merge"),
  multi_model: q("Do the notes in `agent_instructions` show the user works with more than one AI model or coding agent?", "Two or more models or agents are named as part of the user's work", "One model or agent is used, or none is named"),
  team: q("Do the notes in `agent_instructions` describe working with other people on the code, such as teammates, clients or reviewers?", "Other people write, review or approve the code", "The user works on the code alone"),
  has_ai_reviewer: q("Do `agent_instructions` or `repo.ci_workflows` show an AI code reviewer already comments on pull requests automatically?", "A bot or service such as an AI review action already reviews every PR", "No automated AI reviewer runs on pull requests"),
  mostly_prose: q("Do the file paths in `repo.sample_paths` show the repository is mostly prose (docs, articles, course content) rather than code?", "Most files are markdown, text or content", "Most files are source code, config or tests")
};

export const REVIEW_RISK = ["money", "database", "auth", "security"];
export const AUDIT_SEC = ["untrusted_input", "access", "secrets_infra", "money", "llm"];
