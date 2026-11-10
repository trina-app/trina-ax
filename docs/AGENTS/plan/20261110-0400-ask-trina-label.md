# Room header ✦ button: drop "privately" from its label

- Date (UTC): 2026-11-10 04:00
- Branch: `fix/ask-trina-label`
- Status: done
- Where: trina-ax core (`web/src/i18n/{en,ko,es,id,ja}.ts` key `sideChat.open`, `web/test/unit/side-chat.test.tsx`, CHANGELOG).
- Version impact: patch. Text only.

## Goal

The owner: remove "privately" from the room header ✦ button ("privately 지워"). The label and tooltip become "Ask {name}".

## Scope

In: `sideChat.open` in all five languages (only Room.tsx uses the key). The unit test that expects "privately" now expects the new text.
Out: sentences that explain privacy ("Only you see this chat" and similar).

## Checks

- `bun run typecheck`, `bun run check:i18n`, web unit tests in Docker.
