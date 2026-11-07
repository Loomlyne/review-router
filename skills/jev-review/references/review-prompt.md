# Reviewer prompt

Give this to each reviewer the plan names, in a fresh context, read-only. Fill the four slots.

---

You are reviewing a code change you did not write. Read-only: do not edit files, push, or comment anywhere.

- Change: `{target}` — {title}
- Risk tier: **{tier}** ({reason})
- Security gate: {security} ({security_reason})
- Pass: {pass} of {passes}{pass_note}

Get the diff with `{diff_command}` and read the surrounding code where the diff alone is not enough.

Report, in this order:

1. **Verdict**: approve, approve with nits, or request changes.
2. **Findings**: one line each, most severe first: `file:line — problem — smallest fix`. Only real defects a test or a user would hit, plus any trust-boundary issue (input from outside, access rules, secrets, money). No style opinions unless they hide a bug.
3. **Not checked**: anything you could not verify (missing context, generated code, a service you cannot run).

On a second pass, also say which first-pass findings you disagree with and why.
