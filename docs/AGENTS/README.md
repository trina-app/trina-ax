# Plans before work

Every developer and coding agent writes a plan **before** starting a feature or a fix. Code comes after the plan.

## The rule

1. Make the feature branch from the latest `dev`.
2. Write the plan in `docs/AGENTS/plan/` and make it the **first commit** on the branch, before any code.
3. Build what the plan says. If the approach changes, update the plan in the same branch.
4. Link the plan in the pull request ("Plan" in the template). At the end, set `Status: done` and fill in `Result`.

Not needed for: typo fixes, dependency bumps and release version bumps. Outside contributors are welcome to add a plan,
but do not have to.

## File name

```
docs/AGENTS/plan/<timestamp>-<feature>.md
```

- `<timestamp>`: the UTC time when the plan is written, `YYYYMMDD-HHMM`. Get it with `date -u +%Y%m%d-%H%M`.
- `<feature>`: what is being built, in lowercase words joined with `-`. Use the branch name without its prefix.

Example: branch `feat/room-message-links` → `docs/AGENTS/plan/20261107-0830-room-message-links.md`.

The timestamp keeps plans in the order they were written. Never rename a plan after it is merged.

## Template

Copy this into the new file. Keep it short: a reviewer should read it in two minutes.

```markdown
# <Feature in one line>

- Date (UTC): YYYY-MM-DD HH:MM
- Branch: `feat/<feature>`
- Status: draft | in progress | done | dropped
- Where: <repo/folder>. Why: <one sentence> (see docs/REPOSITORY-RULES.md)
- Version impact: patch | minor | major | none, and one reason (see docs/RELEASE-CI.md "Version numbers")

## Goal

What problem this solves and for whom. What changes for the user.

## Scope

In: what this change does.
Out: what it leaves for later.

## Steps

1. ...
2. ...

## Risks

Migrations (check the highest number in `server/migrations/` on `dev`), permissions, security, the five app
languages, phone and desktop, anything that touches other areas.

## Tests

The checks and tests this needs: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the area's unit
tests, and the full web e2e for UI changes.

## Result

Filled in at the end: what was built, what differs from the plan and why, the PR link.
```

## This repo is public

Plans are published with the code. Do not put customer names or addresses, secrets, private links, personal paths or
work that belongs in the private core (see [repository rules](../REPOSITORY-RULES.md)) in a plan.
