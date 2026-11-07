# review-router

**Your AI agent reviews your code changes. The riskier the change, the harder the review.**

It runs on the AI subscription you already have (Claude Code, Codex, OpenCode, Grok CLI or any other agent). No extra bill, no GitHub Actions minutes.

- A typo fix gets one quick review.
- A change to payments, sign-in or the database gets two strong models, one after the other.
- The model that wrote the change never reviews it.

## Install

You need Node.js 20+ and git. Pick your agent and run one command:

**Claude Code**
```bash
claude plugin marketplace add Loomlyne/review-router && claude plugin install review-router@review-router
```

**Codex**
```bash
npx skills add Loomlyne/review-router --skill review-router -a codex -g
```

**OpenCode**
```bash
npx skills add Loomlyne/review-router --skill review-router -a opencode -g
```

**Grok CLI**
```bash
npx skills add Loomlyne/review-router --skill review-router -a grok -g
```

**Any other agent:** copy the `skills/review-router` folder into your agent's skills folder, then add this line to its instructions: "For PR reviews, follow `<path>/review-router/SKILL.md`."

## Use it

In any project, ask your agent:

> Review my last commit with review-router.

or

> Review PR 42 with review-router.

(Reviewing by PR number needs the [GitHub CLI](https://cli.github.com), `gh`.)

That's it. The first time, the agent checks your setup and tells you if anything is missing.

## What you get

```text
plan    tier deep (touches auth, security)   reviewers [opus]
audit   security scoped
review  opus: request changes. src/api/session.js:3 lets any client
        send x-admin: 1 and edit any document
```

## Setup (optional, 2 minutes)

1. **Tell it your models** (not needed on Claude Code). Ask your agent: "Set up review-router with my models." It lists the models your subscription offers, strongest first.
2. **Add a TypeSafe key for sharper judgments.** Without one, it uses simple built-in rules, which play it safe and pick deeper reviews more often. To add one: create a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys), then ask your agent: "Help me add my review-router key." It gives you one command to run in your own terminal. Never paste the key into the chat.

## Is it worth it for you?

Ask your agent: "Run the review-router fit check." It reads your project history and your agent's notes on your machine, shows you what it found, and gives a plain answer: **this will help**, **partly**, or **not worth it**, with the reasons. Nothing is sent anywhere until you say yes.

## Privacy

- Your code is reviewed by your own agent, under its usual terms.
- With a TypeSafe key, a copy of each change goes to TypeSafe to be judged. Passwords, keys and tokens are removed first. This is best effort, so keep secrets out of your commits.
- With no key, nothing leaves your machine.

## Learn more

- [How it works](docs/how-it-works.md): the review rules, config, the fit check, exactly what is sent, and the known limits.
- Security checks build on Cloudflare's [security-audit](https://github.com/cloudflare/security-audit-skill) and Caldo's [untangle-codebase](https://github.com/caldoai/skills) skills, installed separately.
- [TypeSafe](https://typesafe.ai) makes Jev, the optional judgment model. This is an independent project. It is not affiliated with or endorsed by TypeSafe. Jev calls use your own key under [TypeSafe's terms](https://docs.typesafe.ai/legal.md).

## License

[MIT](LICENSE)
