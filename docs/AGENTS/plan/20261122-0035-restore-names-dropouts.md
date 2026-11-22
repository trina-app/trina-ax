# Restore confirm names whose changes drop out (TC-7246)

- Date (UTC): 2026-11-22
- Branch: `fix/shux-a`
- Status: done
- Where: web (Files › version history restore confirm, i18n). Why: the confirm is a web dialog; the server's restore
  already records and announces itself the way an edit does
- Version impact: patch: clearer words in one confirm; no API change, no migration

## Goal

QA TC-7246 (S-032): restoring v1 of a project file that 한지우 and 박준호 changed later named nobody. The confirm now
says whose changes will no longer be in the latest version, and that they stay in the history.

## Scope

In:
1. `lib/restoreDropouts.ts`: the people other than me who made a version newer than the restored one (stored versions'
   `savedBy`, the replacing `author` of the version before, the current content's author), newest first, each once.
2. Files › history: with such people the body is "{names}'s changes will no longer be in the latest version. They stay
   in the history."; with nobody, today's words.

Out (checked, reported): a notice to those people after the restore. An edit of a team file notifies nobody either (a
file_events row, the realtime `files.changed` event to readers, the history's change list; an AI's save in a shared chat
shows only as that answer). `restoreVersion` already does all of those with action `restore`. Chat files (chats shared
with people) restore through the same `writeVersionOf` as a save and refresh the chat's tiles (`tellChat`) as a save
does; their restore has no confirm dialog. No new notification kind.

## Tests

`web/test/unit/restore-dropouts.test.ts`.
