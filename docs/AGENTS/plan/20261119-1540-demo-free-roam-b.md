# Free-roam demo, part B: in-process fake services

- Date (UTC): 2026-11-19 15:40
- Branch: `feat/demo-free-roam-b`
- Status: in progress
- Where: server/src/demo/fakes/ (core). Why: the free-roam demo runs a real server whose Gmail, Drive and Higgsfield
  must work without any outside account, and nothing a visitor does may leave the machine (see docs/REPOSITORY-RULES.md)
- Version impact: none for customers (only a demo file with `fakes` turns it on); patch

## Goal

The free-roam demo (locked plan 2026-11-19, PR B of 6) lets a visitor use Gmail, Google Drive and Higgsfield inside a
real instance. They are answered by fakes in the server process. A send is stored and answered "sent"; nothing is sent.
Any other outside call is refused before a name lookup or a socket.

## Scope

In:
- `server/src/demo/fakes/`: index (activation, per process), state (`<dataDir>/demo-fakes/state.json`), offline fence,
  a small in-process MCP responder, Gmail, Drive (Google's token/revoke/userinfo too), Higgsfield.
- Seams: google-apps library.ts / transport.ts / tokens.ts, google-drive client.ts, connections net.ts (the
  `answerForTests` hook becomes the documented `answer` hook) and service.ts, tools/download.ts, tools/web-fetch.ts
  resolveTarget, slack/api.ts, proxy/connect.ts, main.ts (turn on at start).
- `DemoFile.fakes` (optional, `{ content? }`) in shared/src/api/demo.ts.
- Tests: tests/unit/demo-fakes.test.ts.

Out: the freeRoam run kind and fences (PR A), the end-of-story content and snapshot builder (PR C), the gate (PR D),
host egress rules (hosting).

## Steps

1. Offline fence + fakes + state.
2. Hook each seam; refuse Slack and every direct fetch the fakes do not answer.
3. Tests; typecheck; docs:api.

## Decisions

docs/decisions/20261119-demo-fakes.md

## Result

(filled in at the end)
