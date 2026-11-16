# CI notify also posts CI results on main to a Trina room

- Date (UTC): 2026-11-16 04:23
- Branch: `ci/notify-trina-room`
- Status: done
- Where: trina-ax/.github/workflows. Why: the CI notice workflow lives here (see docs/REPOSITORY-RULES.md)
- Version impact: none, CI only (no product code or package changes)

## Goal

The team follows CI in a Trina room as well as in Discord #trina-ax-ci. Each finished CI run on `main` should show up
in that room too: passed, failed (with the failed jobs) or green again after a failure.

## Scope

In: `.github/workflows/ci-notify.yml` posts the same notice to a Trina room app ("Add an app" → Other) when the
repository secret `TRINA_ROOM_URL` is set. Discord stays as it is.
Out: CI on other branches; the Mac's CI autofix (outside this repo), which posts its own progress to the same room.

## Steps

1. Build the notice once (head, text, colour), then post it to each target that has its secret.
2. Trina: `{"title", "text", "link", "thread"}` with `thread: ci-run-<run id>`, so the autofix messages about a run go
   into the same thread in the room.
3. A target without its secret is skipped; a failed Trina post is a warning, not a failed job (Discord keeps
   failing the job as before).

## Decisions

- The room address is a secret (it is the room app's only key): only in `secrets.TRINA_ROOM_URL`, never in the repo.
- workflow_run takes the workflow from the default branch, so this starts posting after the next release to `main`.

## Result

`ci-notify.yml` posts to Discord and/or the Trina room, each only when its secret is set. Checked locally with the
step's script and fake `gh`/`curl` (passed, failed with jobs, green again, Discord only, Trina only, Trina down).
