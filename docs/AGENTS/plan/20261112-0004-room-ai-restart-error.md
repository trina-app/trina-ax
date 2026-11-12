# Room AI (when turned on): an answer cut by a restart tells the asker

- Date (UTC): 2026-11-12 00:04
- Branch: `fix/room-ai-restart-error`
- Status: in progress
- Where: `server/src/rooms/ai.ts` (`state`), `web/src/store/rooms.ts` (`loadAi`, `dismissAi`), a short
  `docs/DECISIONS.md` section. Why: rooms are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: a failed answer now says so after a restart or a reload

## Goal

QA TC-241 (room AI mentions turned on, off by default since 11-09): a member asks @트리나 a long question and the server
restarts while it answers. The "answering" line goes away for everyone, but the asker sees nothing: no "답하지
못했어요", toast or notice; the question looks ignored. The server stored the run as `error` ("서버가 다시 시작되어 답변이
중단됐어요."), but `GET /api/rooms/:id/ai` lists only working runs (`mine: []`), and the window keeps an ended run only
when it heard the `room.ai.run` event itself, which went out while nobody was connected.

## Decision (simplest option that meets the row)

- `GET /api/rooms/:id/ai` lists my runs that ended in an error in the last 24 hours too (not stopped ones: I stopped
  them), so the line "답하지 못했어요 …" with its reason shows under the question after a reconnect or a reload, where it
  already shows when the event arrives live (`EndedRun` in RoomMessages).
- Closing that line (X) is remembered in this browser for the person (`localStorage`, the last 200 closed), so a reload
  does not bring a closed line back. Nothing new on the server for it.

Out: a notice in Activity, retrying the question for the person, and runs that ended more than 24 hours ago.

## Steps

1. Server `state()`: active runs and my error runs ended within 24 h, oldest first.
2. Web store: `loadAi` drops runs closed here; `dismissAi` remembers them (per person, capped).
3. Tests: server (an error run is listed for its asker only, an old one or a stopped one is not; a run cut at start-up,
   `reconcile`, is listed); web store (a listed error run shows, a closed one stays closed after the next read).
4. `changes/room-ai-restart-error.md`, a short DECISIONS section.

## Risks

Who sees what: the list is the asker's own (unchanged rule); nothing for other members. No migration. Open PR #483 edits
`resync` in the same store file, not `loadAi` / `dismissAi`.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/b-rooms-ai.test.ts`,
`web/test/unit/rooms-store.test.ts`.

## Result

(filled in at the end)
