# "Don't ask again" on the @everyone question in rooms

- Date (UTC): 2026-11-18 08:41
- Branch: `feat/everyone-dont-ask-again`
- Status: done
- Where: web/ and shared/ (Team AX core). Why: room composer and per-person preferences are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a small option on an existing question and a settings switch (no migration: prefs is JSON)

## Goal

In a room of 10 or more people a message with "@전체" (@everyone) asks first, in one line inside the box ("This
notifies 11 people. Send it?"). People who send such messages often want to stop being asked (QA TC-4864). They get a
"Don't ask again" tick on that line, and a switch in Settings to turn the question back on.

## Scope

In:
- A per-person preference `prefs.mentionAllAsk: 'off'` (UserPrefs, PATCH /api/me, null = ask again). One choice for
  all rooms, on every device.
- The question line gets one small checkbox "Don't ask again". Ticked + Send saves the preference and sends.
- With the preference set, a "@전체" message goes at once.
- Settings › Notifications › Conversations: a switch "Ask before notifying everyone" (on = ask, the default).

Out: the phone app (mobile/) is a shell around the web app, so the same code covers it. There is no other
mass-notify question (no @here, no group mentions with a question), so only "@전체" uses it.

## Steps

1. shared: `mentionAllAsk` in UserPrefs, nullable in UpdateMeBody.
2. web: RoomComposer reads the pref, skips the question, tick on the question line saves it.
3. web: settings switch in RoomNotifySettings.
4. i18n: en first, then ko/ja/zh/es/id.
5. Tests: server (a-auth: save/read/clear), web unit (question skipped, switch puts it back).

## Decisions

none

## Risks

None for data: prefs is a JSON column. Older servers drop an unknown pref field only if they validate strictly;
UserPrefs is a non-strict object, so it is kept.

## Tests

`bun run typecheck`, `bun run check:prepush`, a-auth unit test, web unit tests for RoomComposer and settings.

## Result

Built as planned. `prefs.mentionAllAsk` ('off' or absent; PATCH null clears it), the "Don't ask again" tick on the
question line (on a phone the tick and the buttons take their own line under the question), the switch "Ask before
notifying everyone" in Settings › Notifications › Conversations. `MENTION_ALL_CONFIRM` moved to web/src/lib/rooms.ts so
the settings row can name the number without importing the composer. Only "@전체" has a question; no other
mass-notify case exists. The PR link is in the pull request.
