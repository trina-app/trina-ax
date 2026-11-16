# Files sent in conversations are one line on the storage card

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/room-files-storage-line (the owner: "go similar to Slack, go"; plan "Files sent in conversations, like
  Slack", phase P1)

- **Ask:** files sent in conversations are now up to 1 GB each ([20261116-room-file-limit-1gb](20261116-room-file-limit-1gb.md)),
  and a team's disk is small (about 80 GB on hosted Starter). Owners and admins could not tell how much of it those
  files take: they were inside "Team files".
- **Rule:** the storage card (Admin › System) shows **Files in conversations**: the bytes under `<team>/.system/rooms`,
  measured with the rest of the breakdown (5 minutes after a start, then hourly), as `StorageBreakdown.rooms`. "Team
  files" no longer includes them. The number takes in the pictures' small previews and the attach-sheet copies kept for
  a day, which live in the same folder.
- **One number, never split.** No row per person, per conversation or per file, and no file name: admins never see who
  talks to whom or what they send in conversations they are not in (Slack shows admins counts only, and private-channel
  counts only on Enterprise). In a team of three the number still shows that conversation files exist; those are the
  same bytes "Team files" showed before.
- **Left in Team files:** the files of AI chats (`.system/chat-files`) and the set-aside files of deleted chats and
  conversations (`chat-files-orphans`, `rooms-orphans`, kept 30 days and shown as the "kept" note, which now names Team
  files so it does not read as part of the new line). Files nobody can clean up do not belong in the number people are
  asked to bring down. Leftovers of the old location (`<data dir>/rooms`, moved at start by `rooms/files.ts`) count as
  "Server data".
- **Older server:** the field is optional; the card shows no line when it is absent, never a made-up 0.
- **Tests:** `tests/unit/g-storage.test.ts` (a file in `.system/rooms` counts in `rooms`, not in `team`; Other does not
  grow; the answer holds no room id), `web/test/unit/storage-lines.test.ts`, `web/test/e2e/admin.spec.ts`.
- **Version impact:** patch, no migration. "Team files" drops on update day by what conversations hold.
