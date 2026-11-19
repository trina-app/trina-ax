# The AI's questions wait as long as it takes; its to-do list is one card per answer

- Date: 2026-11-18
- Status: accepted
- Supersedes: the 10-minute wait of the AI's ask_user (setting `ask_user_timeout_sec`, chat/runtime.ts) for chats a
  person watches; the safety cards keep it
- Branch: feat/questions-wait-and-todo-card (QA TC-5005, TC-5007; limits audit items 15 and 19)

Plan: docs/AGENTS/plan/20261118-2200-questions-wait-and-todo-card.md.

- **Ask (owner, 11-19):** "Claude Code is the floor." Claude Code's AskUserQuestion waits for the answer as long as it
  takes; its TodoWrite keeps a checklist the person sees while the AI works.
- **What happened before:** ask_user waited inside the tool call. The turn gave its queue slot back meanwhile, but its
  engine process stayed up, idle on the call. After the admin's wait (default 10 minutes, at most 15, because Claude
  Code ends an MCP call after 30) the card closed by itself (`turn.request.closed`, reason `timeout`), the step said
  "Not answered", and the AI went on with `{"skipped": true}`: it guessed, or stopped. An answer after that got 409
  "This question was already answered or has expired."
- **Rule (questions):** in a chat a person watches (a web, desktop or phone turn), the main AI's ask_user saves its card
  (table `open_questions`, migration 423) and returns `{"asked": true, note}` at once; the note tells the AI to end its
  answer. The answer ends as usual: no slot, no engine is held. The card has no `expiresAt` and stays under that answer,
  listed by GET /api/chats/:id/requests from the database, so it survives a reload, another device and a server restart.
  The chat says it waits (`Chat.waiting`, the "?" marker and the card push), as for any open card.
- **The answer:** POST /api/turns/:id/answer (the card, or the message box, which already sends its text as the
  answer) starts the chat's next turn, as the person, from the asking answer: its user message is the answer (picked
  options by their labels, typed text as typed, "(Skipped the question)" for Skip), and its engine message starts with
  an `<answered_questions>` block naming each question with the answer as the card gave it (an option's value, or
  `"skipped": true`), what ask_user returned before. Claude resumes its session there (the session ends on the asking
  answer); Codex and the API engine get the history. Several questions of one answer: each answer is kept and the turn
  starts with the last one. The chat must take a message from the person at that moment (access, no other answer
  running, the budget, a shared chat's order of who waits); else the card stays open and the error says why. An answer
  given while the asking answer is still ending is kept in the database and the card closes only when the next turn has
  started: at that answer's end, when a quarantined slot is let go, or after start-up recovery (a restart in between),
  so no answer is lost.
- **Shared chats, a connected service's words:** a card's option labels are the AI's words from the asking answer. When
  that answer holds what a connected service returned (or what is not all known), it is hidden from people who join
  later and may not read it, so a picked option shows as "(Answered the AI's question)" in the message, not its label
  (typed text stays the person's own words). The engine note escapes `<` and `>`.
- **Closing:** any turn started in the chat closes its open questions (a message sent meanwhile, another person's turn in
  a shared chat, a regenerate or an edit): the conversation went on without them. The card is the asker's only, as
  before.
- **Kept inside the call:** the server's own safety cards (delete, share, save where more people see it, a browser or
  dev-environment site, connect_service): their answer decides what that same call does, so they keep the admin's
  wait (a follow-up PR gives them the same treatment). A question asked from Slack (its answer goes back to Slack
  from the same turn) and a scheduled run (nobody watches: skipped at once, as before) keep the old path too.
- **Shared chats:** the same flow (owner, 2026-11-19, item D: "in a shared chat everything is shared"). The card is
  listed for the asker only and only the asker may answer it (POST /answer checks the turn's and the question's
  person); the answer becomes the asker's message in the chat, which everyone there reads, like anything they type
  there. Before, a card's answer stayed in the asker's step. Another person's message in the chat closes the question,
  as any turn does.
- **Rule (to-do list):** a tool of ours, `todo_write { todos: [{ content, status: pending | in_progress | completed,
  activeForm? }] }`, the input of Claude Code's TodoWrite, on every engine (Claude Code, Codex, the API engine), in
  shared chats and for guests (it writes nothing but the AI's own words on its answer). Claude Code's own TodoWrite
  stays denied in the lockdown: with ours offered there under the same shape, Claude gets one to-do tool and the same
  card as the other engines; letting the built-in through would add a second list the server does not see. A call is
  no step line (as set_title): the first makes the answer's one to-do step (`Step.todos`), each later call replaces its
  list in place, and the step is kept with the answer. The web shows it as one checklist card under the steps (the
  answer cards' frame and rows), with each item's state: not started, in progress (its "doing" words while the answer
  runs), done (crossed out). A sub-agent has no todo_write (its list would replace the main one).
- **Why not a longer wait:** a longer wait inside the call still keeps an engine process up per waiting person, and
  Claude Code ends the call after 30 minutes anyway; ending the turn and resuming the session holds nothing.
- **Tests:** tests/unit/b-open-questions.test.ts (the card after the answer ends, nothing held, hours later, resume,
  several questions, a message sent meanwhile, Skip, after a restart, a scheduled run, the to-do card on Claude and
  Codex); the ask_user tests in b-chat, b-session-markers, b-shared-chats, b-chat-answer-push and b-chat-seen follow
  the new flow.
- **Version impact:** minor (a table, a tool, a card).
