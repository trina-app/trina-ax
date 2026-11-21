# Aside: listing profiles and searching memory run without a "send" card

- Date (UTC): 2026-11-21 03:55
- Branch: `fix/aside-read-tools-no-card`
- Status: in progress
- Where: server (`server/src/integrations/connections/`) and the shared preset list (`shared/src/api/local-apps.ts`).
  Why: the read mark of a connection's tools is decided on the server; the listed Aside preset lives in shared.
- Version impact: patch (a card that should not come no longer comes; no new feature, no API change)

## Goal

In a chat the AI called Aside's `browser_profiles` with `{}`. Trina showed the write card: "The AI wants to send this to
Aside: Browser profiles … What it sends: `{}` (2 characters)" and the footer "Always allow every change in Aside". The
owner asked "저거 보내는게 맞아?". Listing profiles sends nothing and changes nothing.

Cause: Trina takes a connection tool as a read only when the service marks it `readOnlyHint: true`
(`mcp.ts toolOf`). Aside 1.26.1115's `tools/list` gives no annotations for any of its four tools (`browser_profiles`,
`memory_search`, `repl`, `exec`), so every Aside tool counts as a change and asks on the write card.

## Scope

In:
- The listed Aside connector (exactly `aside mcp`, `LOCAL_APP_PRESETS` 'aside') gets Trina's own read list, the way a
  Google app keeps Trina's own catalog and ego lite's `read_guide` is marked read-only in the preset:
  `browser_profiles` (lists profile ids, labels and whether each is connected) and `memory_search` (searches the
  person's own Aside notes). Both only read; checked against Aside's descriptions and a real `browser_profiles` call.
- Applied where the saved tool list is read (`store.ts savedTools`), so a connection saved before this change gets it
  at once, without a new check from Settings.

Out:
- `repl` and `exec` keep the write card (they open pages, run JavaScript in the person's logged-in browser, or run a
  browser agent).
- A command the person typed (even `aside mcp --account u2` or a path to aside) gets no list: only the service's own mark.
- A wording change for the write card of tools called with no arguments (other connectors): not needed for this bug.

## Steps

1. `shared/src/api/local-apps.ts`: a `reads` list on the Aside preset; `presetReads(spec)` gives it for the exact listed
   command only.
2. `server/src/integrations/connections/store.ts savedTools`: for a local connection whose spec is a listed preset,
   tools named in its `reads` are marked read-only (cached per tools_rev as before; a changed command clears the list
   and bumps the rev).
3. Unit tests: the listed Aside's `browser_profiles`/`memory_search` are reads and run without a card; `repl`/`exec`
   still ask; a typed command with the same tool names still asks.
4. `changes/aside-read-tools-no-card.md`, a decision note in the local-app decision file's own section.
5. QA on a private copy of the local QA team with real Aside: before (card) and after (no card) screenshots.

## Decisions

- Added to [20261118-local-app-connectors.md](../../decisions/20261118-local-app-connectors.md): "Aside's reads"
  (2026-11-21). Rule: the lean-security call ("no stricter than Aside itself"; asking is the same as for other
  connections, whose read tools run with no card). Claude Code asks once per tool and then never again for that tool;
  Trina asked on every list with a card that says "send" and "every change". Trina does not guess reads from names for
  local apps (the shared-chat review showed names lie); it trusts only its own list for the exact listed command.

## Risks

- Aside later renames a tool so a write gets one of these names: only the two names, only the exact listed command;
  a new tool or a renamed one is a change by default.
- Shared chats, rooms and schedules never get a local connection (`mayUse`), so the shared-chat read rules do not apply.

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit` for connections and local apps, under Bun 1.3.12.

## Result

(filled in at the end)
