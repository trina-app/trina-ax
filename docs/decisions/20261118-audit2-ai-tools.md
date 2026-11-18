# Six AI limits Claude Code does not have: batch rename, Drive offset, longer lists, profile, language, schedules

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (raises the numbers of "Skills: the whole list, the skill tool", "Connection tools: deferred, found
  and called", "D — Company profile from the company website" and the scheduled-task cap in docs/DECISIONS.md)
- Branch: fix/audit2-ai-tools (second limits audit N18, N33, N34, N40, N41, N42; QA TC-4979 … TC-4984)

- **Ask:** the owner wants the AI to behave like Claude Code. A limit Claude Code does not have is a bug unless it keeps
  one person's data from another. The second limits audit found six such limits still on dev.
- **Rule:**
  1. **rename_files** (TC-4983). One call renames many files or folders in place: `renames` (a list of
     `{ path, new_name }`) or a pattern (`folder`, `find`, `replace`, `regex`) on the names directly inside one folder.
     Each item goes through rename_file's checks: the name, skill folders (by the old and the new name), the file
     layer's access, and a taken name fails that item. There is never a " (2)". Versions, file events with
     `tool: rename_files`, and one audit line per call. An item that fails is listed, and the rest go on. At most
     **500** per call (`RENAME_FILES_MAX`): a list over 500 fails the input check. A pattern with more matches renames
     the first 500 (in the Files screen's order) and says how many are left. Claude Code renames with a shell loop, which
     has no cap. The cap keeps one call to a few seconds on the server's thread. rename_files is offered wherever
     rename_file is: shared chats (SHARED_TOOLS), guests (GUEST_TURN_TOOLS), sub-agents (not in PARENT_ONLY_TOOLS), and
     the room-file and own-words lists. In a shared chat every listed path and a pattern's folder count as read
     (namedPaths). After a room read, the change card lists each rename. A rename onto an instruction file is seen
     before the call: for a pattern the server works out the new names itself (tools/rename-pattern.ts, the same code
     as the tool). More than ROOM_CHANGE_SCAN_MAX names, or a pattern it cannot read, count as one. Stored keys are
     hidden in new names and in a pattern's replacement. A regular expression with a group that repeats inside a
     repeat, a choice that repeats, or a back-reference is refused. Names are matched on the server's own thread, and
     such a pattern can take very long.
  2. **drive_read offset** (TC-4984). `offset` (characters, default 0) next to `maxChars`. A cut read gives
     `offset`, `totalChars` and `next` ("call drive_read again with offset N"). Before, the AI could not read past the
     first 100,000 characters of a Drive file.
  3. **Longer descriptions in the AI's lists** (TC-4979). A skill line's description is now up to 400 characters (was
     160), and so is a deferred connection tool's first sentence. The "use when …" part at the end of most skill
     descriptions was being cut. The budgets stay at 8,000 characters each. When the skill list is over budget, fewer
     skills get a description, in the same order as before, with the same "find them with find_skills" line. The tool
     list cuts every line the same: 400, 240, 160, 100, 60, 40, then names only. find_tools returns up to **25** (was
     10). The answer still fits MAX_RESULT_CHARS: room is kept for the short notes of the later tools, and a tool past
     the limit comes by name with "select:".
  4. **Company profile** (TC-4980). The AI reads up to **8,000** characters of it (`PROFILE_BLOCK_MAX`, was 2,000).
     The long fields take more so a person can type a real description: products 3,000 (was 400), customers 1,500
     (300), expressions to avoid 1,000 (300). The web form reads the same constants. The save refusal and its six
     languages already used the constant. Name, one-line intro, tone and colours are unchanged: the one-line intro also
     goes into invitations.
  5. **Accept-Language** (TC-4981). web_fetch, save_url and the intro deck's site reading ask for the person's
     language, else the team's, then English (`ko,en;q=0.8`, `id,en;q=0.8`, `en`). Before, every person and site got
     `ko,en;q=0.8`. Without a person or team (a brand image, a generated video's download), it is `en`.
  6. **Scheduled tasks** (TC-4982). **50** per person, counting paused ones (was 20). A tick runs every due task
     anyway, and a full queue already retries a minute later. The message on the 51st uses the number.
- **Left out:** Drive OCR and copying Drive files (other audit items). Renaming deeper than one folder by pattern (the AI
  lists those, or calls once per folder). Changing other skill-list code (open PR #1284 changes that file).
- **Tests:** `c-file-moves` (rename_files list, 200 by pattern in one call, regex groups, 520 in two calls, skill
  folders, the lists, the room card's targets, step labels), `c-integrations-secret-files` (key hiding), `c-drive-tools`
  (offset), `skill-list` and `c-integration-deferred-tools` (400 characters within the budget, find_tools 25),
  `b-onboarding-profile` (an 8,000-character profile saves and reaches the AI), `c-webfetch` and `download`
  (Accept-Language), `schedule-templates` (50), tool lists in `c-tools`, `i-wiring`, `b-browser`.
- **Version impact:** patch.
