# In a shared chat the AI gets the steps of other people's answers too

- Date: 2026-11-23
- Status: accepted
- Supersedes: the "Whose" rule in [20261122-chat-step-memory.md](20261122-chat-step-memory.md) for chats shared now
- Branch: fix/shared-chat-resume (the owner: "그래도 맥락은 다 알고 있지? 다른 사람들의 세션도? 그래야 일이 이어서 되지 최소한")

- **Ask:** when Bob goes on with work Alice's AI did in the same shared chat ("아까 만든 견적서 금액만 바꿔줘"), his
  turn must know what was made, where, with which tool and inputs, and what came out.
- **Rule:** in a chat shared now, the step record (#409) of every answer the asker sees goes with the history, also
  another person's: in a fresh session's history and in the `<since_your_last_answer>` block of a resumed one
  ([20261123-shared-chat-own-session.md](20261123-shared-chat-own-session.md)). Each person's sessions stay their own.
  - Another person's steps show their key arguments and result only for the team's own file tools that name team
    paths (read, list, glob, grep, write, edit, make_file, the PDF and HWP tools, zip, move, copy, rename, delete), and
    only when every path is one the asker and everyone who sees the chat may list. Everything else shows its name and
    how it ended only: a connection's, an app's (Aside) or the browser's step, a card's answer, a web address, a data
    query, a connection's long result. A post, a share or a stop shows its verb alone, as the app shows it to them.
  - The rules of the record hold for everyone's lines: a path only when the asker and everyone who sees the chat now
    may list it (so a read of Alice's own folder is a generic line for Bob), no content tool's result ever, secrets
    hidden, nothing of an answer hidden from the asker, no notes of an answer hidden from anyone who sees the chat now
    or from before the share.
  - Caps: 4 answers and 1,800 characters per other person, inside the 10 answers / 6,000 characters of all records.
  - A chat that is no longer shared: other people's steps stay theirs, as before.
  - A resumed session's read-scope check counts a person's own folder (or a named place) that only another person's
    answer record holds as theirs (their session holds it, never this one); a team folder, a room or Slack still counts.
  - Opposite requests (`prompt.ts` sharedSection, QA S-125): the AI asks which to keep only while the other person's
    request is still open. When it is done and the asker asks to change it ("아까 만든 견적서 금액만 바꿔줘"), the AI
    changes that same file and says in one line whose earlier version it replaced (kept in the file's history).
- **Tests:** `tests/unit/b-shared-chats.test.ts` (Bob's first turn names Alice's file and folder; the since block has
  her next file; never her own folder's path or content; Carol edits the file by that path),
  `tests/unit/b-step-record.test.ts` (both askers get both people's steps).
- **Version impact:** patch.
