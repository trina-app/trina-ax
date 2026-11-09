# post_to_room follow-ups: the note under my name, off-case tests, the step's 보기, the review's NITs

- Date (UTC): 2026-11-09 23:36
- Branch: `fix/post-to-room-followups`
- Status: done
- Where: trina-ax core (`server/src/chat/post-to-room.ts`, `server/src/chat/answer-share.ts`, `shared/src/`,
  `web/src/components/chat/`). Why: chat, rooms and permissions are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Wording, a stricter dedupe after a deletion, an audit flag and a link on a step; no API break
  (one optional field on Step).

## Goal

The independent review of #279 (post_to_room) found no MUST. This PR does its SHOULDs and NITs:

1. The note posts as the person's own words, outside the AI's quote, yet the AI writes it: a planted instruction could
   put a line in the person's voice. The card labels it so the person sees it will appear under their name, and the
   tool tells the AI to write one only when the person asked for one or gave its words.
2. Tests of every case where the tool is not offered, and of a sub-agent's call reaching it (refused on the server).
3. Screenshots of the card (1440 and 390, light and dark).

NITs: the same text posted again after the person deleted the first post goes again (not "Already posted"); the audit
row says `confirmed: true` when the card's yes was pressed; `room` in a side chat posts to the room's timeline, not the
thread (said in the input's description); the step of a post gets 보기, like the button's sent line; the text block
marks long random-looking parts (`marks`), as the other server cards do.

## Scope

In: the items above. Out: hiding the answer's own send button after the AI posted from a side chat (optional, left).

## Steps

1. This plan.
2. Server: the note's label and description; `ai-` ids skip a deleted first post (a fresh `n`); `sendShare` records
   `confirmed` after the card's yes; `Step.posted` on the step; `marks` on the text.
3. Web: 보기 on a post's step (the side chat's own view handler there, the room or thread route elsewhere); five languages.
4. Tests, screenshots, DECISIONS, CHANGELOG.

## Risks

`fix/ai-refusals-clear` (#273) may land first: dev is merged before the push, and its `refusal()` used where it fits.
No migration; `Step.posted` is optional (older apps ignore it).

## Tests

`bun run build:native`; typecheck, check:i18n, check:docs; the post-to-room, answer-share and side-chat suites; web
unit tests in Docker.

## Result

Built as planned (PR link added after it opens).
- The note's label is "내 이름으로 보일 한마디" (five languages); the tool's description and `note`'s say to write one
  only when the user asked for one or gave its words. `room`'s says it posts to the timeline in a side chat.
- A first post the person deleted is not found again: the same text gets a new `n` and its own card (the room keeps the
  deleted message's client id, unique per author, so the lookup of the id itself stays as it is).
- `sendShare(..., { confirmed: true })` after the card's yes. `marks` (url-gate `opaqueParts`) on the text block.
- `Step.posted` (optional) on a post's step; the web's step row shows 보기 (`steps.postView`), through a side chat's own
  `onView` (`StepPostView`) or the room / thread route. One addition found on the way: a chat shared later gives other
  viewers the step without `posted` (it names a room), as it drops `detail` (chat/store.ts viewSteps).
- Tests: b-post-to-room +6 (the off-case table, a sub-agent's call, a post again after a deletion, marks, posted for the
  runner only); web `steps-post-view.test.tsx`; e2e `post-to-room-card.spec.ts` with the mock's card (SHOTS_DIR shots).
- `fix/ai-refusals-clear` (#273) had not landed: its `refusal()` is not used here.
- Left (optional NIT): hiding the answer's own send button after the AI posted from a side chat.
