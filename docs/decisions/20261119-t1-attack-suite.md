# A shared chat's command that writes where nothing is kept fails loudly

- Date: 2026-11-19
- Status: accepted
- Supersedes: in [A shared project chat's restricted sub-folders do not exist for the chat](20261118-shared-hide-subfolder-names.md),
  "what it makes there is not kept" for the top of a folder given entry by entry
- Branch: fix/t1-attack-suite (T1 attacks S12, RV1, RV1d, RV6, RW4, SK2, PL1, PL2; reviews of PR #1372; QA TC-5208, TC-5210, follow-up TC-5209)

- **Ask:** the T1 attack suite found that a shared chat's command could write into a read-only team folder and exit 0,
  with nothing saved. The review of the fix found the same at deeper folders, at the team root and `groups/`, and at the
  top of a shared project chat's folder that holds a sub-folder not everyone may open. The coordinator decided, under the
  owner's "Claude Code is the floor" rule, that silent success is never acceptable.
- **Rule:** on Linux, srt makes two kinds of folders of the sandbox's own tmpfs, both writable and never kept: every
  folder above what a run is given (the team root, `groups/`, `projects/`, and any folder given entry by entry,
  read-only or writable, at any depth), and the empty mask over each hidden folder in the team folder (`users/`,
  `.system`, the group and project skills folders that every run hides since QA TC-4932, a folder limited inside a
  readable one). In every run, private chats too, the command's first line takes the write bits of both
  (`devenv/srt/mounts.ts` `lockFolders`, `placeFolders`, `entryGuard`). A new file or folder there fails with "Permission
  denied", which the command and the AI see. The tool's note after a shared chat's command says so (`lockedTopsNote`).
  Folders the run is given stay as they are: the lock skips them, and inside the sandbox it touches only a folder (not
  a link, not a masked file) on a tmpfs. When the team folder itself is on a tmpfs nothing is locked. The Docker suite
  checks that no folder or file in the team folder changes mode or owner on the disk (HOSTMODES).
- **Where the lists live:** the first line's files (pins, folders to lock) are written into a guard folder of the run
  (`devenv/guard/<run>`, `config.ts` `runGuard`, `mounts.ts` `makeGuardDir`): made new by the server for that run, in
  a folder no run can see, read-only in the run, removed when it ends. Never the run's TMPDIR: a person's TMPDIR is in
  her HOME, and one run could swap it for a link to a folder she may not open, which the next run's server write would
  follow (review of PR #1372, T1 RX1-RX4).
- **Not a boundary:** the sandbox's user owns these folders and can give the write bit back with `chmod u+w`. What it then
  makes there still stays in the sandbox's tmpfs and reaches no disk and no one else (attack RV2). The lock is there so
  honest writes are not lost without a word.
- **Left out:** keeping a new file at the top of such a writable folder (TC-5209); srt's places outside the team folder
  (the base folder's path folders), which no team file is in.
- **Tests:** `tests/unit/shared-hidden-subfolders.test.ts` ("srt's places above what is given"); T1 S12, RV1, RV1c,
  RV1d, RV2, RV6, RW1-RW6, RW4c, HOSTMODES; the sub-agent suite's SK2, PL1, PL2.
- **Version impact:** patch.
