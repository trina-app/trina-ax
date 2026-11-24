# A shared chat keeps each person's own engine session

- Date: 2026-11-23
- Status: accepted
- Supersedes: the resume rule in [20261122-chat-step-memory.md](20261122-chat-step-memory.md) "Not changed"
- Branch: fix/shared-chat-resume (the owner: "세션 그대로 가져가야할 것 같은데.. 지금 세션이 하나인것처럼 보이는데, 그게 안되니깐 너무 아이러니인데")

- **Ask:** a shared chat looks like one conversation, so the AI should continue it as one, as Claude Code does, also
  after a read some of its people cannot open. Protection comes from what each answer shows, never from dropping the
  session.
- **Cause:** Claude Code resumed its session in a shared chat only while the last answer was the asker's own
  (`stashWrittenBy`) and while everyone who sees the chat could open everything the chat had read
  (`scopeHiddenFromAudience`). After one read of a personal folder (the read card's yes) or a connection only some use,
  every later turn started fresh: the whole history again, no prompt cache, no tool results.
- **Rule:** one engine session per person per chat (Claude Code engine; Codex and the API engine start fresh as
  before).
  - The person's newest stashed turn in the chat (`turns.engine_session_blob`) is resumed while its answer is on the
    branch of the new message. What others wrote since comes with the message in `<since_your_last_answer>`, word for
    word as this person may see it (an answer hidden from them is a line in its place). More than the history window
    holds: a fresh session with the summary.
  - Never another person's session: it holds their steps, arguments and results, which #409 keeps from everyone but
    them. A stash keeps every person's newest session; a person whose access shrinks loses their sessions in every
    shared chat (`SESSION_CHATS_OF`).
  - The resumed answer's record carries what the session holds (the records of the person's answers in it): a
    connected service's result (k) as it was, so the answer stays hidden from people who join later and may not use
    it; a read a card's yes covered (y) as it was (the card said it stays for everyone who sees the chat, people added
    later included). A file the AI then wants to attach or change in such an answer is refused as a k answer's is, and
    the person's next answer starts fresh, without that session, so it can.
  - A fresh session, as before, when the chat read something no card's yes or k covered (a file read with no card, a
    room, Slack, ...) that someone who sees the chat now cannot open (they joined since, or lost access); when the
    session holds a place the person themselves can no longer open; when an answer in it is from before the cutover
    or the chat's share, has no record, or has an x group; when an answer hidden from the person was in it (should never
    happen: the rule only shows more).
- **Why per person, not one session for the chat:** one shared session would give bob's turn alice's tool calls and
  results (her connections' answers, her reads' full text), which no answer showed him and which #409 keeps out of
  his fresh sessions. Per person, each engine holds only what its person did and what they may see; the conversation
  still reads as one, because the others' words come with each message.
- **Not changed:** the read cards, the per-answer records and withheld check, the path and share guards, the step
  records (#409: the fallback when a resume fails or a fresh session starts).
- **Tests:** `tests/unit/b-shared-chats.test.ts` "engine sessions" (own session after another person's turn, another
  person's session never reaches a turn, the asker's own folder after the card's yes, k carried, a no-card read someone who joined cannot open, resets).
- **Version impact:** patch (a fix; no schema or API change).
- **Measured** (claude-code, Opus 5.5, same 6 turns, QA copy): see the PR. Before, a shared chat whose turn 2 read the
  asker's own folder started turns 3-6 fresh (about 17.5k cache-write tokens each instead of about 5k).
