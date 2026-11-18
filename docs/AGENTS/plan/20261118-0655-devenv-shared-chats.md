# Commands (dev environment) in shared chats, fenced to what everyone may read

- Date (UTC): 2026-11-18
- Branch: `feat/devenv-shared-chats`
- Status: done
- Where: trina-ax server/src/devenv (Team AX core). Why: the dev environment and the shared-chat gate are core code.
- Version impact: minor, a shared chat can now run commands (owner decision 11-18, QA TC-4848)

## Goal

Team project chats are shared by default (since 11-13), and the dev environment (`box_shell`) is never offered in a
shared chat, so in a project chat the AI cannot run any command (it could not unzip a file). Offer it in shared chats,
fenced so nothing reaches the other people in the chat that they could not read themselves.

## Scope

In:
- `chat/turn.ts`: offer the dev environment in a shared chat (same flag, scope, schedule/template/restricted gates).
- `devenv/srt/access.ts`: an audience-aware view (`sharedFolderView`) from the same RuleSet.access: read = the asker's
  access intersected with the read access of everyone who sees the chat, inside the project folder (project chat) or
  anywhere outside users/ and .system/ (people chat); write = where the asker may write in that set, only in the project
  folder (Q0 (b) as today). No personal folders, the asker's own included.
- `devenv/srt/runner.ts`: a run of a shared chat carries the chat's audience (read again on every call and on every
  tracker poll, so a change mid-turn stops a running command); a per-chat home and log folder, not the person's.
- `devenv/tool.ts`: in a shared chat no jobs or dev servers (foreground commands only), commands that would use a login
  are refused with no card, no job results of the person, a tool text that says what a command can see.
- Settings check: a shared run never reads or writes users/, and a project run nothing outside the project folder.
- Clean-up: the per-chat homes are cleaned like the person homes and removed with the chat.

Out: jobs and dev servers in shared chats (their rows, logs and notices are per person); the in-app browser stays off.

## Steps

1. access.ts sharedFolderView + unit tests against RuleSet.access.
2. runner/config: Space.shared, chat home/logs, settings check; tool.ts limits; turn.ts gate.
3. Docs: decision file, srt-dev-env.md, changes file.
4. Tests, typecheck, i18n, docs checks.

## Decisions

`docs/decisions/20261118-devenv-shared-chats.md` (changes "never in a shared chat" of
[Dev environment on srt](../../DECISIONS.md)).

## Risks

Security (a shared run must not show the asker's private folders). Fail closed: an audience that cannot be loaded,
or an asker no longer in it, gives no run.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit/dev-env*.test.ts and a new
tests/unit/dev-env-shared-chat.test.ts, under Bun 1.3.12. Real srt runs need Linux (Docker suite); not run on this Mac.

## Result

Built as planned. Differences: the decision is a new file (docs/decisions/20261118-devenv-shared-chats.md, the repo
rule), not a section in docs/DECISIONS.md; what a run may read joins the answer's record before it starts (a record
that fails stops the run); the shared-chat instructions drop "the dev environment" from what is not available when
box_shell is offered. Credential cards: off (login commands refused, no card). No new i18n keys or migration.
