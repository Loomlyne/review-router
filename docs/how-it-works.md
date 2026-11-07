# How review-router works

The README covers install and everyday use. This page has the detail. Below, `cli` means `node <skill folder>/scripts/cli.mjs`.

## Commands

```bash
cli doctor                          # what is set up, what is missing
cli plan HEAD~1..HEAD               # tier + reviewer models (or a PR number)
cli audit HEAD~1..HEAD              # security-audit mode + untangle signal
cli fit                             # is this worth it for you?
cli config init                     # list your host's reviewer models
cli key store | key check           # TypeSafe key, in your own terminal
```

A real run on a 5-line change that trusted a caller's `x-admin` header (written by Sonnet, per its commit trailer):

```text
plan   judge jev-1.14.0  auth 0.95  security 0.92  money 0.01  docs_only 0.01
       tier deep (touches auth, security)  authors [sonnet]  reviewers [opus]
       note: only one other model is configured, so the second pass is skipped
audit  untrusted_input 0.82  access 0.95  special_case 0.95
       security scoped  untangle watch (special cases added)
review opus: request changes. src/api/session.js:3 lets any client send x-admin: 1 and edit any document
```

## Judgments, not decisions

A script reads the diff and asks a few small yes/no questions: does it touch money, a database, sign-in, a security control, tricky logic, or only docs? The truth tables in [`rules.mjs`](../skills/review-router/scripts/rules.mjs) turn the answers into the plan. The answers come from one of two backends:

- **Jev** (optional), a System One model from [TypeSafe](https://typesafe.ai) that returns a probability per question. It needs your own TypeSafe API key.
- **The heuristic** (default), documented path and keyword rules. See [Without Jev](#without-jev).

Every output says which one ran. Authors come from `--author` and from `Co-Authored-By` trailers, and the author's model never reviews its own change.

## The truth tables

Noul bands: 0.7 or more is yes, 0.3 or less is no, anything between is unsettled (configurable as `bands`).

**Review tier** (first row that matches wins)

| Signals | Tier |
|---|---|
| docs only | light |
| money, database, auth or security is yes | deep |
| two or more risk signals unsettled | deep |
| subtle logic, or over 400 changed lines or 10 files, or one unsettled | standard |
| 80 changed lines or fewer | light |
| otherwise | standard |

**Reviewers:** deep takes the two strongest models that did not write the change, and models in `ask_first` (premium) may only be the second pass, after you say yes. Standard and light take one reviewer, the cheaper one first. If no other model is configured, the plan says so and a fresh-context review is the fallback.

**Security gate:** `none`, `focused` (security-audit guidance on this diff), `scoped` (two or more trust-boundary signals, or one on a large diff), or `full` (routine check: no full audit in `--days`, and boundary changes found; proposed, never started on its own). **Untangle:** `watch` on duplicated logic, special cases or 3 or more sleep/retry/skip markers. `propose` only on a routine check with two of those signals.

**Failure:** a failed Jev call is an error, never a "no". The plan falls back to deep with the strongest reviewers, and the audit to `focused`.

## Without Jev

With no key, `REVIEW_ROUTER_OFF=1`, or `"jev": false` in config, each signal comes from path and keyword rules in `heuristicSignals`. A matching file path scores 0.8. A keyword only in changed lines scores 0.5, which counts as unsettled. No match scores 0.1. Duplicated logic is not judged. These are scores, not probabilities, and every output says `judge: "heuristic"`. Expect more standard and deep reviews than Jev would choose.

## The fit check in detail

`fit` reads, locally and read-only:

- your agent notes: `~/.claude/CLAUDE.md`, the project `CLAUDE.md`, the Claude memory index, `AGENTS.md`, and the Codex, OpenCode and Grok user notes. `*.local.md` files are listed but never sent.
- the last 90 days of git history, recent PR titles (`gh`), file paths, and the `uses:` lines of your CI workflows.

The first run sends nothing. It shows what it read and what it would send. `fit --send` asks Jev six small questions on redacted text (emails, credentials and key-like strings are replaced). `fit --offline` uses the heuristic and sends nothing. `--show-payload` prints the exact payload. Counts such as PRs, commits and authors are facts that code gathers. Jev only judges what needs reading: does this code handle money, sign-in or a database? Do your notes ask for reviews? Do you use more than one model? Do you work with other people? Does an AI reviewer already run? Is the repo mostly prose?

```text
Verdict: THIS WILL HELP
  - you change this repo often (36 PRs, 409 commits in 90 days)
  - it handles money, sign-in or a database, where a second model's review pays off
  - your agent notes already ask for a review before merging
  - a model other than the author is available to review (2 configured)
Judgments (Jev jev-1.14.0 judged, code decided; 23178 chars sent):
  risky_domain 1.000 yes   wants_review 0.820 yes   multi_model 0.980 yes
  team 0.810 yes           has_ai_reviewer 0.050 no mostly_prose 0.190 no
```

## Config

`~/.config/review-router/config.json` (or `$REVIEW_ROUTER_CONFIG`). Every key is optional:

```json
{
  "model": "jev-latest",
  "bands": { "yes": 0.7, "no": 0.3 },
  "keychain": { "service": "review-router", "account": "typesafe" },
  "log": true,
  "hosts": { "claude-code": { "reviewers": ["opus", "sonnet"], "ask_first": [] } }
}
```

Only Claude Code ships with default reviewers (`opus > sonnet`). For other hosts, run `config init` and list the models your subscription offers, strongest first. See [hosts.md](../skills/review-router/references/hosts.md).

Logs record signals and verdicts only, never diff text, and go to `~/.local/state/review-router/*.jsonl`.

## Storing the TypeSafe key

In **your own terminal**, not the agent chat:

- `cli key store --from-clipboard`: macOS Keychain; the clipboard is cleared afterwards.
- `cli key store`: paste at the hidden prompt (macOS Keychain or Linux Secret Service).
- Anywhere else: set `TYPESAFE_API_KEY` in your shell profile.

`cli key check` confirms it works. The key is never printed, logged or written to a repo file. TypeSafe bills Jev calls under its own pricing and terms: see [models](https://docs.typesafe.ai/models.md) and [legal](https://docs.typesafe.ai/legal.md).

## What leaves your machine

Only the Jev requests to `api.typesafe.ai`, and only when you have set a key:

- for `plan` and `audit`: the redacted diff, with lockfiles and generated files removed, capped at 80k characters;
- for `fit`: the redacted payload, after you agree to send it.

Before Jev or the heuristic reads a diff, `redactDiff` replaces anything that looks like a secret with a placeholder on the same line, so line counts stay true. That covers:

- known key and token formats (`sk_live_`, `ghp_`, `AKIA…`, Slack, JWTs)
- private key blocks
- high-entropy strings
- credentials in connection strings
- `Authorization`, `Bearer` and `Cookie` values
- password, token and secret assignments
- every value in `.env` files (`.env.example` stays readable)

References such as `process.env.API_KEY` stay readable. Without a key, nothing is sent. The reviews run on your host's models under that host's own terms.

## Limits

- Redaction is pattern-based and best effort. A secret with no recognisable shape, such as a short password in an oddly named variable, can get through. Keep secrets out of commits.
- One forged `Co-Authored-By` trailer can remove one reviewer model. Trailers can never remove every reviewer. Pass `--author` when you know who wrote the change.
- `.generated.`, `.min.` and `.snap` files are listed to Jev by name, but their contents are not sent.
- Without a key, the heuristic picks standard and deep reviews more often than Jev would.
- Only Claude Code ships with default reviewer models. Other hosts need theirs listed in the config.
- Tested on macOS. On Linux, the Secret Service key store has not been tried. On Windows, use the `TYPESAFE_API_KEY` environment variable.

## Install details

Checked on 2026-11-07:

| Host | Check |
|---|---|
| Claude Code (plugin) | manifest passes `claude plugin validate` |
| Claude Code (skill) | installed to `.claude/skills/` |
| Codex CLI | Codex lists it from `.agents/skills/` |
| OpenCode | `opencode debug skill` lists it from `~/.config/opencode/skills/` |
| Grok CLI (xAI) | `grok inspect` lists it from `~/.grok/skills/`; project-scope skills show only in a trusted folder |

`npx skills` is the [Vercel Labs skills CLI](https://github.com/vercel-labs/skills). Drop `-g` to install into the current project instead.

## Tests

```bash
npm test     # truth tables with fixed answers, CLI in a scratch repo (offline), Jev client with a fake fetch
```
