# Opening a message from a link only scrolls to it, without the coloured box

- Date (UTC): 2026-11-21 02:48
- Branch: `fix/jump-no-highlight`
- Status: done
- Where: web. Why: a web-only look change (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a small visual fix with no new feature and no API change

## Goal

Opening a message from a link (an Activity row, a thread link, a search result, a push tap, a quote's name) scrolls to
it and also draws an accent box and tinted background around it. The owner asked (2026-11-21) to drop the colour and
only go to the place.

## Scope

In: one rule for every jump target (AI chat answers `[data-message-id][data-focused]`, room messages, thread replies,
withheld rows, a quote's jump): the list scrolls the message to the middle, and the message keeps an invisible marker
(`data-focused` / `data-highlight`) for a moment, with no background, box or outline. The row's own hover/menu/focus
look stays, and so does the mark on a message being edited in the box below (a phone).
Out: how the jump finds and scrolls to the message (unchanged).

## Steps

1. `web/src/index.css`: remove the `[data-message-id][data-focused]` look and its transition.
2. `RoomMessages.tsx`: a link's target and a quote's jump set the same marker; `messageRowClass` lights only a row being
   edited in the box; `WithheldRow` has no tint.
3. e2e: the quote jump test asserts the marker and that the message is in view, not the tint.
4. `changes/jump-no-highlight.md`.

## Decisions

none

## Risks

Only the look; the five languages are untouched. Phone and desktop share the code.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests for rooms, web e2e for room links, inbox, search and
chat threads.

## Result

Built as planned in https://github.com/trina-app/trina-ax/pull/196. AI chat answers keep `data-focused` and room
messages `data-highlight` as short-lived marks with no look; a quote's jump now uses the same mark instead of its
own tint. AssistantMessage is not touched.
