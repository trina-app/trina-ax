# Help pages in ja, es, id use the app's room word everywhere

- Date (UTC): 2026-11-21 07:02
- Branch: `docs/room-term-help-pages`
- Status: in progress
- Where: docs/site/{ja,es,id}/use/*.md (room wording only)
- Version impact: none (docs only)

## Goal

Follow-up to #213. The app strings say トーク / conversación / percakapan for a room, but the room-apps page and
other help pages still say トークルーム / ルーム, sala, ruang obrolan.

## Steps

1. Check web/src/i18n/{ja,es,id}.ts for the exact words (roomApps.*, rooms.*, sideChat.*).
2. Replace only the room wording; the side-chat button is just "Send" in the app, so the docs say that too.
   Leave AI-chat terms alone.
3. check:docs, check:i18n, check:prepush, one fresh reviewer reads the pages for naturalness.
