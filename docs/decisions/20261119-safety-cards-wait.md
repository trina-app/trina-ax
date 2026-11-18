# Safety cards wait as long as it takes; the call runs again with the answer

- Date: 2026-11-19
- Status: accepted
- Supersedes: the admin's wait (`ask_user_timeout_sec`) for the cards of delete, share, a website and a browser site in
  chats a person watches
- Branch: feat/safety-cards-wait (follow-up of docs/decisions/20261118-questions-wait-and-todo-card.md, QA TC-5005)

Plan: docs/AGENTS/plan/20261118-2325-safety-cards-wait.md.

- **Ask (owner, 11-19):** Claude Code has no time limit on its permission prompts; neither should ours.
- **Before:** the card waited inside its tool call (the engine idle on it) for the admin's time (10 minutes by default),
  then closed and the call went on as a no.
- **Rule:** the cards raised inside a call of delete_files, share_with_person, share_folder, stop_sharing, web_fetch,
  save_url or a browser tool, by the main AI, in a chat a person watches (a shared chat too), are kept in
  `open_questions` with the call (tool and arguments as the tool got them, keys already hidden; the desktop window of a
  browser card). The call ends having done nothing: each of these tools asks before it changes anything. The AI gets
  `{"waiting_for_user": true, note}` and ends its answer. The card has no time limit, shows after reloads and restarts,
  and keeps the chat's "waiting" mark (a browser card: its window only, as before).
- **The answer:** POST /api/turns/:id/answer, only by the person whose turn it was, with one of the card's buttons
  (typed text is no answer to a safety card, as before). It starts the next turn (the visible message is the button's
  words). Before its engine starts, that turn runs the saved call again exactly once, through the same handler as the
  engine's calls: the person as they are now (access lost meanwhile: refused, nothing done), the confidential lock,
  every check and card of the tool. The first card the call raises takes the saved answer when it is the same card
  (kind, words, rows and choices; the Always allow choice and the time limit do not count); a card that reads
  differently now (something changed) is asked again the same way. The AI gets each call's result with the message.
- **Exactly once:** the answer is recorded in one transaction (a second answer gets 409 and runs nothing), the call runs
  before the engine's attempts (a retry of the engine does not run it again), and the rows go when that turn starts. An
  answer given while the asking answer is still ending starts the turn at its end, a quarantined slot's release or
  after a restart (docs/decisions/20261118-questions-wait-and-todo-card.md).
- **Always allow:** stays final (owner rule): with it on, the call asks nobody, now or when it runs again; the person's
  Always allow on the waiting card is kept when the call runs again (the card's own withAlways path).
- **Not here:** connect_service. Its card is finished through /connect with a sealed key and a sign-in whose state (the
  connection the card made, a running connect, OAuth) lives with the running turn; it keeps its own wait. Slack
  questions and scheduled runs keep the wait inside the call. A sub-agent's call keeps the wait inside the call (only
  the main AI's call can end the answer).
- **Tests:** tests/unit/b-safety-cards-wait.test.ts (delete with a restart, buttons only, another person, two answers
  at once, access lost, "no"; share; website deny and allow), b-browser (a browser site card for its window only, the
  call again in that window). The tests of each card's own logic run with the wait inside the call
  (ChatRuntimeOptions.safetyCardsWait false in the harness), as a Slack question's card does.
- **Version impact:** minor.
