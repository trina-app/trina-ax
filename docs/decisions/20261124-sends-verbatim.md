# A send with no card carries exactly the person's words

- Date: 2026-11-24
- Status: accepted
- Supersedes: the "named sends" text rule of [20261123-do-then-undo.md](20261123-do-then-undo.md) in part (it checked the text only for own words)
- Branch: fix/sends-verbatim (QA of #502 on dev 2bfa9126; the release owner: the server-side check is the guard, the prompt alone is not enough)

- **Ask:** "운영공지 방에 @전체 공지 올려줘: 내일 회의 10시" went out as "@전체 공지: 내일(11월 25일) 회의는 오전 10시입니다." with no card. The AI's added facts went to everyone without the person seeing them.
- **Rule:** `post_to_room` skips its card for the person's own ask only when the text sent equals words they dictated, compared strictly. The comparison takes out the everyone mention and collapses whitespace. Spelling, numbers, punctuation and emoji count as they are. "Words they dictated" means a quoted stretch, what follows a colon, or the lines after the first. A text of nothing but links to the files that go also counts. Anything else goes on the card, with the text the AI wrote. A "don't" inside the dictated words is not the person taking the request back.
- **Prompt:** dictated words go as written, with nothing added; a file with no words goes as its link alone.
- **Unchanged:** the person's Always allow (rule A), and a card they already approved in the chat.
- **Undo:** names the room or the 1:1 chat's person; after a post that notified everyone it says the notices already went out.
- **Version impact:** patch.
