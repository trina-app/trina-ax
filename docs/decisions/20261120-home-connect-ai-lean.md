# Home without AI: one line under the greeting, one button

- Date: 2026-11-20
- Status: accepted
- Supersedes: Home's no-AI card in [Y — Home shows one thing at a time](../DECISIONS.md#y--home-shows-one-thing-at-a-time-featonboarding-y-2026-11-04) (the card at the top of Home)
- Branch: fix/home-connect-ai-lean (the owner, QA TC-5447)

- **Ask:** The owner called Home's no-AI card "garbage": a framed box on top of the page, a heading and a reason line, then three
half-width buttons (a full accent "Claude 구독 연결 · 추천" and two bordered ones) leaving the right half empty, and the
loud button fighting the greeting. References: Claude.ai, ChatGPT and Cursor/Raycast first-run states show the box
and one way to sign in, not a menu of every provider. Placement: Team AX core (`web/src/components/onboarding/ConnectAi.tsx`
NoAiCard, `web/src/pages/Home.tsx`, `web/src/components/chat/Composer.tsx` `blocked`).

- **One quiet line under the greeting, right over the box**, no frame and no heading; the greeting stays the hero. On a
  computer the line and its actions sit in one row; on a phone the line, then the actions under it, centred in the
  middle of the screen with the box docked at the bottom as before.
- **The owner and admins: one button.** "AI를 연결하면 바로 시작할 수 있어요." [Claude 연결하기] 다른 방법 ⌄. The menu
  holds the team's other ways (ChatGPT 구독 연결, API 키로 연결); each opens the same simple dialog as before. A team
  that does not share subscriptions gets its first way (the API keys) as the button and no menu. Removed: the heading
  "AI를 먼저 연결해 주세요", the reason line, the "추천" tag, the stack of three buttons and the card's frame.
- **A member: "아직 쓸 수 있는 AI가 없어요."** [팀장·관리자에게 연결 요청하기] (one notice per owner and admin, as
  before, then "알렸어요"), and where the team allows personal connections a quiet "내 AI 연결하기" beside it. There is
  no separate "the team has AI but you must sign in yourself" state on the server (`aiAccessFor`: `connect_team`,
  `connect_own`, `ask_owner`), so these two cover it.
- **A guest: unchanged.** Home shows a guest none of the team's cards; a guest whose AI is off sees `GuestNoAi` in place
  of the box.
- **Typed anyway: not sent.** While nothing answers the person, Home's box keeps the text unsent and, once something is
  typed, says under the box "AI를 연결해야 보낼 수 있어요. 쓴 글은 그대로 둘게요." (a member: "AI가 연결되면 보낼 수
  있어요. …"). Before, the message made a chat that failed at once.
- The welcome step's AI step (ConnectAiPanel, the three ways at once) and the "AI 연결" dialog are unchanged.
