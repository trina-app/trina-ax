# A side chat's copies into my own folder go without the room card; its commands keep it until runs keep versions

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (amends [대화방을 읽은 뒤 카드 줄이기](../DECISIONS.md) and "내 AI 채팅에서 대화방 읽기")
- Branch: fix/ask-less (the coordinator for the owner, QA TC-f2-c02)

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
- **Rule 2, commands (owner 11-22: the room card stays).** After a room read, `box_shell` keeps the room card in every
  chat, the person's own chat and a ✦ side chat included. A room message (other people's words) could steer a command
  that changes or removes files already in the person's own folder, and a run's change there gets no file version (the
  dev environment's change record, devenv/track.ts, covers project folders only), so it could not be undone. That is
  injection from other people, not covered by Always allow, which is the person's own choice. A first version of this
  branch skipped the card in the person's own chat; it was reverted before merge.
- **Rule 3, the card's words where it stays.** The question and its "하는 일" row are read from the command, never the
  AI's description (`shellCardWords`): the files it makes by kind and name ("그림 파일을 만드는 명령 실행: chart.png"),
  a command that removes, moves or overwrites files keeps "파일 바꾸기", a plain run says "명령 실행" (not "작업 실행").
  The command stays behind 자세히, without a character count.
- **Follow-up:** record a run's changes in the person's own folder as file versions (as project folders are). Once runs
  keep those versions, the room card for commands in the person's own chat can go; until then it stays.
- **Tests:** tests/unit/places-copy.test.ts (TC-f2-c02), tests/unit/step-labels-shell.test.ts.
- **Version impact:** patch (fewer cards and plainer words; no API or schema change).
