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
quoted lines left out (a quote is someone else's words), must hold the action's verb in its request form (공유해줘,
올려줘, 보내줘, 바꿔줘, 추가해줘, share … with, post, update…; not "알려줘", "보여줘", "보내준 파일") with no "don't"
(-지 마, -지 말, -지 않, don't, never), and its target in the person's words: a person or room by its full name or username,
never a part of it ("파일 하나" is not 최하나). Never in a scheduled run (its message is the task's text), a message the app sent for them, or a Slack question.
When unsure, the card stays. Cards that protect against other people's content stay: whenever the target, recipient or
content may have been chosen by someone else's text, the person's words do not hold it and the rule does not apply.

| Card | After an explicit ask | Why |
|---|---|---|
| share_with_person ("최하나님에게 파일 1개를 공유할까요?") | **skipped** when the message has a share word (공유, share, bagikan, 共有…), names every person or group (namesRecipient) and every file (its name, or a Hangul name without separators: "거래처 목록" for 거래처-목록.csv) or attached it | who gets which file is the person's own words; nothing else the card says |
| post_to_room, text only ("라마바카페 건(3명)에 보낼까요?") | **skipped** when the message asks to post (올려줘, 보내줘, 전달해줘, post it/this/to…, send … to) and, in a room's side chat, gives no place (that room, no thread the AI chose), or elsewhere names the place in full in a chat that read no room; the card would have no line about people who cannot see a source or open a file; no note unless the person wrote it; not in a chat others write in (unless own words that are exactly theirs) | the place and the note are theirs; with no such line everyone there may see everything the post used. After a room read only the side chat's own room counts: a room message must not pick where the person's post goes |
| post_to_room with "1명은 … 볼 수 없어요" lines, or the files choice | stays | it tells the person something they could not know (who would miss what), and the files choice is theirs |
| Connector write ("AI가 Notion에 이 내용을 보내려고 해요") | **skipped** when the message has a change word (바꿔, 고쳐, 추가, 만들, 달아, 옮겨, update, add, set…) and every value the call writes is in their words (a number also by its digits), recipient-like values (to, cc, channel, email, url…) included; a place inside the service (a row, page, issue, cell id, a small number) may come from the service; at least one written value must be theirs | then what goes out is exactly what they wrote: nothing another person's text (a page, a mail, a planted file) could have added. Only a service tool whose name adds or changes content (update, create, add, append, set, edit, replace, comment…) and says nothing of sending, sharing, publishing, merging, moving, closing or deleting; never api_request. Recipient-like keys (to, recipient, channel, chat, user, member, owner, folder, parent, url…) and everything inside them must be in their words; an id may come from the service only under a place key (row, page, issue, cell…), never an address; nothing empty or null |
| Connector write whose text the AI wrote (a new page from a summary, a mail draft, "이걸로 보내줘") | stays | the content is the AI's, which outside content may have shaped |
| Room change card after a room read ("여기에 대화 메시지가 들어와서…") | stays here (an explicit save of a new, non-widening file is fix/room-link-save-one-prompt) | it is the room-injection guard; Always allow ends it |
| Fewer-people-can-see save ("볼 수 있는 사람이 더 적은 내용을 읽은 뒤 … 저장할까요?"), shared read | stays | widening: tells who more would see it |
| Team skill save ("팀 스킬/규칙으로 저장할까요?") | not changed here | another branch merges it into one card (TC-3813) |
| Delete to trash, move/copy that changes who sees, project members, AI video (credits), big download, remember | stays | destructive, costly or access-changing; Always allow ends each |
| Web address cards | stays | covered by Always allow / Allow all websites and fix/room-link-save-one-prompt |

**Content written by others (added in the batch, changed after the second review):** for a share, a post to a
conversation and a team file attached to a send, the rule applies only in a chat with nobody else's words in it. In a
shared chat, a chat others wrote in, a chat that read a room (a room's side chat too), or one that read content someone
else wrote (a teammate's file, a file shared with the person, a web page, a connected service), those cards always show:
this rule does not skip them (docs/decisions/20261116-always-allow-more-cards.md "Second review"), nor the connector
write card there (TurnPerson.othersWords). **Always allow is final (owner decision 2026-11-13); the guards apply only where the person hasn't chosen Always allow.** This rule is our own text match, not the person's
choice, so where other people's words are in the chat it never removes a card; a person who chose "Always allow" gets
no card there by their own choice (docs/decisions/20261116-always-allow-final-rule-a.md).
Matching which words of a message name a recipient cannot be made safe against a name or a text someone else chose, so
it only removes cards where the worst case is the person's own words. A quoted line names neither a file nor a person.

**Review (Opus):** two must-fix (read-like verbs and refusals counted as asks, so "새 소식 알려줘" plus a planted room message posted with no card; an AI note posted as the person's words) and the should-fix items (an allowlist of tools, wider recipient keys, empty/null/small numbers, one-letter matches, given names, an AI-chosen thread) are in.

**Tests:** tests/unit/explicit-ask.test.ts (the verbs, file names, writtenByAsker with the flows' real writes and the
cases that keep the card), b-share-with-person.test.ts, b-post-to-room.test.ts. The fake engine's directives in those
tests are spelled as JSON escapes so only the words the test writes count as the person's.
