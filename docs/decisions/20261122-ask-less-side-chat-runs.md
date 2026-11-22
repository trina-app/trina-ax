# A side chat's copies into my own folder go without the room card; so do its commands, now that runs keep versions

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (amends [대화방을 읽은 뒤 카드 줄이기](../DECISIONS.md) and "내 AI 채팅에서 대화방 읽기")
- Branch: fix/ask-less (the coordinator for the owner, QA TC-f2-c02); rule 2 amended on feat/box-run-file-versions

- **Ask:** one chart request in a room's ✦ side chat raised three cards: "파일 복사 chart.png → 내 파일", "작업 실행 ·
  자세히 141자" and "작업 실행 · 자세히 953자". Owner rules: Always allow is final and teammates are trusted
  (owner-always-allow-means-done), Claude Code is the floor (ai-should-match-claude-code), plain words for
  non-developers.
- **Rule 1, copies into my own folder.** After a room read, `copy_files` of this chat's own places (`chat:work/`,
  `chat:files/`) needs no card when every file lands as a **new** file in `users/<me>/`, under the same exclusions as
  write's exception (`TurnExec.ownFolderCopy` → `ownFolderPlace`): nobody else reads the folder, not skills, not an
  instruction file, not a hidden, plugin or project folder, not a path an AI turn put in the trash, not a file that is
  there already, not a confidential chat. The step ends "내 폴더라 묻지 않고 저장". A team folder, an overwrite and a
  team source keep their cards.
- **Rule 2, commands.** A room message (other people's words) could steer a command that changes or removes files
  already in the person's own folder. Owner 11-22: the room card stays until a run's changes there can be undone. That
  is injection from other people, not covered by Always allow, which is the person's own choice.
  **Since 11-22 (feat/box-run-file-versions): runs keep versions.** A foreground command of a chat that is not shared
  runs inside a change window of the person's own folder (devenv/track.ts withOwnFolderWindow, as project folders
  have had since the dev environment came): before it starts, the content of every file there up to 8 MiB (at most
  256 MiB in all) is in a server-only store (re-read only when a file's size, mtime, ctime or inode changed); after it,
  a changed file's earlier content becomes a file version and a removed file goes to the trash (the team's retention
  days), restorable like any other. A larger file's change cannot be undone, and the AI tells the person. A project
  folder's removed files go to the trash the same way (before: only a version row of a path that was gone).
  So after a room read `box_shell` goes **without** the room card (step: "내 폴더 변경은 되돌릴 수 있어 묻지 않고 실행")
  when all of: the person's own live chat, a ✦ side chat too (no project, not shared, not restricted or scheduled, not a
  guest, not confidential); a foreground command (not a job or a dev server, which write after the call); the command
  does not reach the network itself and "Allow all websites" is off (a room message must not send the files out); and
  every file in the own folder can be kept (`ownFolderUndoable`: none over 8 MiB, under 256 MiB, under the snapshot's
  file count, no node_modules, .git, .env*, dist or build there; skills and shared folders, read-only in a run, do not
  count). Otherwise the card stays. Two checks behind it: the command's window checks again before it runs and does
  not run when a file grew past the limit meanwhile; and a change it made to what the AI follows (skills, CLAUDE.md,
  AGENTS.md ...) or to a hidden file in the own folder is put back at once (the command's file in the trash), after
  which the card is back for the rest of the answer. The Claude Code engine has no Bash (engine/claude.ts), so
  box_shell is the only command path. Out: what a job, a dev server or a process a command left running writes between
  commands is not recorded as a version.
- **Rule 3, the card's words where it stays.** The question and its "하는 일" row are read from the command, never the
  AI's description (`shellCardWords`): the files it makes by kind and name ("그림 파일을 만드는 명령 실행: chart.png"),
  a command that removes, moves or overwrites files keeps "파일 바꾸기", a plain run says "명령 실행" (not "작업 실행").
  The command stays behind 자세히, without a character count.
- **Tests:** tests/unit/places-copy.test.ts (TC-f2-c02), tests/unit/step-labels-shell.test.ts,
  tests/unit/box-run-versions.test.ts (rule 2 since runs keep versions).
- **Version impact:** patch (fewer cards and plainer words; a command's changes in my own folder become versions and
  trash items; no API or schema change).
