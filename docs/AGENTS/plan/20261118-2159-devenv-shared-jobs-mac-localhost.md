# Jobs and dev servers in shared chats; a chat's commands reach its own dev server

- Date (UTC): 2026-11-18 21:59
- Branch: `feat/devenv-shared-jobs-mac-localhost`
- Status: in progress
- Where: public trina-ax, `server/src/devenv/`, `scripts/dev-env/srt/srt-mac.mjs`, `native/cmd/mycel-sandbox/`. Why: the
  dev environment is Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: minor (shared chats can start jobs and dev servers; a later command reaches the chat's dev server)

## Goal

Claude Code is the floor (owner, 2026-11-19). Claude Code runs a background dev server and curls it from the next
command. Trina refuses `job` and `background` in shared chats (QA TC-4989), and on a Mac a later command cannot reach
the dev server it started (QA TC-4990; Linux has the same gap: every run has its own network namespace).

## Scope

In:
- I. Shared chats: `job=true` and `background=true` run, under the shared-chat rules of `box_shell` (the view of
  everyone in the chat, writes only in the project folder or the chat's shared work folder, nothing personal). The row
  remembers it is a shared chat's; the tracker rebuilds who sees the chat for every check, and any change of the chat's
  people or their access (the starter leaving included) stops it. Results go only into that chat (and to the starter's
  notice); the project page list shows no log line of them. The dev server's Preview opens for everyone in the chat.
  Logs: a folder per chat and audience (the same people with the same view share it), so a later command reads the
  job's log with `tail`, and a different audience gets another, empty folder.
- J. A chat's commands may reach the ports its own running jobs and dev servers listen on, nothing else on localhost.
  Mac: srt-mac.mjs adds an outbound rule per port (TRINA_REACH_PORTS), the slots of those ports are not reused while a
  run that may reach them lives. Linux: `mycel-sandbox port-bridge` listens on 127.0.0.1:<port> in the new run's own
  network namespace and copies to the dev server's preview forwarder (systemd installs with the sandbox helper only).

Out: WebSocket in the preview, a dev server that outlives the chat's people changing, credentials in shared chats.

## Steps

1. Migration 421: `dev_env_runs.shared`, `dev_env_runs.port`.
2. runner.ts: shared rows (insert with the access hash, a resolver for the chat's audience, the start checks the hash),
   keyed shared logs (config.ts), reach ports per space, preview for the chat's people.
3. tool.ts: lift the refusal, the shared tool text, job results of the chat (same audience only, noted in the answer's
   record), the port in the dev server answer and a list of reachable dev servers.
4. Mac: srt-mac.mjs TRINA_REACH_PORTS, system-mac.ts holds; Linux: Go `port-bridge`, system.ts `bridge`.
5. Tests: unit (shared jobs, preview, reach ports, srt-mac rules), `tests/linux/srt-attack.ts` cases, Go tests.
6. Decision file, changes note, QA rows.

## Decisions

docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md. Changes the "Left out: jobs and dev servers in shared
chats" of docs/decisions/20261118-devenv-shared-chats.md.

## Risks

Security: shared chats and the sandbox (independent review follows). Migration number (420 is taken by an open PR).

## Tests

`bun run check:prepush`, the dev-env unit suites, `go test ./native/cmd/mycel-sandbox/`, Docker suite cases for CI.

## Result

(at the end)
