# Room composer: a plain "Write a message" placeholder; the ✦ button says what it does

- Date (UTC): 2026-11-21 18:21
- Branch: `fix/room-composer-placeholder`
- Status: in progress
- Where: web (rooms). Why: the owner did not understand the empty room's placeholder "메시지 · ✦로 따로 묻기"
- Version impact: patch, a wording fix with no new feature

## Goal

An empty room or DM showed "메시지 · ✦로 따로 묻기" ("Message · ✦ ask privately") in its message box. The owner asked
what it means. The box should just ask for a message, and the ✦ button in the room header should explain itself.

## Scope

In:
- The room composer always shows `rooms.placeholder` ("Write a message" / "메시지 보내기"), in rooms and DMs, on a
  computer and a phone; a thread keeps `rooms.threadPlaceholder`. The key `rooms.placeholderEmptySide` and the
  composer's `empty` prop go away, in all six languages.
- The ✦ header button's tooltip and aria label (`sideChat.open`) say who sees it: "Ask {name} (only you see it)" /
  "{name}에게 묻기 (나만 봐요)", in all six languages. It still avoids "privately" (c811c06b7).

Out: the side chat panel itself, the server's refusal text "✦ {name}에게 따로 묻기" (not shown in the composer).

## Steps

1. Composer and i18n change; drop the unused prop and key.
2. Update the e2e test that asserted the old placeholder; keep its fits-on-one-line check on the new text.
3. typecheck, check:prepush, web unit tests, room e2e; before/after screenshots at 1440 and 390.

## Decisions

none

## Risks

Six languages: the new label is longer; it is a tooltip and aria label, not drawn text. Phone: the placeholder is
shorter than before, so it still fits on one line.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests (side-chat), web e2e phone-polish and room specs.

## Result

