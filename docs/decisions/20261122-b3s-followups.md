# A page restore tells the chat as a file restore does; one card per thing an answer makes after a room read

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (amends [20261122-ask-less-side-chat-runs.md](20261122-ask-less-side-chat-runs.md) rule 3's words
  and adds a repeat-command rule; extends [20261122-qa-ux-followups-1122.md](20261122-qa-ux-followups-1122.md) to pages)
- Branch: fix/b3s-followups (batch 3 smoke, QA S-033, S-110 TC-b3s-23, S-120, TC-b3s-8/16/17; plan
  docs/AGENTS/plan/20261122-1437-b3s-followups.md)

- **Ask:** a web page's "Restore this version" ran at once with a toast only, while a chat file's restore asks, writes a
  line and shows live. One "make the banner text bigger" in a ✦ side chat asked four times, twice with "그림 파일을
  만드는 명령 실행: banner.png".
- **Page restore.** The chat file panel's confirm (components/chat/restoreConfirm.ts, shared by both panels): the version,
  whose later versions drop out (by who asked for them), who in the chat will see the change. The server writes the
  chat's line in `chat_file_events` (kind `restored`, `file_id` = `page:` + the new version's id, `version` = the one
  brought back; no migration, an older build skips the id) and GET …/audience `events` reads it as the page's title,
  only for a viewer who sees that version (Artifacts.hiddenVersions). The chat page reads its lines again on each new
  page version, so the others see the line with the new version (artifact.updated).
- **One card per target in an answer after a room read** (#381's rule, docs/decisions/20261122-ask-less.md):
  - a dev-environment command goes on under an earlier command's [이번만 허용] of the same answer when every file it
    makes (its output names as written, and its `cd` targets) is one that command was allowed to make, and it removes,
    moves, copies, links, installs, downloads, reaches the network and names an instruction file nothing (by its words,
    as the card reads them; chat/turn.ts answerShellOutputs). The first command after a room read still asks (owner
    11-22). A "no" covers nothing; a new answer asks again.
  - renaming in its folder a file this answer made (nobody changed it since) needs no card; the yes or cover that put it
    there stands for its name. Not to an instruction, script or hidden name.
  - Both steps say "이번만 허용으로 진행".
- **Words.** The command card says what happens: "그림 파일 banner.png 만들기" ("Make the picture file banner.png"), the
  command behind 자세히 as before.
- **Room posts by the AI (S-120): unchanged.** An AI post is the person's own message (rooms.send): each member gets the
  same notice as for that person's own message, by their level for the room; Activity lists mentions and followed
  threads only, for both (rooms/inbox.ts LISTED_SQL). Pinned by a test; listing every room message in Activity is not
  done (noise).
- **Small:** Korean particles after numbers and file names (shared ko-particle.ts reads an extension); a glob step shows
  the folder and file kind, never the pattern; the English side chat room button "Send to chat".
- **Why:** owner rules: Claude Code is the floor, lean screens, plain words for non-developers; QA b3s.
- **Left out:** page slugs in step lines; versions for dev-box changes in the person's own folder (the owner's follow-up).
- **Tests:** tests/unit/c-artifact-versions.test.ts, tests/unit/places-copy.test.ts, tests/unit/step-labels-shell.test.ts,
  tests/unit/ko-particle.test.ts, tests/unit/b-post-to-room.test.ts, web/test/unit/restore-confirm.test.tsx.
- **Version impact:** patch.
