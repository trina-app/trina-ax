# Updates wait for running work before the server restarts

- Date (UTC): 2026-11-14 06:14
- Branch: `fix/update-waits-for-work`
- Status: done
- Where: server/src/system, native/cmd/mycel-ctl, web admin. Why: the update paths live there (docs/REPOSITORY-RULES.md)
- Version impact: patch: a fix to how updates restart; no API removed, new fields are optional

## Goal

A server update must not cut off running work (answers, dev-environment commands, video renders, scheduled runs).
On the dev server a build installed during a render and killed it: an app-only `mycel-ctl update` without
`--scheduled` (the dev server's timer) switched and restarted at once.

## Scope

In:
- `mycel-ctl update`: the app switch waits for running answers like root files do (one deadline for both; 30 minutes on
  a self-installed server, 600 s on a hosted one, whose control plane gives the command 1800 s). While it waits it
  writes root/update-waiting.json.
- The server's own update run (Update now, the Linux automatic update): wait cap 10 → 30 minutes, the same wait mark.
- While an update runs: no scheduled run starts; box_shell refuses a foreground command that could not end before the
  restart (a job runs through it); Admin › System says "An update is waiting for N running tasks to finish".
- Update now with tasks running: "Wait, then update" or "Update now anyway"; the waiting line can go on now too.
- Work cut anyway: the cut step is stopped (not failed) and the answer says a running step was stopped, with Try again.

Out: blocking new chat messages during the wait; a waiting line for members in chat; changing the dev server's timer
script (it is on the server, not in the repo).

## Steps

1. mycel-ctl: wait before the app switch, shared deadline, hosted-aware default, wait file. Go tests.
2. server: system/update-wait.ts, runUpdate cap and force, schedules and box_shell checks, UpdateStatus running/waiting.
3. Turn end and restart recovery: cut steps stopped, `updating_step` error.
4. Web: dialog choice, waiting line, five languages.
5. DECISIONS, changes fragment, QA row.

## Risks

Hosted update timeout (kept at 600 s), the prune of a version folder touched before the wait (one hour covers 30
minutes), five app languages, no migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the update, schedule, dev-env and chat unit tests,
web unit tests, mycel-ctl Go tests in Linux Docker.

## Result
Built as planned. After the independent review: the wait mark lasts until the restart (it covered only the wait), a
command is refused only when it could not end before the restart (it was any command over 120 s), "Update now
anyway" also works on an update that already waits, and the AI's thinking does not count as a cut step. PR: see the
pull request that links this plan.
