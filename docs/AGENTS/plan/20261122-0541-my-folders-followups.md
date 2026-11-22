# my_folders follow-ups: tool order, honest access, root-rule folders

- Date (UTC): 2026-11-22 05:41
- Branch: `fix/my-folders-followups` (based on `feat/demo-permission-scene`, PR #353; merges after it)
- Status: in progress
- Where: server/src/chat (my-folders.ts, turn.ts). Why: the security review of #353 left three low findings
- Version impact: patch, fixes to a tool that is not released yet

## Goal

The "Folders your AI can see" card says exactly what the person can do, and the tool is offered only where it works.

## Scope

In:
1. turn.ts sets `othersWrote` before `buildToolSet`, so `my_folders` and `looking_at` (and every other tool that reads
   `otherAuthors`) are not offered in a chat other people wrote in, instead of offered and refused at call time.
2. my-folders.ts: a subfolder whose access is lower than its nearest listed parent's stays in the list
   (`shared/` Can edit, `shared/policies` Read only). A folder a plugin manages (`fx.managed`, policy/authorize.ts)
   shows as Read only, because writes there are refused for everyone; the managed folders under `skills/` are listed
   when the person can edit `skills/`.
3. Folders opened only by a team-root (`''`) rule: the top-level folders on disk, each checked with `RuleSet.access`.

Out: anything else on the card or the prompt.

## Steps

1. Move the `othersWrote` query above `buildToolSet`; test through a real turn (`@fake echo tools`).
2. Change the parent filter to "drop only when the nearest listed parent has the same access"; managed folders view.
3. Root-rule candidates; tests in tests/unit/my-folders.test.ts.

## Decisions

none (follows docs/decisions/20261122-demo-permission-scene.md).

## Risks

Permissions: the list must never name a folder the person cannot open. Every candidate still goes through
`RuleSet.access`, and the no-leak tests (a hidden folder answers like a missing one) run again.

## Tests

`bun run typecheck`, `bun run check:i18n`, tests/unit/my-folders.test.ts, b-my-folders, b-looking-at-tool, the
b-shared-chat* tests.

## Result

Filled in at the end.
