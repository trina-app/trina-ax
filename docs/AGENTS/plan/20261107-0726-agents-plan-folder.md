# Plan folder for agents and developers

- Date (UTC): 2026-11-07 07:26
- Branch: `docs/agents-plan`
- Status: done
- Where: this repo, `docs/AGENTS/` and the agent instructions. Why: the rule is for everyone who works here.
- Version impact: none (docs and process only)

## Goal

Before anyone (developer or coding agent) starts a feature or a fix, they write a short plan in
`docs/AGENTS/plan/`. Reviewers read the plan first, and the plans together become a record of what was built and
why.

## Scope

In:

- `docs/AGENTS/README.md`: the rule, the file name format and the template.
- `docs/AGENTS/plan/`: this plan as the first example.
- The rule in `CLAUDE.md`, `AGENTS.md` and `docs/REPOSITORY-RULES.md`, so agents read it before they start.
- A "Plan" line in the pull request template.
- A link from `docs/README.md`.

Out:

- A CI check that fails a PR without a plan. Can be added later if the rule is skipped.

## Steps

1. Write this plan (first file on the branch).
2. Add `docs/AGENTS/README.md` with the name format `<timestamp>-<feature>.md` and the template.
3. Add the rule to the agent instructions and the PR template; link the folder from the docs index.
4. Run the checks, push with the trina-app account, open a PR into `dev`.

## Risks

- The repo is public: plans must not hold customer data, secrets, personal paths or private-core work. The README
  says so.

## Tests

- `bun run check:docs` (local links), `bun run check:i18n`, `bun run typecheck`.

## Result

Done as planned.
