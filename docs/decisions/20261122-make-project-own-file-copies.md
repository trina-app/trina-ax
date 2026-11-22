# Make it a project moves a copy of the sender's own file made from their own files and the conversation

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (narrows "It is not a copy of a team file" in
  [plan 20261121-0619 "Which files move"](../AGENTS/plan/20261121-0619-structure-polish.md))
- Branch: fix/sharing-sq-findings (QA TC-7046)

- **Ask:** a group conversation of three became a project. The AI had posted three files there for the owner
  (post_to_room). They stayed in the conversation "because not everyone here can see them", though all three people
  opened them, so the project missed the AI's files.
- **Rule:** a room file that is a copy (`origin = 'answer_copy'`, or an older row named in its message's kept scope)
  moves with "Make it a project" when all of these hold, besides the usual tests (every member sees the message, not
  download-only):
  - it is on its sender's own message (`author_kind = 'user'`, `author_id` = the file's sender);
  - the kept scope's `attached` entry for it names a path in the sender's own folder (`users/<sender>/…`);
  - the kept scope is complete (`unknown` false) and every source in it is the sender's own folder (`user` of the
    sender, or a `name` under `users/<sender>/`) or this same room.
  Any other copy stays (a team pick, a copy of a team folder's file, a file made from another room, a connection, a
  shared Drive or a team folder). The confirm says each reason in its own line: not everyone here can see them,
  copies from a folder (people added to the project later would get them), or download-only.
- **Why:** such a copy is the sender's own file that they chose to send to these people, on a card that showed the
  recipients and the files: the same as uploading it. A file made from a team folder or another place keeps the
  plan's reason: people added to the project later would get content they may not see. The room source is allowed
  because the conversation's files move with it and its people are the project's people.
- **Left out:** a copy made from a team folder everyone in the room can read (later project people may not); a chat
  file posted from a shared chat (not a team path).
- **Tests:** tests/unit/b-room-file-moves.test.ts "QA TC-7046 …" and the counts in "which files move".
- **Version impact:** patch.
