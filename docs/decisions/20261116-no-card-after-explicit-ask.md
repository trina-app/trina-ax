# No card right after an explicit ask

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (narrows "post_to_room: the AI posts to a room behind one card" ("always one card"), "A member
  shares their own files" and the connector write card of "Always allow on every card" for one case: the person's own
  message of this turn asked for exactly that action)
- Branch: fix/no-card-after-explicit-ask (QA TC-3812; stacked on fix/always-allow-more-cards)

The AI flow check of 2026-11-16 (tests/ai-scenarios) found cards right after the person had plainly asked for that
action: "Share 1 file with 최하나?" after "거래처 목록 CSV 최하나님한테 공유해줘" (FL-02), the room post after "방에 올려줘"
in the room's side chat (FL-09), every first write to a connected service after "고쳐줘 / 추가해줘 / 바꿔줘" (FL-19,
FL-24, FL-25, FL-26). Claude's own apps do not ask again for what was just asked.

**The rule** (server, deterministic, no model call; chat/shared-actions.ts): the asker's own message of this turn, its
quoted lines left out (a quote is someone else's words), must hold the action's verb and its target in the person's
words. Never in a scheduled run (its message is the task's text), a message the app sent for them, or a Slack question.
When unsure, the card stays. Cards that protect against other people's content stay: whenever the target, recipient or
content may have been chosen by someone else's text, the person's words do not hold it and the rule does not apply.

| Card | After an explicit ask | Why |
|---|---|---|
| share_with_person ("최하나님에게 파일 1개를 공유할까요?") | **skipped** when the message has a share word (공유, share, bagikan, 共有…), names every person or group (namesRecipient) and every file (its name, or a Hangul name without separators: "거래처 목록" for 거래처-목록.csv) or attached it | who gets which file is the person's own words; nothing else the card says |
| post_to_room, text only ("라마바카페 건(3명)에 보낼까요?") | **skipped** when the message has a post word (올려, 보내, 전달, post, send…) and names the place, or in a room's side chat gives no place (that room), and the card would have no line about people who cannot see a source or open a file | the place is theirs; with no such line everyone there may see everything the post used |
| post_to_room with "1명은 … 볼 수 없어요" lines, or the files choice | stays | it tells the person something they could not know (who would miss what), and the files choice is theirs |
| Connector write ("AI가 Notion에 이 내용을 보내려고 해요") | **skipped** when the message has a change word (바꿔, 고쳐, 추가, 만들, 달아, 옮겨, update, add, set…) and every value the call writes is in their words (a number also by its digits), recipient-like values (to, cc, channel, email, url…) included; a place inside the service (a row, page, issue, cell id, a small number) may come from the service; at least one written value must be theirs | then what goes out is exactly what they wrote: nothing another person's text (a page, a mail, a planted file) could have added. Only service tools, never api_request, never a tool whose name deletes, removes, archives or cancels |
| Connector write whose text the AI wrote (a new page from a summary, a mail draft, "이걸로 보내줘") | stays | the content is the AI's, which outside content may have shaped |
| Room change card after a room read ("여기에 대화 메시지가 들어와서…") | stays here (an explicit save of a new, non-widening file is fix/room-link-save-one-prompt) | it is the room-injection guard; Always allow ends it |
| Fewer-people-can-see save ("볼 수 있는 사람이 더 적은 내용을 읽은 뒤 … 저장할까요?"), shared read | stays | widening: tells who more would see it |
| Team skill save ("팀 스킬/규칙으로 저장할까요?") | not changed here | another branch merges it into one card (TC-3813) |
| Delete to trash, move/copy that changes who sees, project members, AI video (credits), big download, remember | stays | destructive, costly or access-changing; Always allow ends each |
| Web address cards | stays | covered by Always allow / Allow all websites and fix/room-link-save-one-prompt |

**Tests:** tests/unit/explicit-ask.test.ts (the verbs, file names, writtenByAsker with the flows' real writes and the
cases that keep the card), b-share-with-person.test.ts, b-post-to-room.test.ts. The fake engine's directives in those
tests are spelled as JSON escapes so only the words the test writes count as the person's.
