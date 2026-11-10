# Any emoji as a reaction, with a picker

- Date (UTC): 2026-11-10 08:06
- Branch: `feat/any-emoji-reactions` (on `feat/custom-status`, PR #288, for its one-emoji rule; rebased onto `dev` once
  that merges)
- Status: in progress
- Where: trina-ax core (`shared/src/api/rooms.ts`, `server/src/rooms/service.ts`, `server/src/rooms/reader.ts`,
  `web/src/components/EmojiPicker.tsx`, `web/src/components/rooms/Reactions.tsx`, `web/src/components/StatusMessage.tsx`,
  `web/scripts/emoji-data.ts`). Why: team chat is core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible feature; the reactions endpoint takes more values than before, nothing it took is
  refused. An older app shows a new emoji as a chip like any other (it renders the string it gets).

## Goal

A message's reactions are 8 fixed emoji today (👍 ✅ 👀 🙏 😂 🎉 ❤️ 🔥); anything else is refused. People want others
(the owner asked for 😭). Any single emoji becomes a reaction, picked from a small strip or a full picker with search,
and a message still cannot be flooded.

## Scope

In:
- **Server**: `PUT /api/rooms/:id/messages/:messageId/reactions` takes any one emoji, checked by the status message's
  rule (`isStatusEmoji`, shared/src/status-message.ts: one emoji or one sequence, no text, no invisible tag letters
  outside the three subdivision flags, at most 32 UTF-16 units). The rules stay: one of each emoji per person per
  message, never a notice or an unread count, every change takes from the sending budget. New: a message carries at
  most 20 different emoji (`ROOM_REACTION_EMOJI_MAX`); a 21st different one is refused (409 `reactions_full`), adding
  to one that is there is always fine. No migration: `room_reactions.emoji` is a plain TEXT column without a check.
- **The AI's view** (`room_read`): reactions stay one line of emoji and counts; only strings that pass the rule are
  written, so nothing but an emoji reaches the AI from a reaction.
- **Strip** (the ☺+ popover on computers, the top of the long-press sheet on phones): 👍 ✅ 👀 ❤️ 😂 😭 and a "More
  emoji" button. Six, so the strip still fits a 360px phone. The hover bar's ✅ 👀 👍 stay.
- **Full picker**: a search field (English names and keywords; Korean too, as the data has them) and the emoji in a
  grid of 8, under small group headings; "Recently used" first (this browser, per person, the last 16). Pasting an
  emoji into the search offers that emoji (a skin tone, a newer one). A popover by the button on computers, a bottom
  sheet on phones (the phone app's WebView too). Keyboard: the search has the focus on computers, Enter picks the
  first match, arrows move in the grid, Esc closes.
- **Data**: `emojibase-data` (MIT; names and keywords from Unicode CLDR, Unicode License v3), trimmed at build time by
  a Vite plugin to the emoji up to Emoji 15.0 (newer ones show as boxes on many phones) without skin tones: one lazy
  chunk for English, one for Korean (loaded for Korean speakers or a Hangul search). The main bundle does not grow
  beyond the picker's code. The licence comes with the package (web/dist/licenses); the CLDR notice the package does
  not ship goes into `resources/notices/unicode-emoji/` and `EMBEDDED_DATA` (scripts/release-notices.ts), NOTICE and
  docs/THIRD-PARTY-NOTICES.md.
- **Status dialog** (PR #288): its emoji button opens the same picker inline; its 32 status emoji are the first view.
- Existing reactions keep working; the 8 old ones look the same.

Out: skin-tone choice in the picker (a pasted one works), category tabs, custom team emoji, search in Indonesian,
Japanese and Spanish (the data has no Indonesian; English works in every language).

## Steps

1. Shared: `RoomReactionEmoji` = a string that passes `isStatusEmoji`; `ROOM_REACTIONS` goes;
   `ROOM_REACTION_EMOJI_MAX = 20`. Server: the cap in `react()`, the localized 409, the reader's filter. Unit tests:
   any emoji, text, several emoji, tag tricks, over-long sequences, the cap, realtime.
2. Web: the Vite plugin and lazy data, `lib/emoji.ts` (parse, search, recents), `EmojiPicker` and its popover/sheet,
   the strip with 😭 and More, recents written when I react. The status dialog uses the picker. Unit tests: search and
   recents.
3. Notices, `docs:api`, DECISIONS, CHANGELOG, the five languages.
4. e2e: 😭 from the strip; search "cry" and react; recents first next time; the phone sheet. The rooms, reactions and
   status specs, then the full web e2e once. Screenshots at 1440 and 390, light and dark.

## Risks

- A flood of different emoji on one message: the 20 cap, and the sending budget per change.
- Text or markup through a reaction: the shared rule on input, React text on screen, the rule again in the AI's view.
- Bundle size: the data is lazy; measured before and after.
- Older apps: they draw any string as a chip; the cap only refuses.
- PR #288 not merged yet: this branch carries it until it lands, then rebases.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `docs:api` and `tests/unit/docs-site.test.ts`, every
`tests/unit/b-rooms-*` and `b-status-*` file, `release-notices`, `bun run test:web`, `bun run build:web`, the room and
status e2e specs, the full web e2e once.

## Result

Filled in at the end.
