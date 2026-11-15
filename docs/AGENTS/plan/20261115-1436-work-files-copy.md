# Find work files: the Full Disk Access screen says what you get, Restart lands back on the same step

- Date (UTC): 2026-11-15 14:36
- Branch: `fix/work-files-copy`
- Status: done
- Where: web (components/onboarding/FullDiskAccess.tsx, FindWorkFiles.tsx, TeamFilesStep.tsx, MemberWelcome.tsx,
  lib/workFilesResume.ts, App.tsx, i18n), docs/site/use/find-work-files.md (and zh), tests. Why: Find work files is a
  Team AX core feature (see docs/REPOSITORY-RULES.md)
- Version impact: patch, new words and a smoother restart on an existing screen; no new feature or API change

## Goal

QA TC-3098. The owner: the Mac's Full Disk Access screen ("Let Trina AX look through your work files", "With Full Disk
Access, macOS doesn't ask about each folder") explains the mechanics. It must say what the person gets. Its "How" link
(https://ax.trina.app/docs/use/find-work-files/) is a 404. The owner also asked whether the app has to be quit and
reopened after the switch is turned on: the person should never have to work that out.

## Scope

In:
- The screen's words, true for each way in: the setup's 팀 파일 step (files go to the team's home, the team's AI picks)
  says "Find files your team should have" and that nothing is shared or moved without you; My files and the welcome
  card (files go to My files › From this computer, only the person sees them) say "Find your work files". One short
  line: "To look, Trina AX needs Full Disk Access on this Mac." Picture, privacy line and Not now / Open Settings stay.
- Restart: the screen already goes on by itself when the app has the access (it asks every second and when the window
  comes back). Back in the window and still off: one button, "Restart Trina AX", and a quiet "Open Settings again".
  The page notes the step before Settings opens and before a restart (also covers macOS's own Quit & Reopen); the
  restarted app (it starts on Home) opens that page and that dialog again, which goes on by itself. 15 minutes, the same
  person, taken once, forgotten when the dialog closes.
- The welcome card's row hint leads with what Trina AX does.
- The guide page: already on dev (docs/site/use/find-work-files.md, nav.json); the website needs a re-sync. Its intro
  and Full Disk Access part follow the new words; full-disk.webp reshot.
- A unit test: every https://ax.trina.app/docs/... link in the apps' code leads to a page in docs/site/nav.json, and a
  #section to one of its headings.

Out:
- The app's own consent dialog (desktop main process) keeps its words: it is the consent and lists what is read.
- Whether macOS needs the restart at all is decided by the app's own probe (the main process, which also does the look):
  nothing changes in the desktop app.

## Steps

1. Words in en, then ko, ja, zh, es, id. 2. Resume note and the four ways back. 3. e2e and shots. 4. Docs, test, checks.

## Risks

The five app languages; a note that would reopen a dialog unasked (kept 15 minutes, for the same person, removed on
close and when the screen goes on).
