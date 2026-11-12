# Room drafts and unsent room messages survive closing the app and Reload

- Date (UTC): 2026-11-12 01:17
- Branch: `fix/room-drafts-kept`
- Status: done
- Where: web (Team AX core). Why: room drafts and sends live in the web store, which the phone app's WebView also runs (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix with no new API

## Goal

QA TC-374: a room message that failed to send ("Couldn't send", Try again / Discard) was lost when the phone app was
closed and opened again. QA TC-375: "A new version is ready" → Reload kept only AI chat drafts; the room box's draft was
gone. After this, both come back, never sent twice, and only for the person who wrote them.

## Scope

In: keep each room box's draft (with its mentions) and each room's sends on their way or not sent in this device's
storage, under the AI chat drafts' per-person prefix (`mycel.draft:<user>:…`, lib/localData.ts), so sign-out and another
person signing in clear them (TC-373). The box starts from the kept draft when the page has none. Opening a room brings
the kept sends back as not sent after the newest page is read (one the server already has settles at once); Try again
uses the same client message id, so the server returns the first message.
Out: attachments still uploading (not kept, as in the AI chat); an automatic resend on open; asking the server about a
kept send older than the newest page (no endpoint by client id: it is shown as "not sure this was sent" instead).

## Steps

1. store/rooms.ts: keepRoomDraft / restoreRoomDraft / keepRoomDrafts, keptUnsent, a store listener that writes the sends.
2. RoomComposer: restore at mount, write on each change of text or mentions.
3. lib/reload-guard.ts keepUnsentAsDrafts: also writes the room drafts.
4. Unit tests: test/unit/room-drafts-kept.test.tsx.

## Risks

Privacy on a shared phone: same keys and clearing as the AI chat drafts; each team has its own address, so its own
storage. Double send: the same clientMessageId on retry (server dedupe) and settledPending.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the web unit tests, the room/composer e2e specs.

## Result

Built as planned. One detail: the listener reads the store as it is now, because the settling listener before it may
have changed the sends inside the same update.

After review (PR #525): the kept list is merged into the page on the first change to a room's sends (or at open), so a
send before the newest page came no longer wipes it; tabs of the same person share the lists through the `storage`
event (writes keep the other tab's sends, never rewrite one this page saw end, and drop a failed one the other tab let
go); a kept send shows "Not sure this was sent. Trying again won't send it twice." (new string in five languages);
entries older than 30 days and rooms no longer in my list (read with the list, or when I leave) are dropped.
