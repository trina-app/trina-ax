# A new message closes the asker's own waiting approval cards as not done

- Date: 2026-11-28
- Status: accepted
- Supersedes: "A new message keeps the card" in [20261122-late-card-answer-resumes.md](20261122-late-card-answer-resumes.md);
  the open question "whether a teammate's message closes the question" in
  [20261124-shared-chat-card-steps.md](20261124-shared-chat-card-steps.md), for approval cards
- Branch: fix/stale-approval-cards (the owner, 11-28, a shared project chat: "답변 안하고 넘어가니깐 이게 그대로 있네?")

Plan: docs/AGENTS/plan/20261128-1850-stale-approval-cards.md.

- **Ask:** a Gmail send card was left unanswered and a new message typed ("다음 메일이야. …"). The card stayed open and
  pressable above the new turn, the chat row kept its "?", and the AI kept writing "위에 올려 둔 Gmail 카드 두 개는 모두
  취소해 주세요". A press by mistake, by the owner or any of the five people who see the chat, would have sent a mail
  nobody meant to send.
- **Like Claude Code:** typing a new message instead of answering a permission prompt rejects that tool call, and the
  message is the reply.
- **Rule:** the person's own new message, typed in an app they watch (web, desktop, phone), closes every approval card
  of theirs that waits in that chat after its answer ended (`open_questions` rows kept with a call: send at a connected
  service, write, edit, make_file, share, stop sharing, delete, a room post, project members, folder access, skill
  files, move skill, a schedule, remember, a website, a browser site), on the branch it goes on from
  (`closeChatQuestions` `movedOnBy`, ChatRuntime.createTurn). Cards of the same answer the person had pressed already go
  too: that answer's calls run only once all its cards are answered, so none of them ran.
  - The card closes in every window (`turn.request.closed`); its step under the asking answer stops waiting and says
    "답하지 않고 넘어가서 하지 않았어요" (`Step.outcome.end` `moved_on`; neutral words, since others in a shared chat see
    the step too); the "?" mark goes with the card.
  - The AI: the new turn's engine message has a `<cards_closed>` block, one line per call, each **declined** because
    the person moved on without answering, nothing of it done; the message is their reply. It is told never to ask the
    person to cancel, close or press those cards, and to call the tool again (a new card) if the message still wants it.
  - `<waiting_card>` (a card that stays: below) and the waiting call's own result (`CARD_LATER_NOTE`) no longer tell the
    AI to point at the card above; they say a card the person does not want closes by itself when they write again.
- **Shared chats:** only the asker's own message closes the asker's cards. Another person's message leaves them open
  and pressable for the asker (their consent is theirs alone; a teammate writing "next item" must not decline the
  asker's send, nor approve it). The others still learn only who the AI waits for (Chat.waitsFor: the latest turn's
  cards). The AI's own ask_user questions are unchanged: any turn still closes them, and a teammate's turn names the
  asker (`<closed_question>`): a question is about the conversation, which went on; an approval is one person's yes.
- **Not a moving on (the card stays):** a press of another card (its answer turn), a scheduled run, a question from
  Slack, a turn the server starts itself (drafts, merges, background jobs: `questionsWaitInCall`). An edit, a
  regenerate or another branch closes the card as before.
- **The race:** a press and a new message at the same moment. Both are one synchronous step on SQLite (recordAnswer and
  createTurn are transactions), so one wins whole: the press first starts its turn, which runs the call once, and the
  message is refused while it runs (409; the app keeps it waiting and sends it after); the message first deletes the
  card, and the press gets 409 "already answered" and runs nothing.
- **Approved and running:** a pressed card's call runs again in its own turn; no new message can start beside a running
  turn, so it is never cancelled. A card answered while its asking answer is still ending is kept until the next turn
  starts, and no message can start before that either.
- **Stop:** Stop ends a running answer, and the cards waiting inside it close as before (no answer). Stop on an idle
  chat does nothing to a waiting card; the person's next message closes it.
- **Left as they were:** cards that wait inside a running answer (connect_service's sign-in, a write over 1 MB, a
  sub-agent's call, a Slack or scheduled turn): the answer is still running, a typed message waits under it ("Choose
  above first") and the card has the admin's wait.
- **Card content:** a connector card's line whose value is an attached team file's handle (`team-file:<path>`, the
  attachment's content) names that file as the first line does, its name, size and place, never the handle
  (`handlesAsFiles`, connections/team-attach.ts). The exact call behind 자세히 is unchanged.
- **Tests:** tests/unit/b-late-card-answer.test.ts "a new message instead of a press" (closes as declined, the step and
  "?", a connector send, a shared chat, the race in three orders, a running approved call, Stop, who moves on);
  b-shared-chat-opposite-requests (another person's message keeps the card); c-integrations-attach (no handle on a line).
- **Version impact:** patch.
