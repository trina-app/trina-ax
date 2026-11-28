# A personal My setup card for every new owner and admin, from day one

- Date: 2026-11-28
- Status: accepted
- Supersedes: in part [My setup: one personal card on Home for everyone](20261120-my-setup-card.md) (who gets the owner card and when, its rows and count, Home's owner order: the setup's row moves into the card, the owner card shows without AI) and the handover line of `transferOwnership` (the new owner's card)
- Branch: feat/owner-personal-onboarding (the owner, 2026-11-28: "관리자는 개인 온보딩이 없나?", asked twice; plan
  [20261128-0540-owner-personal-onboarding.md](../AGENTS/plan/20261128-0540-owner-personal-onboarding.md), approved
  "검수 끝나면 ㄱㄱ" with every reviewed recommendation)

- **Ask:** the personal card reached an owner only when the team setup ended. An owner who left the setup unfinished,
  a server we set up for a customer (POST /api/setup, the row never opened), a server made with `account
  create-owner`, a new owner by handover and an admin made later had no personal onboarding at all.
- **Who gets a late card** (`ensureOwnCard`, server/src/onboarding/member-welcome.ts; it replaces `backfillOwner`): an
  active owner or admin, not a guest, whose account is at most 30 days old (`LATE_CARD_DAYS`) and who **never had a
  connection of their own, in any state** (a personal connection or Google Drive there now, connected or not, or one
  made and ended since, read from the audit log: a disconnect deletes the row), on a team that lets people connect
  their own and that is no demo (the demo company's people and a free-roam instance keep the demo's screen). Only when
  they have no welcome row, or only the hidden member row of an owner (the handover's hide). Members keep theirs from
  the join.
- **What and when:** an owner gets the owner card (`setup = 1`), an admin a member card (no inviter). It is made on the
  first read of the card (GET /api/me/welcome: Home, Settings › Profile, Admin › Home), on any device: one
  `INSERT … ON CONFLICT DO NOTHING`, so two devices make one row. Its 14 days count from that write, not from the
  account's creation. It sets `apps_seen_at` with it: a late card holds no connection template notices. A hidden,
  finished or outlived card is never made again.
- **The setup's end restarts an open owner card's days** (my-setup.ts `startMySetup`): a card neither done nor hidden
  gets `joined_at` = the end, its rows kept, so a slow setup still has 14 days of the card after it. A done or hidden
  card stays as it is.
- **A new owner by handover:** `transferOwnership` calls `ensureOwnCard` after the commit: the hidden member row
  becomes a fresh owner card within 30 days and with no own connection ever; otherwise it stays hidden, as before.
- **The owner card while the team setup is open (changes the 11-20 order "team setup first, then My setup"):** it
  shows from day one, with the setup's way back as its first row: "팀 설정 이어서 하기 · n/5" (en "Continue team setup"),
  "팀 설정 시작하기 · 1/5" when no step was taken yet (a setup made for them and never opened), or "남은 일: …" with one
  step left; on a phone with only 내 스킬 left, "팀 설정은 컴퓨터에서 이어서 해요" with no button. The row hides while no
  AI answers. Title "{name}님, 시작해 볼까요" and the line "여기는 나만을 위한 설정이에요." while it is open; "이제 {name}님
  차례예요" and "팀 설정은 끝났어요. …" once it is over. The answer's `setupOpen` (owner role only: an ex-owner, now an
  admin, keeping an owner card is never held by steps they cannot open) says it is open.
- **The owner's rows:** 내 도구 연결 and Trina에게 묻기 counted ("시작하기 · 필수 2개 중 n개", replacing "나만 보여요"),
  photo and files optional, no "팀에 인사하기". All set only once both are done **and** the setup is over; both done
  while it is open: "내 설정은 다 했어요 · 팀 설정이 남았어요".
- **No AI:** for anyone who can connect it (the owner, an admin) the ask row becomes the AI row and goes **first**:
  "AI를 연결하면 {ai}가 바로 도와줄 수 있어요" with Home's no-AI buttons ("Claude 연결하기", other ways under "다른
  방법"); one's own AI keeps "내 AI를 연결하면 …". A member keeps "Tell {owner}" in its place. The owner card shows
  without AI now, so the no-AI line never shows beside it.
- **One card on Home:** the card is the one thing at the top; Home's standalone "설정 이어서 하기" shows only when no card
  does (hidden, finished, days over), so hiding the card never loses the way back.
- **Hide has an undo toast** ("내 설정을 숨겼어요. 설정 › 프로필에서 다시 볼 수 있어요." + Undo), like the goal card's.
- **Left out:** a card for members who joined before the member card existed (2026-11-11); an admin-written welcome;
  any new Home element; changes to the setup steps or the 7-day goal. Accounts older than 30 days never get a late
  card (they had their start); an older account also loses backfillOwner's repair of a ✕ whose hold timer was lost to
  a restart, accepted.
- **Rollback:** no migration. An older build reads late rows as ordinary cards (an owner card without the ask row) and
  hides Home's standalone setup row under it, so the way back on Home is the list panel's setup row until the card is
  hidden. Accepted.
- **Tests:** tests/unit/b-owner-late-card.test.ts (the rule: young, old, connected then ended, broken connection, a
  team connection, admin, handover both ways, several devices, a late setup end restarting the days, done and hidden
  not restarted, setupOpen for the owner only, guest, demo, personal connections off), b-member-welcome,
  b-my-setup-start, b-welcome-at-setup (a setup row never opened), web/test/unit/member-welcome.test.tsx and
  home-no-ai.test.tsx, web/test/e2e/my-setup-card.spec.ts (each card state at 1440 and 390, light and dark),
  tests/e2e-ui/scenario.spec.ts.
- **Version impact:** minor (who gets the card changes, the answer gains the optional `setupOpen`; nothing removed).
