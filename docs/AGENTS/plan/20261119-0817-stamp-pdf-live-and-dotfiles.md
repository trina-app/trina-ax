# stamp_pdf page "1" on the live server; srt placeholders never shown in a project folder

- Date (UTC): 2026-11-19 08:17
- Branch: `fix/stamp-pdf-live-and-dotfiles`
- Status: done
- Where: Team AX core (`shared/src/tools.ts`, `server/src/devenv/srt/placeholders.ts` and the listings that skip them, `tests/linux/srt-attack.ts`). Why: tool inputs and the Linux run sandbox are core.
- Version impact: patch

## Goal

- TC-5347 (TC-5241): on qa.trina.app 0.5.18-dev `stamp_pdf` with `page: "1"` still said "Invalid input: page", while a number and edit_pdf "1" worked, and the unit tests passed. Find the cause with the real engine, fix it there, test that path.
- TC-5349: a background command in a shared project chat left nine empty dotfiles and .claude, .idea, .vscode, skills in the project folder, visible in Files and in other members' change notices.

## Findings

- TC-5347: Claude Code (also Haiku and Sonnet through it) hands a top-level text argument over as the model typed it, quotes included: the server got `page` = the three characters `"1"`. Reproduced with `claude -p` and a stdio MCP server that listed the real StampPdfInput schema: the arguments were `{"page":"\"1\""}`. Inside an object (edit_pdf operations) the text arrives clean, which is why only stamp_pdf failed and the tests (which send `"1"` as a plain string) passed.
- TC-5349: the placeholders are srt's mount points that the runner makes itself (placeholders.ts): bwrap binds /dev/null over a path that must exist, and a name taken away while a run lives lets the command make it (the deny stops). So they must be on the disk for the life of the run; a background command or dev server lives for hours. What was wrong is that they were shown.

## Steps

1. `unquote` in the page/page-list/every preprocessors (shared/src/tools.ts); tests at the schema and the MCP handler.
2. `isRunPlaceholder(abs)` (placeholders.ts): an empty name this server made for a run that is still going. Listings skip it: the Files tree, the AI's list, folder and file name search, the project walkers, and the devenv snapshots (so "files changed" and the change notices never carry them).
3. Tests: tests/unit/dev-env-placeholders-hidden.test.ts; T1 case PH1 (tests/linux/srt-attack.ts): everything new during a run is a placeholder, the folder is exactly as before after it.

## Checks

typecheck, prepush, the PDF and dev-env unit suites, tests/security; T1 in Docker (colima arm64, AppArmor userns restriction off for the run).

## Result

- TC-5347: fixed at the cause; verified with `claude -p` (Haiku) against a stdio MCP server with the real schema: `{"page":"\"1\""}` now reads as page 1.
- TC-5349: the names stay on the disk while a run lives (bwrap needs them; the disk cannot be avoided without breaking the deny) but are never shown. T1 (Docker, arm64) all 114 held incl. PH1 and HOSTMODES.
