# Files of a conversation nobody can open are removed 30 days after it closed

- Date: 2026-11-16
- Status: accepted
- Supersedes: "a purge is for later" for archived rooms in docs/DECISIONS.md (the room files entry, around line 8473)
- Branch: feat/archived-room-files-purge (the owner: "go similar to Slack, go"; plan "Files sent in conversations, like
  Slack", decision 9)

- **Ask:** a conversation is archived when the last person leaves a group chat, or when its group is deleted (a team
  conversation). Nobody can open an archived conversation and nothing brings one back (`archived_at` is only ever set;
  a re-created group gets a new conversation), yet its files stayed on the team's disk forever, in "Files in
  conversations" and in every backup.
- **Rule:** once a day (the rooms' one-minute tick, `RoomFiles.sweep`), the files of conversations archived more than
  30 days ago, and with no member (checked in the query, not assumed), are removed with their rows; then the
  conversation's empty folder. The messages stay ("messages are never removed"); nobody reads them. Slack removes a
  deleted channel's content at once; 30 days matches the set-aside folder (`.system/rooms-orphans/`), whose own 30-day
  purge now also runs daily, not only at start.
- **Guards:** nothing when the room files folder is not there (a share not mounted: rows would go while the bytes stay)
  or when the clock is earlier than the newest room file or archive. At most 2 s a run in batches of 500; a run cut
  short goes on at the next tick.
- **Not done:** moving the folder into the set-aside folder at archive time (the parent plan's idea): the rows would stay
  and every start would count them as missing. So for 30 days these files still count in "Files in conversations".
- **DMs are never archived** (an account that goes keeps its DM row), so a DM whose two people are both gone keeps its
  files; later, if wanted. Should DMs ever be archived, `openDm` must first stop reusing an archived row by `dm_key`.
- **Told where it happens:** deleting a group now says "Its conversation closes, and files sent there are removed after
  30 days." (the confirm and the AI's `group_delete` tool); Admin › System's help page says it too.
- **Tests:** `tests/unit/b-rooms-archived-purge.test.ts` (31 days: files and rows go, messages stay; 29 days and a live
  conversation keep theirs; once a day; an archived conversation that still has a member keeps its files; a clock
  behind; the set-aside batches from the daily tick).
- **Version impact:** patch, no migration.
