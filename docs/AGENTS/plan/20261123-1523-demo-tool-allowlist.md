# Free-roam demo: the AI's tools are an allow-list, and no promo video render

- Date (UTC): 2026-11-23 15:23
- Branch: `fix/demo-tool-allowlist`
- Status: in progress
- Where: server/src/demo/guard.ts, server/src/chat/tools.ts, server/src/promo-video/render.ts. Why: the free-roam fence
  and the turn's tool set live there (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A public demo instance refuses two things it should never have reached; nothing changes on any
  other server

## Goal

The public demo lists the tools it refuses, so a tool added later is open to visitors until someone remembers to list
it. An audit of dev found no such tool today, but found one way past the fence: the open "share this answer to a room"
route starts a promo video render, which the demo refuses everywhere else.

## Scope

In:
- `FREE_ROAM_TOOLS`: the tools a free-roam turn may have, generated from the real listing, plus the ones offered only
  in some chats or with the demo's fakes. Anything else is closed. A connected service's tools (the integrations
  provider: the demo's fake Gmail and Higgsfield) stay open as a group; the refused list still wins over them.
- `generate_video` and `save_work_file` join the refused list with their reasons.
- `renderTools` answers `unsupported` on a free-roam demo, which also closes the render from `shareAnswerToRoom`.
- A test that fails when a registered tool is in neither list.

Out: any change to what the demo offers today.

## Steps

1. Plan (this file).
2. guard.ts: the allow-list; tools.ts: pass `integration` for the integrations provider's tools.
3. render.ts: the free-roam stop.
4. Tests, a decision file, `changes/demo-tool-allowlist.md`.

## Decisions

[20261123-demo-tool-allowlist.md](../../decisions/20261123-demo-tool-allowlist.md)

## Risks

A tool left off the list disappears from the demo: the list is generated from the real listing, and the demo's fake
Gmail, Drive, Higgsfield and banner tests must stay green. No effect outside a free-roam demo (`isFreeRoam` first).

## Tests

`bun run typecheck`, `bun run check:prepush`, the demo unit tests (`a-demo-free-roam`, `demo-free-roam`, `demo-fakes`,
`demo-banner`, `demo-banner-shared-chat`, `demo-gmail-search`, `a-demo-mode`, `connection-card-demo`, `higgsfield`) and
the promo video tests.

## Result

Filled in at the end.
