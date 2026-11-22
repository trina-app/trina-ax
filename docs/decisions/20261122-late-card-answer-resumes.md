# A late press on a card runs the waiting call as it was asked

- Date: 2026-11-22
- Status: accepted
- Supersedes: parts of [20261119-safety-cards-wait.md](20261119-safety-cards-wait.md) (which tools wait, what a no does,
  what a new message does to a waiting card)
- Branch: fix/late-card-answer-resumes (QA of #403)

Plan: docs/AGENTS/plan/20261122-1614-late-card-answer-resumes.md.

- **Ask (QA of #403, the owner angry about approving twice):** in a shared chat the share card waited after the answer
  ended; the person pressed it; the next turn ran the saved call again against its own user message, the button's
  words, which names no file: the share was refused and "항상 허용" was never kept. Answering a card at any time must
  run exactly the waiting call with its arguments and apply the choice, Always allow included; never become a
  free-text message that loses the target.
- **The asking turn:** a waiting call keeps the turn that asked for it (`open_questions.call_meta`, migration 444: its
  turn, user message and answer; a card re-raised while the call runs again keeps the first). While it runs again
  (`TurnExec.askedIn`, chat/asked-in.ts), the checks of "the asker's own message" (a file or recipient they named or
  attached, a share or post they asked for), "made in this answer" and the answer a post's text came from read the
  asking turn. Everything else is read as it is now: the person, access, files, people, switches.
- **Always reaches the card:** while a call runs again, the explicit-ask skips (share, post, stop sharing, a place the
  person named) and the room post's earlier yes in the chat do not apply: the run always reaches the card the press is
  checked against (`sameCard`). The person's own Always allow still goes without a card.
- **A no runs nothing:** a card answered with its no (the last option of every server card, a site's deny) or Skip is
  not run again; the AI is told the person said no.
- **Two cards:** a call with two cards (who to share with, then the share; the shared-connection card, then the write)
  keeps the answers its earlier cards took; each card is asked once.
- **Always allow:** the kind of the card's Always allow is kept with the call. A run whose card took the answer keeps it
  as before (withAlways); a run that ended before that card keeps the person's Always allow for that kind too, where
  it may be offered now. Not when the card reads differently now (it waits for that card).
- **Changed since the press:** a run whose card reads differently now (another person, file, reason or words) asks
  again, its first line "Something changed since you answered. Please check once more.", and that card waits the same
  way (one press). A card that only lost a reason line (rooms read here, a file someone shared, a target from the
  screen) is the same card: it asked more carefully when it was pressed.
- **More cards wait:** a connected service's tools (call_tool, api_request, each service tool; not connection_result
  or find_tools), post_to_room, change_project_members, change_folder_access, skill_files, move_skill, schedule_create
  and remember (each asks before it changes anything; audited). A post's first check in the run again takes no second
  share of the sending budget. Each tracked call has its own async context (AsyncLocalStorage), so a card of a call
  running beside it is never kept with it.
- **A new message keeps the card:** the person typed ("허용해") instead of pressing: the card stays, pressable, and the
  new turn's AI is told a card of its earlier call waits (`<waiting_card>`), to point to it and never to call the tool
  again for the same thing. A later press goes on from the chat's newest answer. The AI's own ask_user questions still
  close; an edit, a regenerate or another branch closes the card too (it went on without it).
- **Not here:** write, edit, make_file and the other file tools (their room, skill and wider-audience cards chain and
  keep per-answer state; they wait inside the call as before), connect_service, Slack questions, scheduled runs, a
  sub-agent's call, a call holding a stored secret.
- **Tests:** tests/unit/b-late-card-answer.test.ts; b-safety-cards-wait (a no runs nothing),
  b-shared-chat-opposite-requests (another person's safety card stays).
- **Version impact:** patch.
