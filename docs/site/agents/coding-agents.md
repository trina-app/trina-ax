---
title: Working in this repository
description: Rules, checks and pull request format for AI coding agents that change Trina AX.
---

This page is for AI coding agents, such as Claude Code or Codex, working in the Trina AX repository. The same rules apply to people.

:::note
The short version lives in [`CLAUDE.md`](../../../CLAUDE.md) and [`AGENTS.md`](../../../AGENTS.md) at the repository root. Read them first.
:::

## Ground rules

- The product id in code is `mycel`: folders, sockets and `MYCEL_*` variables. Trina branding is in `editions/trina/branding/`.
- Read the [repository rules (Korean)](../../REPOSITORY-RULES.md) before adding a feature. Shared features belong in the core first. [Read about core and Trina](../develop/core-and-trina.md).
- Check the design decisions before changing permissions, engines or security behaviour: [`docs/decisions/`](../../decisions/README.md) since 2026-11-16, [`docs/DECISIONS.md`](../../DECISIONS.md) before that.
- Licence: AGPL-3.0-only, except `shared/src/cloud-protocol/` (MIT). Keep LICENSE, NOTICE and dependency notices.

## Never commit

| Never | Instead |
|---|---|
| Secrets, keys, tokens, cookies, setup or invite links | Fictional placeholders |
| Customer data, real names, real addresses or host names | Fictional data, such as the demo team |
| Personal paths such as `/Users/<name>/` | Paths relative to the repository |
| A changed `bun.lock` you did not mean to change | `bun install --frozen-lockfile` |

## Checks to run

:::steps
#### Always
```sh
bun run typecheck
```

#### For your change
| Changed | Run |
|---|---|
| Server | `bun run test:unit` or the related `tests/unit/` files |
| Web | `bun run test:web`, `bun run build:web` and related e2e specs |
| Strings | `bun run check:i18n` |
| Docs | `bun run check:docs` |

#### Before you push
```sh
bun run check:prepush
```
It fetches `origin/dev` and runs the quick CI checks (typecheck, docs, change notes, migration numbers, i18n and product names) against it.

#### Compare failures
If a test fails, run it on an untouched checkout before blaming your change. Some suites need native helpers or document converters.
:::

## Pull request format

- Branch from current `dev` and open the pull request against `dev`, never `main`. Keep one focused change per pull request.
- Before code, write a plan in `docs/AGENTS/plan/<timestamp>-<feature>.md` as the branch's first commit ([format](../../AGENTS/README.md)).
- A new feature starts with `넣을 곳: <repository/folder>, 이유: <one sentence>`.
- Fill in the pull request template: problem, change, validation and **Version impact** (`patch`, `minor`, `major` or `none`, with one reason). [Read how to choose](../develop/versioning.md).
- Add screenshots with fictional data for visible UI changes.
- Do not edit `CHANGELOG.md`. Put the user-visible notes in a new file `changes/<topic>.md` ([rules](../../../changes/README.md)); `bun run check:docs` fails a pull request that adds a line under "## Unreleased".
- Write each new design decision as a new file `docs/decisions/<YYYYMMDD>-<topic>.md` ([rules](../../decisions/README.md)). Do not add to `docs/DECISIONS.md`, the archive; `bun run check:docs` fails a pull request that does.
- Update `docs/UPSTREAM.md` when you bring a change from the core.
- `dev` has a merge queue. After review, add the pull request to the queue with `bun run queue <number> <reviewed head SHA>`; do not use `gh pr merge`. [Read the rules (Korean)](../../REPOSITORY-RULES.md).

## Actions that need a human

Do not, without explicit approval: force-push, rewrite history, push or merge to `main`, tag a release, change repository names or visibility, or connect to customer servers.

## Writing style for app strings and docs

Short sentences, plain words, the same word for the same thing, in all six languages. [Read the design rules](../develop/i18n-and-design.md).
