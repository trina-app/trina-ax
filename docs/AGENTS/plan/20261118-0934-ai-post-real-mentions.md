# The AI's room post can mention people for real

- Date (UTC): 2026-11-18 09:34
- Branch: `fix/ai-post-real-mentions`
- Status: done
- Where: core (server/src/chat/post-to-room.ts, server/src/rooms/service.ts, shared/src/tools.ts). Why: the post_to_room tool and room mentions are core chat code.
- Version impact: patch. A post the AI makes for a person can now notify the people it names in that room; nothing else changes.

## Goal

The owner asked the AI side chat to forward a mail to a teammate in a room. The AI posted "@Full Name Forwarding a
mail…" and said it tagged him, but the text was plain: no highlight, no mention notice. Every post the AI makes goes
through "share an answer" (chat/answer-share.ts), whose message mentions nobody by rule.

## Scope

In:
- post_to_room takes `mention` (people's names or person:<id>), resolved by the server among the people in that room
  (never the asker). An "@Full Name" in the text that is exactly one room member's name is a mention too; any other
  "@word" stays plain text.
- The mentions are written as "@Name" at the start of the person's own line (the note part, before the AI quote), so
  the room shows and notifies them like a mention the person typed; with own_words they stay in the text.
- "@everyone" (each language's word) only when the asker's own message of this turn wrote it; the room's own rule
  (the everyone room: owners and admins) still applies.
- The card names who will be notified; the result lists who was mentioned (count only in a shared chat) and which
  "@names" stayed plain text.
- Rooms.send takes mentions on an answer only when the AI's post_to_room sent it (`via: 'ai'`); the button's share
  still mentions nobody.

Out: highlighting names inside the AI quote itself (the quote is the AI's Markdown; the names at the top of the
person's line are the mention).

## Steps

1. Resolver `server/src/chat/post-mentions.ts` (pure, unit-tested).
2. Wire it into post_to_room (card line, explicit-ask skip only when the asker named each person, result).
3. Rooms.send / sendShare pass and validate the mentions for `via: 'ai'`.
4. Tool schema + one prompt sentence; i18n card label.
5. Tests: server unit, web unit (shared answer note renders the mention).

## Decisions

docs/decisions/20261118-ai-post-real-mentions.md

## Result

Done. Independent review: no high finding; fixed a shorter name matching inside a longer or shared one (text and
asker's words), Always allow / explicit-ask skip with mentions the asker did not name (card shows now), membership
hints in shared-chat results, the note length check and accounts turned off while the card waited. Tests:
tests/unit/post-mentions.test.ts, tests/unit/b-post-to-room-mentions.test.ts, web/test/unit/room-messages.test.tsx.
