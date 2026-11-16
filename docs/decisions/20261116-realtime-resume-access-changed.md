# A second clear of the replay buffer in one request keeps the loss notices the first one published

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (keeps the archive's "권한이 바뀌면 그 사람의 이어받기 버퍼를 버린다" working with team rooms)
- Branch: fix/realtime-resume-access-changed (QA TC-3837)

- **Rule:** when one request clears a person's replay buffer a second time (afterAccessChange, then the rooms' sync
  for the team room of the group they left), the second clear keeps the events since the first clear that only tell the
  window what it lost (`access_changed`, `room.updated removed`, `chat.updated deleted`) when they are the newest
  events, so a window that saw everything before the change resumes with the notice and not with `resync`; the known
  limit is that any other event published in between (for example a turn of theirs stopped by the change) still makes
  that window resync, which is safe because it reloads over REST.
