# Phone notification titles never repeat the message through the chat's title

- Date (UTC): 2026-11-24 16:04
- Branch: `fix/push-preview-title-generic`
- Status: done
- Where: server notifications. Why: a check of #523 found that with previews off a chat push title still showed
  the message, because a chat is named after its first message until a title is made.
- Version impact: patch (a fix to #523's titles and the generic line's wording)

## Goal

With previews off, or while a chat's title is still a message's text, the title says "Shared chat" (or the project's
name). The line without the message reads the same for rooms, chats and the gateway.

## Scope

In: `chatPlace` (notifications/push-preview.ts), `TEXT['room.dm']`, tests. Out: desktop and browser wording.

## Steps

1. `chatPlace` takes the preview and locale; generic place when off or when the title is a message's text.
2. `room.dm` line = the chat and gateway line.
3. Tests for both, decision note, changes file.

## Decisions

Follow-up note in `docs/decisions/20261124-push-preview-slack-rule.md`.

## Risks

None beyond wording: the room fallback line changes from "새 메시지가 왔어요." to "새 메시지가 있어요".

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/push-preview-slack-rule.test.ts`, `push-locale`, push area.

## Result

As planned.
