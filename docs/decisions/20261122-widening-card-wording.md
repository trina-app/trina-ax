# The save-where-more-people-can-see card: the question first, a short place, one line why

- Date: 2026-11-22
- Status: accepted
- Supersedes: for the wider-audience card only, the card words of [The save-where-more-people-can-see card: one
  question, the reason under the buttons, a formatted preview](20261117-save-card-plain.md). When the card shows, its
  facts, its buttons, Always allow and the per-chat approval stay as that decision and
  [20261116-folder-share-widening.md](20261116-folder-share-widening.md) say.
- Branch: fix/widening-card-wording

- **Ask:** the owner (2026-11-22, a project chat with 2 people) saw "Save to Projects › 테스트 프로젝트 › 트리숲_소개자료 ›
  … › svg_output › 06_contact.svg (2 people)? 1 of them can't see where it came from. It came from a place someone else
  opened in this chat." and asked "이게 뭘 물어보는거임?".
- **Rule (the words):**
  - The question first, the place by a short name: "Save 06_contact.svg to 테스트 프로젝트, where 2 people can see it?"
    (`widenConfirm`; ko "테스트 프로젝트에 06_contact.svg 저장할까요? 2명이 볼 수 있는 곳이에요."). The short name is the
    file's name and its area (`TurnExec.shortPlace`): a project or group by its folder name, "My files", someone's
    folder ("Bob's folder"), a top folder in words, or the top of the team folder. The whole place in words
    (place-words.ts) shows on hover over the file's name (`AskUserRequest.placeTip`).
  - Then one line why: "Trina made it from <sources>, which 1 of them can't open." (`widenWhy`; `widenWhyChat` "…can't
    see." when every source is a conversation the person sees). A source the person answering cannot see is never named:
    it reads "a place only some people here can open" (`widenSourceHidden`), and when no source is theirs to see, the
    line is "Trina made it from a place 1 of them can't open." (`widenWhyHidden`). When nobody there misses a source:
    "Trina made it from <sources>." (`widenWhyAll`).
  - The per-source counts ("(3 people)", "(only you)") are left off this card; the skill card's `skillWiden` line keeps
    them.
  - Buttons unchanged: Save / Always allow / Don't save. The Always allow line of this card (kind `save_wider`) is
    shorter and still says it holds after reading files or web pages (`cardAlwaysNoteSaveWider`). The combined room card
    (kind `room_change`) keeps the general line, since its Always allow covers room changes too.
- **Not changed:** when the card shows, who counts as unable to see (`WidenNeed.blind`), the hidden-source check
  (`seesSource`), the refusal the AI reads (it still names the sources the server's way).
- **Tests:** `tests/unit/b-ai-save-place.test.ts`, `b-chat-rooms.test.ts`, `b-skill-save-one-card.test.ts`,
  `b-shared-chat-trash.test.ts` (a hidden source is not named), `plural-counts.test.ts`,
  `web/test/unit/ask-card-confirm.test.tsx` (the hover), `web/test/e2e/chat.spec.ts` (the mock's `widenask` card).
- **Version impact:** patch (the same card in plainer words).
