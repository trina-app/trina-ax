# The save-where-more-people-can-see card: one question, the reason under the buttons, a formatted preview

- Date: 2026-11-17
- Status: accepted
- Supersedes: for the wider-audience card only, the card words of [The AI saves new content in My files unless a place
  is named](20261117-ai-save-my-files-default.md) ("This came from <source> (3 people). Save it to <place> (10 people,
  7 of them can't see where it came from)?", after the room card's reason line). Its facts, when the card asks, its
  buttons and Always allow stay.
- Branch: fix/save-card-plain (QA TC-4815)

- **Ask:** in a real-AI run the AI's save card in a side chat read, in Korean: "여기에 대화 메시지(다른 사람이 쓴 글)가
  들어와서, 무언가를 바꾸기 전에 먼저 물어봐요. 이 내용은 '라마바카페 건' 대화의 메시지(3명)에서 왔어요. 부서 › 영업 ›
  회의록 › …md(4명, 그중 1명은 나온 곳을 볼 수 없음)에 저장할까요?", then rows "하는 일: 파일 저장", the file's place
  again, "바뀔 내용 564자", and a preview with raw `**`. [The send-to-room card](20261117-send-to-room-card-two-buttons.md)
  had the same weight and was slimmed; this card gets the same treatment.
- **Rule (the card's words):**
  - The question: "Save to <place> (4 people)?" (`widenConfirm`), then, whenever anyone there cannot see a source
    (`WidenNeed.blind`, as before), "1 of them can't see the chat it came from." (`widenBlindChat`, when every source is
    a conversation the person sees: a room, a chat, Slack) or "…can't see where it came from." (`widenBlind`, any other
    source, or one opened by someone else in a shared chat). ko: "부서 › 영업 › 회의록 › x.md(4명)에 저장할까요? 그중
    1명은 원래 대화를 못 봐요."
  - A second line names each source with how many people can see it (`widenFrom` / `widenFromYou`, unchanged): "It came
    from messages of the conversation 'Lamaba cafe' (3 people)." (`widenSource`).
  - The facts are the same as before: source and its count, place and its count, how many at the place cannot see the
    source. Nothing is said that the old card did not say.
- **Rule (the reason line):** "Messages from your conversations (other people's words) came in here, so changes are
  asked first" (and its shared-file variant, `seenWhy`) moves from before the question to the small line under the
  buttons (the card's `note`, before the Always allow note: `askAlways` now keeps a card's own note beside it). It is
  left out when every room this chat read is its side chat's own room, by the same server check as the send-to-room
  card (`grant-reads.ts roomsReadOnly`, with `read-rooms.ts quotesOnlyFrom`), and never left out in a shared chat or a
  chat others write in. Only the words depend on this: the card shows exactly when it showed before.
- **Rule (what it saves):** the rows of the room card (`roomCardDetails`) lose the Action row ("Save": the question says
  it) and a File row that names the same place as the question; other rows stay (a source, a template, a save-as name
  that differs). No character count (`noSize`). The text of a whole file written (`write`, `make_file`) is formatted
  with the chat's Markdown renderer (`ConfirmDetail.markdown`), under the send-to-room card's rule, now one helper
  (`share-words.ts formatsSafely`): plain when the text has a web address, a long random-looking part, `](` or an
  autolink `<…>`, and always plain for an instruction file (a planted instruction stays exactly as written). Edits
  (`old → new`) stay plain.
- **Not changed:** when the card shows, its Save / Always allow / Don't save buttons, the Always allow kinds
  (`save_wider`, `room_change`), the per-chat approval, the grants and the refusal the AI reads.
- **Left out:** the skill save card (`confirmSkillWrite`): it is its own component (a `SkillWritePreview` with a diff) on
  its own path, and its `skillWiden` line keeps PR #1232's words.
- **Why:** the owner's rule for cards is fewer and plainer words (lean UI = remove, not add); office workers read one
  question and the facts that matter.
- **Tests:** `tests/unit/b-ai-save-place.test.ts` ("the card in fewer words (QA TC-4815)": the same-room side chat has no
  reason line, another room keeps it under the buttons, links stay plain; the words in six languages),
  `tests/unit/b-chat-rooms.test.ts`, `tests/unit/b-skill-save-one-card.test.ts`, `tests/unit/plural-counts.test.ts`.
- **Version impact:** patch (the same card with fewer words).
