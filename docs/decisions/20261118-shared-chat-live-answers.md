# Everyone in a shared chat sees the answer as it is written

- Date: 2026-11-18
- Status: accepted
- Supersedes: in [Shared project chats — 공유 프로젝트 채팅, phase 1](../DECISIONS.md) "Per viewer": "a running
  answer's live text … stay with the runner", "deltas and cards to the runner", and "Live answers for viewers" in
  "Not in phase 1"
- Branch: fix/chat-live-and-reload (QA TC-4961)

- **Ask:** in a team project's chat (or one shared with people) member A asks and the answer streams for A; member B,
  who has the same chat open, saw only "Thinking…" until the answer ended. B should see the same text as it is written.
- **Why it was so:** phase 1 sent a running answer's events (`message.delta`, `message.step`, `message.done`) only to
  the person whose turn it is, and the REST read gave everyone else a running answer with no text and no steps; the
  chat page read the messages again when the turn ended. Live answers for the others were left for later.
- **Rule, who gets it** (`server/src/chat/live-answer.ts`): everyone who sees the chat now (`Audiences.ofChat`, as
  `chat.updated`: a project's audience, or the creator and people of a chat shared with people; no guest but the
  chat's own) other than the asker, and only while the answer is not hidden from them (`messageView(...).withheld`,
  `chat/shared-answers.ts`: an answer that used the asker's own connection is hidden from someone who joined after it).
  Only people who saw the chat when the answer's first piece went out get it live: someone who starts seeing the chat
  meanwhile gets its end and the REST read, so nobody holds pieces of an answer that becomes hidden from them later (a
  connection card's audience they were not in; independent review). The list is worked out again at most every second,
  at once after the answer's read record changes (`TurnExec.noteSharedReads`), after every access change
  (`admin/folders.ts afterAccessChange`, `ChatRuntime.stopUserTurnsIn`) and when an account is turned off
  (`stopUserTurns`). A check that fails sends to nobody.
- **Rule, what they get:** a copy of the text of their own (`OthersText`): the asker's stream holds back only a short
  end for a stored secret's written forms, and an HTML entity form padded with zeros is longer than that (security
  review of #1311, reproduced). The others' copy stops at the last character no written form of a stored secret of the
  asker's is made of, with no length cap, and each part before it is redacted whole; past 64 KB held back nothing more
  goes to them live (the end brings the answer). Deltas are sent against what they already have, and a reset when text
  they have changes (a refused attempt's text dropped). Each step as the finished answer shows it to them
  (`ChatStore.viewSteps`: a line names its paths only when they may see them all; no step detail, no card's answer, no
  record of a post, a share or next steps), and at the end `message.done` with the message as the API gives it to them
  (`messageFor`: no usage, a failure's reason replaced, an answer hidden from them as its place alone). The REST read
  of a running answer gives them the same copy of the text (also from its last save when no turn runs), so a reload or
  a late open picks up where the events go on.
- **Rule, cost:** live events go only to people with a window open (`Hub.publishOpen`, each frame's data serialized once
  for all of them); the others read the chat over REST when they open it. The viewer list reads the chat's records once
  per refresh for all viewers (`AnswerSight`).
- **Rule, what stays the asker's:** cards (`turn.request`, the shared read card, the connection card, every other
  card) and their answers, queue positions, the busy line, notices, usage, a failure's reason, live artifacts (the
  others see an artifact when it is saved). Nothing of the asker's own connection is fetched before the asker's yes on
  its card (unchanged), so nothing of it can stream before then.
- **Known:**
  - The question itself still reaches the others by reading the messages when the turn starts (no `message.created`
    to them).
  - A refused attempt's text streams to them before its reset drops it, as it did for the asker.
  - Someone who loses access and gets it back while an answer runs keeps the text they had from before a card that
    their absence left them out of; the answer's end is then judged by its record as usual.
- **Tests:** `tests/unit/b-shared-chat-live.test.ts` (the text live and over REST, the end as bob sees it, nothing of
  alice's turn events; a step naming a place bob cannot see), `tests/security/shared-chat-live.test.ts` (alice's own
  connection before and after her card, its key, step details; a later joiner gets nothing of an answer built on her
  connection, live or over REST; someone who stops seeing the chat gets nothing more at once; people outside a project
  chat or a chat shared with people get nothing; a key written as zero-padded entities), `tests/unit/others-text.test.ts`, `tests/unit/b-shared-chats.test.ts` (updated), the e2e
  `web/test/e2e/shared-project-chats.spec.ts` (Bob sees the first half of Olga's answer while it runs).
- **Version impact:** minor (new behaviour in shared chats, no API shape change).
