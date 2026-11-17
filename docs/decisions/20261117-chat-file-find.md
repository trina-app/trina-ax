# The AI's room search also matches the names of files people sent

- Date: 2026-11-17
- Status: accepted
- Supersedes: none (amends [내 AI 채팅에서 대화방 읽기](../DECISIONS.md#내-ai-채팅에서-대화방-읽기--the-ai-chat-reads-my-conversations-featchat-reads-rooms-2026-11-06): its search matched message text only)
- Branch: feat/chat-file-find (the owner, 2026-11-17)

- **Ask:** "can the AI find files from things I sent, or from my conversations, and answer with them?", e.g. "the
  business registration PDF I sent Kanghyun", "the account form I sent in the leads thread".
- **What was there:** `rooms` searched message text only. A file sent with no words, or with words that do not name it,
  was found only when the AI read the whole room (or thread) and the file was among the newest 50 messages it read.
- **Rule:** each `rooms` search word matches a message's text or the name of a file sent with it; a few file type words
  ("excel", "pdf", "word", "photo", and their Korean words) also match files of that type, "file"/"attachment" any
  file. New filters: `from_me` (the user's own messages), `with_person` (only the user's rooms that person is in now:
  their 1:1 chat, shared group chats and rooms), `files` (only messages with files). Each hit already listed its files
  with `file_id` and the hit's `room_id`; the result now says to read one with `room_file`. The grep hint's count
  (chat/room-hint.ts) counts file names too, without the type words.
- **What stays:** the same rooms (the person's own, not archived; a guest's AI has no `rooms`), the same messages
  (SEE_SQL: from their join on, no hidden answers, no previews, not deleted), the same per-room and total scan budget,
  limit and character cap. Every room a hit comes from joins the chat's read scope, so sharing that chat later warns as
  for a room read. The tools are still offered only in the person's own unshared chat (and to an AI app with
  `mcp:rooms`, which gets the same search). The audit line names no word, person, room or file. `with_person` narrows
  the person's rooms by their current members, which the person already sees in each room's member list; a name that
  is in none of them answers "nobody of that name is in a room with the user", the same as for a name nobody has.
- **Using a room file:** unchanged. Filling in, stamping or editing goes through a copy: `save_room_file` without
  `save_as` puts it in the person's own downloads with no card, then the file tools work on it. The tool text says so.
- **Left out:** searching inside the files' contents.
- **Tests:** tests/unit/b-chat-rooms-file-find.test.ts.
- **Version impact:** patch.
