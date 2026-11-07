# jev-review

Risk-ranked pull request review that runs on the agent subscription you already pay for.

A script reads the diff and asks a few small yes/no questions: does it touch money, a database, sign-in, a security control, tricky logic, or only docs? Plain code turns the answers into a plan: how deep the review goes, which of your models review it (never the model that wrote it), a second pass when the risk is high, and whether a security audit should run. Your own agent (Claude Code, Codex, OpenCode, Grok CLI or any other) then does the reviewing.

- **No extra AI bill for reviews.** Reviewers are your host's own models and subagents. No GitHub Actions minutes.
- **Risk decides the depth.** A typo fix gets one quick review; an auth change gets two strong models in a row.
- **The author never grades its own work.** Authors come from `--author` and from `Co-Authored-By` trailers.
- **Judgments, not decisions.** The yes/no answers come from [TypeSafe Jev](https://docs.typesafe.ai/introduction.md), a System One model that returns a calibrated probability per question; the truth tables in [`rules.mjs`](skills/jev-review/scripts/rules.mjs) decide. No key? A documented code-only heuristic runs instead, and every output says which one ran.

## Install

Every host needs Node.js 20+ and git. `gh` is needed to review by PR number.

| Host | One command | Checked on 2026-11-07 |
|---|---|---|
| Claude Code (plugin) | `claude plugin marketplace add Loomlyne/jev-review-skill && claude plugin install jev-review@jev-review` | manifest passes `claude plugin validate` |
| Claude Code (skill) | `npx skills add Loomlyne/jev-review-skill --skill jev-review -a claude-code -g` | installed to `.claude/skills/` |
| Codex CLI | `npx skills add Loomlyne/jev-review-skill --skill jev-review -a codex -g` | Codex lists it from `.agents/skills/` |
| OpenCode | `npx skills add Loomlyne/jev-review-skill --skill jev-review -a opencode -g` | `opencode debug skill` lists it from `~/.config/opencode/skills/` |
| Grok CLI (xAI) | `npx skills add Loomlyne/jev-review-skill --skill jev-review -a grok -g` | `grok inspect` lists it from `~/.grok/skills/`; project-scope skills show only in a trusted folder |
| Any other agent | `git clone --depth 1 https://github.com/Loomlyne/jev-review-skill /tmp/jr && cp -R /tmp/jr/skills/jev-review <your agent's skills folder>/` | then add one line to its instructions: "For PR reviews, follow `<path>/jev-review/SKILL.md`." |

`npx skills` is the [Vercel Labs skills CLI](https://github.com/vercel-labs/skills). Drop `-g` to install into the current project instead.

## 60-second demo

In any repo with a recent commit, ask your agent:

> Review the last commit with jev-review.

Or run the scripts yourself (`CLI` = `node <skill folder>/scripts/cli.mjs`):

```bash
CLI doctor                          # what is set up, what is missing
CLI plan HEAD~1..HEAD               # tier + reviewer models
CLI audit HEAD~1..HEAD              # security-audit mode + untangle signal
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

## First run

The agent runs `CLI doctor` itself and walks you through each `todo`:

- **Reviewer models.** Claude Code ships with `opus > sonnet`. For other hosts, run `CLI config init` and list the models your subscription offers, strongest first. See [hosts.md](skills/jev-review/references/hosts.md).
- **TypeSafe key (optional).** Create one at [console.typesafe.ai/keys](https://console.typesafe.ai/keys). In **your own terminal**, not the agent chat, copy it and run `CLI key store --from-clipboard` (macOS Keychain; the clipboard is cleared afterwards), or `CLI key store` and paste at the hidden prompt (macOS Keychain or Linux Secret Service). Anywhere else, set `TYPESAFE_API_KEY` in your shell profile. `CLI key check` confirms it works. The key is never printed, logged or written to a repo file. TypeSafe bills Jev calls under its own pricing and terms: see [models](https://docs.typesafe.ai/models.md) and [legal](https://docs.typesafe.ai/legal.md).
- **Companion skills.** The audit gate points to Cloudflare's [security-audit](https://github.com/cloudflare/security-audit-skill) and Caldo's [untangle-codebase](https://github.com/caldoai/skills). Doctor prints the install command for each one that is missing.

## Is it worth it for you?

`CLI fit` answers that before you commit to it. It reads, locally and read-only:

- your agent notes: `~/.claude/CLAUDE.md`, the project `CLAUDE.md`, the Claude memory index, `AGENTS.md`, and the Codex, OpenCode and Grok user notes. `*.local.md` files are listed but never sent.
- the last 90 days of git history, recent PR titles (`gh`), file paths, and the `uses:` lines of your CI workflows.

The first run sends nothing. It shows what it read and what it would send. `fit --send` asks Jev six small questions on redacted text (emails and key-like strings are replaced). `fit --offline` uses the heuristic and sends nothing. `--show-payload` prints the exact payload. Counts such as PRs, commits and authors are facts that code gathers. Jev only judges what needs reading: does this code handle money, sign-in or a database? Do your notes ask for reviews? Do you use more than one model? Do you work with other people? Does an AI reviewer already run? Is the repo mostly prose?

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

With no key, `JEV_REVIEW_OFF=1`, or `"jev": false` in config, each signal comes from path and keyword rules in `heuristicSignals`. A matching file path scores 0.8. A keyword only in changed lines scores 0.5, which counts as unsettled. No match scores 0.1. Duplicated logic is not judged. These are scores, not probabilities, and every output says `judge: "heuristic"`. Expect more standard and deep reviews than Jev would choose.

## Config

`~/.config/jev-review/config.json` (or `$JEV_REVIEW_CONFIG`). Every key is optional:

```json
{
  "model": "jev-latest",
  "bands": { "yes": 0.7, "no": 0.3 },
  "keychain": { "service": "jev-review", "account": "typesafe" },
  "log": true,
  "hosts": { "claude-code": { "reviewers": ["opus", "sonnet"], "ask_first": [] } }
}
```

Logs record signals and verdicts only, never diff text, and go to `~/.local/state/jev-review/*.jsonl`.

## What leaves your machine

Only the Jev requests to `api.typesafe.ai`: the diff for `plan` and `audit` (lockfiles and build output removed, capped at 80k characters), and the redacted fit payload after you agree to send it. Without a key, nothing is sent. The reviews run on your host's models under that host's own terms.

## Tests

```bash
npm test     # truth tables with fixed answers, CLI in a scratch repo (offline), Jev client with a fake fetch
```

## Credits

- [TypeSafe](https://typesafe.ai): Jev and the System One API. This project is not affiliated with TypeSafe.
- [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) (MIT) and [caldoai/skills](https://github.com/caldoai/skills) `untangle-codebase` (MIT): referenced and installed separately, not bundled.

## License

Not chosen yet (proposed: MIT).
