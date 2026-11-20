# My setup ("내 설정"): one personal card on Home for everyone, the owner included

- Date: 2026-11-20
- Status: accepted
- Supersedes: in part [A welcome for invited people](../DECISIONS.md#a-welcome-for-invited-people--초대받은-사람의-첫-5분-featmember-welcome-2026-11-11-product-owner) (who gets the card, its rows) and [Y — Home shows one thing at a time](../DECISIONS.md#y--home-shows-one-thing-at-a-time-featonboarding-y-2026-11-04) (the owner's order on a computer)
- Branch: feat/my-setup-card (the owner, 2026-11-20: spec approved)

- **Ask:** after the team setup the owner had nothing personal to do, and invited people had a card without their own
  tools. One personal card for everyone.
- **Home's top, one card at a time (owner):** the team setup unfinished → its "설정 이어서 하기" row, on a computer too
  (the list panel's setup row hides on Home then, so there is one way back on screen); finished → the owner's My setup
  card; that card done or hidden → the 7-day goal. A member who joins sees My setup first, as before. While no AI
  answers the owner, the no-AI line comes before the owner's card (the card has no AI row).
- **The owner's card:** the server makes it when the team setup reaches its end screen (welcome.ts, both ways the steps
  finish: `member_welcome.setup = 1`, migration 428, via 'invite' with no inviter because the CHECK has no other value;
  only via 'admin' is read elsewhere). Its 14 days count from then. An owner who finished before this release gets none.
  Its rows: 내 도구 연결, 사진 (optional), this computer's files (optional). Title "Now your own setup, {name}", the line
  "The team is set up. These are just for you.", and "Only you see this" in place of a count (one counted row).
- **A member's card:** 내 도구 연결, 인사하기, 사진, Trina에게 묻기 (or 내 AI 연결 while no AI answers them), the
  files row. "Get started · n of 3" counts tools, hi and asked.
- **내 도구 연결:** the team's recommended tools first (TeamSettings.memberTools, read from GET /api/integrations,
  the decision of PR #93, branch fix/welcome-tools-personal-wording; this branch adds the optional field to the contract so it
  passes through once the server sends it), then Google Drive, Gmail, Google Calendar and Notion, at most four. A member
  sees only tools that are on for members; owners and admins see every tool. Left out: what this server cannot connect
  for the person. Each has its own [연결] with the person's own account: a listed service connects in place (the
  welcome tools step's flow), a Google tool opens its page in Settings › Connectors (its own sign-in and account
  check). A tool the team connected for everyone says "팀 연결됨" with no button. Done (server) once the person has a
  working connection of their own (a personal connection or Google Drive); a team where personal connections are off
  is not held back by it. "More tools" opens Settings › Connectors.
- **Merged:** "이 컴퓨터 파일 가져오기" (desktop app) and "데스크톱 앱 열기" (a Mac or Windows browser, /open-app) are one
  row by where the card is seen; the rooms row is one line under the title (a link to Chats); "팀 파일 정리하기" moved to
  Admin › Home (`organizeFiles` at the top of the answer, card or not).
- **When it goes:** required rows done → "준비 끝" for 5 seconds (Close sooner), then gone (the server lets it go after
  ALL_SET_MS); Hide; 14 days. Hidden while its days last and not done: Settings › Profile "Show my setup on Home again"
  (PATCH /api/me/welcome `{ show: true }`, answer `hidden`).
- **Left out:** a card for owners whose setup finished before this; Drive's sign-in inline on Home; a server check of
  what is offered (the client decides the list; the server counts any own connection).
- Tests: tests/unit/b-member-welcome.test.ts, web/test/unit/member-welcome.test.tsx, web/test/unit/my-tools.test.ts,
  web/test/unit/home-no-ai.test.tsx, web/test/e2e/my-setup-card.spec.ts.
- Version impact: **minor** (a new card for owners, a new row, an additive migration).
