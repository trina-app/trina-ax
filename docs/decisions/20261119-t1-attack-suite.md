# A shared chat's command that writes where nothing is kept fails loudly

- Date: 2026-11-19
- Status: accepted
- Supersedes: in [A shared project chat's restricted sub-folders do not exist for the chat](20261118-shared-hide-subfolder-names.md),
  "what it makes there is not kept" for the top of a folder given entry by entry
- Branch: fix/t1-attack-suite (T1 attacks S12, RV1, RV1d, RV6; review of PR #1372; QA TC-5208, follow-up TC-5209)

- **Ask:** the T1 attack suite found that a shared chat's command could write into a read-only team folder and exit 0,
  with nothing saved. The review of the fix found the same at deeper folders, at the team root and `groups/`, and at the
  top of a shared project chat's folder that holds a sub-folder not everyone may open. The coordinator decided, under the
  owner's "Claude Code is the floor" rule, that silent success is never acceptable.
- **Rule:** on Linux, srt makes every folder above what a shared chat's run is given (the team root, `groups/`,
  `projects/`, and any folder given entry by entry, read-only or writable, at any depth) as a folder of the sandbox's own
  tmpfs. The command's first line takes the write bits of these folders (`devenv/srt/mounts.ts` `placeFolders`,
  `entryGuard`). A new file or folder there fails with "Permission denied", which the command and the AI see. The tool's
  note after each command says so (`lockedTopsNote`).
- **Not a boundary:** the sandbox's user owns these folders and can give the write bit back with `chmod u+w`. What it then
  makes there still stays in the sandbox's tmpfs and reaches no disk and no one else (attack RV2). The lock is there so
  honest writes are not lost without a word.
- **Left out:** keeping a new file at the top of such a writable folder (TC-5209). Private chats' runs keep srt's
  writable places above their folders as before; their folders are given whole, so this is only the team root and its
  path folders.
- **Tests:** `tests/unit/shared-hidden-subfolders.test.ts` ("srt's places above what is given"); T1 S12, RV1, RV1c,
  RV1d, RV2, RV6.
- **Version impact:** patch.
