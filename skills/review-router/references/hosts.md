# Hosts: install paths and how to launch a reviewer

The plan prints `reviewers` (model ids) and `how` (the launch line for your host). Model ids come from your config's `hosts.<host>.reviewers`, strongest first. Only Claude Code ships with defaults, because its subagent `model` values are fixed names; for every other host, list the models your own subscription offers.

| Host | Skill folder (user / project) | Launch a reviewer on model M | Default reviewers |
|---|---|---|---|
| Claude Code | `~/.claude/skills/` / `.claude/skills/` (or the plugin) | Agent tool with `model: "M"` (`opus`, `sonnet`, `haiku`, `fable`) | `opus`, `sonnet` |
| Codex CLI | `~/.agents/skills/` / `.agents/skills/` | `codex exec -m M -s read-only "<prompt>"` | none: set yours |
| OpenCode | `~/.config/opencode/skills/` / `.opencode/skills/` (also reads `.claude/skills`, `.agents/skills`) | subagent with `model: provider/M` and `mode: subagent`, or `opencode run -m provider/M "<prompt>"` | none: set yours |
| Grok CLI (xAI) | `~/.grok/skills/` / `.grok/skills/` | `grok -m M -p "<prompt>"` | none: set yours |
| Any other agent | wherever it reads instructions | run the prompt on M in a fresh context | none: set yours |

## Config example

`~/.config/review-router/config.json` (create with `node scripts/cli.mjs config init`):

```json
{
  "hosts": {
    "claude-code": { "reviewers": ["opus", "sonnet"], "ask_first": ["fable"] },
    "codex": { "reviewers": ["<strongest model>", "<second model>"] },
    "opencode": { "reviewers": ["anthropic/<model>", "openai/<model>"] },
    "grok": { "reviewers": ["<grok model id>"] }
  }
}
```

- `reviewers`: models that may review, strongest first. Deep tier takes the first two that are not the author; standard and light take the second-strongest (cheaper) first.
- `ask_first`: premium models that may only be the second deep pass, and only after the user says yes.
- Cross-host reviews are fine: an OpenCode list can mix providers, so a change written by one vendor's model is reviewed by another's.
