# A personal "My setup" card for every owner and admin, not only an owner who reached the setup's end screen

- Date (UTC): 2026-11-28 05:40
- Branch: `plan/owner-personal-onboarding` (plan only; the build branch is `feat/owner-personal-onboarding`)
- Status: done
- Where: server/src/onboarding (member-welcome.ts, my-setup.ts), server/src/admin/users.ts (handover),
  shared/src/api/member-welcome.ts, web/src/components/onboarding/MemberWelcome.tsx, web/src/pages/Home.tsx, the five
  app languages. Why: Team AX core onboarding (docs/REPOSITORY-RULES.md); no plan, billing or hosting code.
- Version impact: **minor**. Who gets the card changes, and the answer gains one optional field (`setupOpen`). Nothing
  is removed from the API, and there is no migration.

## Goal

The owner asked twice: "관리자는 개인 온보딩이 없나?" Today (origin/dev 59c42716c) the personal card on Home ("내 설정",
member-welcome.ts `cardRow`) reaches an owner only when the team setup ends: its end screen, or a held ✕
(`setup = 1`). These people get **no personal onboarding at all**:

| Case | Today |
|---|---|
| A server we set up for a customer with POST /api/setup (Sincere, 11-27): the setup row exists but was never opened (`openedAt: null`) | only "설정 이어서 하기"; without AI only the no-AI line |
| A server made with `account create-owner` (CLI): no welcome-progress row at all | none |
| The owner left the team setup unfinished (not ✕, not finished) | only "설정 이어서 하기", forever |
| A team handed to a new owner (lead invite or Members › 팀장 넘기기) | the member card is hidden at the handover (users.ts `transferOwnership`), nothing replaces it |
| A hosted team whose setup ended before my-setup existed, more than 14 days ago | none (backfillOwner stops at 14 days) |
| A member made admin later | the member card if they joined in the last 14 days, else none |

What changes for the person: every owner and admin who is new here and has not connected a tool of their own gets the
one personal card on Home. An owner with an unfinished team setup sees the setup's way back as the card's first row,
so Home still shows one thing.

## Scope

In:
- One server rule for who gets a card late (replaces `backfillOwner`).
- The owner card: an ask row, a "팀 설정 이어서 하기" row while the setup is open, and its "all set" waits for the setup.
- The handover makes the new owner's card the owner card.
- Words in en, ko, ja, zh, es, id (en.ts is the source).

Out: a card for members who joined before the member card existed (2026-11-11); an admin-written welcome; any new Home
element; changes to the team setup steps; changes to the 7-day goal card.

## 1. Who gets a personal card, and when

One function, `ensureOwnCard(ctx, userId, now)`, runs on every `GET /api/me/welcome` (where `backfillOwner` runs now)
and once at the handover. It never throws and does nothing for a person who already has a row that still counts
(a shown, hidden or finished card stays as it is). The GET is read by Home, Settings › Profile (CardHide.tsx) and an
admin's Admin › Home (OrganizeTeamFiles.tsx), so "first read" is the first of those, on any device: the write is one
`INSERT … ON CONFLICT DO NOTHING` in bun:sqlite's synchronous path, so two devices reading at once make one row, and
the second reads the first one's time.

A person gets a **late card** when all of these hold:
- an active owner or admin, `guest = 0` (not a guest, not a member: members get theirs at the join, as before);
- their account is young: `users.created_at` within `LATE_CARD_DAYS = 30` days;
- nothing personal was ever done: no connection of their own **in any status** (a personal `integrations` row or a
  `drive_connections` row, connected or not; `hasOwnTool` alone would make a card appear the day after someone
  disconnects their only tool), and the team lets people connect their own (`personalIntegrations` is not off);
- not a demo: no free-roam instance (`freeRoamOf`), no demo-company person (the demo's own screen keeps Home);
- they have no member_welcome row, or only a hidden member row of an owner (`setup = 0`, `hidden_at` set: the
  handover's hide).

What it writes: an owner gets `setup = 1` (the owner card); an admin gets a member row (`setup = 0`, via `invite`, no
inviter: the card already handles "no inviter"). Its own statement, not `startMySetup`: that one resets
`apps_seen_at` to NULL. Its 14 days count from this write, so from the first read, not from when we made the account.
It sets `apps_seen_at` to the same time: a late card holds no connection template notices (offerTemplates holds only
rows with `apps_seen_at IS NULL`; only cards made at a join or at the setup's end hold them).

**The setup's end restarts an open owner card's days.** A creator owner now gets the late card on the first Home read
right after /setup (Home reads the card before useResumeOnLanding sends them to /welcome), so its 14 days start then.
`startMySetup` at the end (its end screen, the shared-skills end, a held ✕) keeps an owner card as it is today
(`WHERE setup = 0`), so an owner who took three weeks over the setup would finish it with no card left. Change: at the
end, an owner card that is neither done nor hidden gets `joined_at = <end>` (its 14 days from the end, as today's
end-made card), its rows kept. A done or hidden one stays as it is.

Per case:

| Case | Rule | When the card appears |
|---|---|---|
| Creator owner, setup finished or ✕ | as today: `startMySetup` at the end, 14 days from it | at the end screen |
| Creator owner, setup unfinished | late card (young account) with the "팀 설정 이어서 하기" row; its days restart at the setup's end | first Home read after this release, or right after /setup |
| Owner by handover | the handover calls `ensureOwnCard` for the new owner: their hidden member row becomes a fresh owner card if they are young and have no tool; else it stays hidden, as today | right after the handover |
| Admin made later | a live member card stays as it is; no row and a young account: a late member card. Older than 30 days: none (they had their start) | first Home read |
| Owner on a server we set up with POST /api/setup (Sincere) | the unfinished case: late card, the setup row in it (hidden while no AI answers; the AI row first) | the customer's first visit |
| Owner on a server made with `create-owner` | late card, no setup row (no progress row, `setupOpen` false) | the customer's first visit |
| Hosted owner whose setup ended before my-setup | late card if the account is younger than 30 days and has no tool; the 14-day limit of backfillOwner goes | next Home read |

## 2. What the owner or admin card shows

- **`setupOpen`** (server): the caller's role is `owner` and the progress row exists, is not finished and has no
  `dismissedAt` (the same test as `showResume` before its per-device step check). Never true for anyone else: an
  ex-owner, now an admin, who keeps an owner card is never held by steps they can no longer open.
- **Owner** (kind `owner`), rows in order:
  1. "팀 설정 이어서 하기 · 2/5" (only while `setupOpen`; quiet, a link to /welcome at its step). The count and the
     one-step-left form ("남은 일: 팀 파일") are `setupRowWords`; the card's label adds "팀" so it is not read as part of
     "my" setup. Nothing done yet (a row the setup made and nobody opened: Sincere): "팀 설정 시작하기 · 1/5" (it was
     never started, so "이어서" is wrong). Not counted.
  2. 내 도구 연결 (counted, unchanged).
  3. **Trina에게 묻기** (counted, new for the owner): the member's ask row and its fixed question.
  4. 프로필 사진 (optional), 5. this computer's files / 데스크톱 앱 열기 (optional), unchanged.
  - **No AI, and the person can connect it** (an owner; an admin whose action is `connect_team` or `connect_own`): the
    ask row becomes the no-AI way out and moves to the **top of the counted rows**, over 내 도구 연결: nothing else in
    the card works for them without it, and today's Home leads with it (NoAiCard). Its words are the team's, not "내
    AI": "AI를 연결하면 {ai}가 바로 도와줄 수 있어요" with NoAiCard's button ("Claude 연결하기"); `connect_own` keeps
    "내 AI를 연결하면 …". A member (`ask_owner`) keeps it where it is.
  - **No "팀에 인사하기"** for the owner: at the start they are often alone, and a team's first message from its owner is
    an announcement, not a hello. An admin keeps it (they join people who are there).
  - Title: "이제 {name}님 차례예요" once the setup is over (as today). While it is open: "{name}님, 시작해 볼까요"
    (en "Let's get you started, {name}"): "now your turn" says the team part is done. The line under it: "팀 설정은
    끝났어요. 여기는 나만을 위한 설정이에요." when the setup is over; while it is open: "여기는 나만을 위한 설정이에요."
  - Count line: "시작하기 · 필수 2개 중 {n}개" (replaces "나만 보여요", which explained a one-row card). When both are
    done and the setup is still open: "내 설정은 다 했어요 · 팀 설정이 남았어요" (not "2개 중 2개" over a card that stays).
- **Admin**: the member card as it is (tools, hi, ask, photo, files), the no-AI row first as above. Nothing else new.
- **Two cards never show.** The card takes Home's top as now; Home's standalone "설정 이어서 하기" (WelcomeResume)
  shows only when no card does (hidden, finished, days over). The no-AI line is not shown beside an owner card any
  more: its ask row is the no-AI way out, like a member's.

## 3. Lean: what is removed or merged

- Merged: the setup's way back on Home into the card (one row), and the no-AI line into the owner card's ask row.
- Removed: `backfillOwner` (replaced by `ensureOwnCard`), the Home special case `!(welcome.kind === 'owner' && noAi)`,
  the "나만 보여요" line. What backfillOwner also did, and stays covered: an owner whose setup ended before 11-20 (moot
  by 12-04, the last 14 days of it), and a ✕ whose 60-second hold timer was lost to a restart (endHeldDismissal never
  ran): both are young owners with no row, so the late card covers them; an older account loses that repair, which is
  accepted.
- Added: one row for the owner (ask), one optional answer field (`setupOpen`). No new card, page, button bar or setting.

## 4. Existing teams

- Owners and admins who already did something personal never see a card: one own connection, even one they ended
  since, blocks the late card.
- Accounts older than 30 days never get a late card (potenlab.trina.app's owner and admins, for example).
- A card a person hid, finished or outlived is never made again (any existing row blocks it, except the handover's
  hidden member row of an owner).
- After the release, the people who will see one: young owners and admins with no own tool, on any server: Sincere's
  owner (`admin`, made 11-27, no AI: the unfinished case), owners with an unfinished setup, handed-over teams.
  **JDR is probably outside the window:** its owner `admin` and its admin `seungmin` (admin since 11-06) were made
  before ~11-06, so 30 days run out around the time this reaches stable. Before the release, read both `created_at`
  over SSH (read only); if they are out, that is the window working as decided, not a bug (decision 1).
- Our own checks on a customer's server (signing in as their owner) must not open Home or Settings › Profile: the
  first read starts the card's days.

## 5. Edge cases

- **Phone:** the same card. The setup row shows on a phone when the steps have a step for a phone (`showResume(p,
  false)`); when only "내 스킬" is left for a computer, the row reads "팀 설정은 컴퓨터에서 이어서 해요" with no button
  (the words of SkillsOnComputer). No files row on a phone, as today.
- **Phone, the card's setup row:** a 44 px target like the card's other buttons (`tap`), its button wrapping under the
  words at 390 px as the rows' buttons do.
- **Guest:** never a card, unchanged (`guest = 0` in the rule, and cardRow already returns null for a guest).
- **Multiple owners:** there is one owner at a time (the only writes of `role = 'owner'` are the account's creation and
  transferOwnership, which checks exactly one). The ex-owner, now an admin, keeps an owner card they still have,
  without the setup row and never held by it (`setupOpen` is owner-only). The new owner: §1.
- **An owner who is also on another team:** each team is its own server and database, so each card follows that
  team's role and rows only (owner card on one, member card on the other). The desktop app reads each team's own
  server: nothing to merge.
- **A team with no AI engine** (no team AI, nobody's own): the owner's and an admin's card leads with the AI row (§2);
  the setup row waits; the composer's blocked line is unchanged. A member keeps "Tell {owner}".
- **Hidden and shown again:** Hide closes the whole card; while the setup is open, Home shows the standalone
  "설정 이어서 하기" again (HomeTop already shows when no card does), so the way back is never lost. Today the card's
  Hide has **no** undo toast (store/memberWelcome.ts hide; only the goal and "Ready in your team" cards have one,
  CardHide.tsx). Add the same toast with Undo (PATCH `{ show }`), so a mis-tap does not need Settings. Settings ›
  Profile "Show my setup on Home again" works for the late cards too (the same `hidden` / PATCH `{ show }`).
- **"All set" timing:** an owner's card is all set when tools and ask are done **and** the setup is not open
  (`setupOpen` false). While it is open, the personal rows show ✓ and the setup row is the one thing left, so "준비 끝"
  never shows over an unfinished team. When the 14 days end first, the card goes and the standalone row stays.
- **No AI:** the setup row hides while no AI answers (as `setupRowState` does on Home); the AI row is first in the card
  (§2). After connecting, the setup row comes back and the ask row goes back to its place.
- **Sincere** (owner `admin`, made 11-27, setup row never opened, no AI engine on purpose): on the first visit the
  landing sends them to /welcome (its AI step), as today. Back on Home: the owner card, "AI를 연결하면 …" first, 내
  도구 연결, the optional rows; no setup row until AI answers, then "팀 설정 시작하기 · 1/5". The no-AI line does not
  show beside it. Their member `dion` (if any) has a member card from the join, unchanged.
- **Lead card:** a pending lead-handover card still takes the top before the welcome card (unchanged).

## 6. Migration needs

None. `member_welcome` has `setup`, `apps_seen_at`, `hidden_at`; `via 'invite'` is in its CHECK; `users.created_at`
exists since 001. Highest migration on dev is 703; this adds none. Rollback: an older build reads late rows as ordinary
cards (owner card without the ask row), and no data is lost. One thing an older build does worse: it shows an owner
card while the setup is open with no setup row in it (its Home hides HomeTop under any card), so the way back on Home
is gone until the card is hidden; the list panel's setup row on other pages still leads there. Accepted for a rollback.

## Steps

1. Server: `ensureOwnCard` in member-welcome.ts (replaces backfillOwner; its own INSERT, `apps_seen_at` set; the
   "ever had an own connection" test), `setupOpen` in the answer (owner role only), owner `countedDone` = tools +
   asked + not setupOpen (a demo owner: asked + not setupOpen). my-setup.ts `startMySetup`: an owner card neither done
   nor hidden gets `joined_at = <end>`. Handover calls `ensureOwnCard` after the commit.
2. Shared: `setupOpen?: boolean` on MemberWelcome; `countedSteps` for the owner (tools + asked; demo: asked).
3. Web: the owner card gets the setup row and the ask row, drops "나만 보여요"; the AI row first while no AI answers
   and the person can connect it; the open-setup title and count line; Hide's undo toast. Home drops the owner no-AI
   exception (WelcomeResume already shows only without a card).
4. Words in six languages; `bun run check:i18n`.
5. Decision file `docs/decisions/20261128-owner-admin-personal-card.md`; `changes/owner-personal-card.md`.

## Decisions

New: `docs/decisions/20261128-owner-admin-personal-card.md`. Changes in part
[20261120-my-setup-card.md](../../decisions/20261120-my-setup-card.md) (who gets the owner card, its rows, Home's
owner order: the setup row moves into the card) and the handover line in transferOwnership.

## Risks

- A GET writes a row (as backfillOwner does today). Idempotent: `INSERT OR IGNORE` / the conflict update only on a
  hidden member row of an owner.
- The ask row costs one AI turn per owner, the same as a member's.
- Six languages; phone and desktop app read the same server answer.

## Tests

tests/unit/b-member-welcome.test.ts (each row of the table in §1, older than 30 days, own tool, an own tool ended
since, hidden, handover, admin, guest, a demo person; the setup ending 20 days after the late card restarts its days;
a done or hidden card is not restarted; an ex-owner admin's owner card finishes while the new owner's setup is open;
late rows hold no template notices; two reads make one row). The existing owner tests there (line ~334, "only tools
counts"; line ~372, the handover read through backfillOwner) are rewritten, not deleted. tests/unit/b-welcome-at-setup.test.ts
(a setup row never opened: `setupOpen` true, the card made). web/test/unit/member-welcome.test.tsx (owner rows, setup
row and its "시작하기" form, AI row first without AI, all set waits, the open-setup title and count line, Hide's undo),
web/test/unit/home-no-ai.test.tsx, web/test/e2e/my-setup-card.spec.ts (the mock makes no card by itself: seed
`setupOpen`; owner unfinished → setup row → /welcome → back; hide → toast → Undo; hide → standalone row). Because the
real server now makes a card for every new owner, also run tests/e2e-ui/scenario.spec.ts (setup → Home on a real
server) and fix what it expected on Home. A walk of every exit at 1440 and 390, light and dark.
`bun run typecheck`, `bun run check:docs`, `bun run test:unit`.

## Mockups (Home, top)

Owner, team setup finished:

```
 이제 다현님 차례예요                                    숨기기
 팀 설정은 끝났어요. 여기는 나만을 위한 설정이에요.
 시작하기 · 필수 2개 중 0개
 ○ 내 도구 연결         내 계정으로 연결하면 Trina가 바로 써요
     Google Drive [연결]  Gmail [연결]  Notion [연결]   더 보기
 ○ Trina에게 여기서 뭘 할 수 있는지 묻기               [묻기]
 ○ 프로필 사진 넣기     선택 · 누가 말하는지 알 수 있게  [사진 넣기]
 ○ 이 컴퓨터에서 업무 파일 가져오기  선택              [파일 찾기]
```

Owner, team setup unfinished:

```
 다현님, 시작해 볼까요                                   숨기기
 여기는 나만을 위한 설정이에요.
 → 팀 설정 이어서 하기 · 2/5                            [이어서 하기]
 시작하기 · 필수 2개 중 1개
 ✓ 내 도구 연결
 ○ Trina에게 여기서 뭘 할 수 있는지 묻기               [묻기]
 ○ 프로필 사진 넣기     선택                            [사진 넣기]
 ○ 데스크톱 앱 열기     선택                            [앱 열기]
```

Owner, team setup unfinished, both personal rows done (the card stays for the setup):

```
 다현님, 시작해 볼까요                                   숨기기
 여기는 나만을 위한 설정이에요.
 → 남은 일: 팀 파일                                     [이어서 하기]
 내 설정은 다 했어요 · 팀 설정이 남았어요
 ✓ 내 도구 연결
 ✓ Trina에게 여기서 뭘 할 수 있는지 묻기
 ○ 프로필 사진 넣기     선택                            [사진 넣기]
```

Owner with no AI (Sincere: setup never opened, no engine):

```
 Admin님, 시작해 볼까요                                  숨기기
 여기는 나만을 위한 설정이에요.
 시작하기 · 필수 2개 중 0개
 ○ AI를 연결하면 Trina가 바로 도와줄 수 있어요          [Claude 연결하기]
 ○ 내 도구 연결         내 계정으로 연결하면 Trina가 바로 써요
     Google Drive [연결]  Gmail [연결]  Notion [연결]   더 보기
 ○ 프로필 사진 넣기     선택                            [사진 넣기]
 ○ 데스크톱 앱 열기     선택                            [앱 열기]
```
(After AI answers: "→ 팀 설정 시작하기 · 1/5 [시작하기]" appears under the line, and the AI row becomes the ask row
in third place.)

Phone (390), owner, setup unfinished (no frame, 44 px targets, buttons wrap under the words):

```
 다현님, 시작해 볼까요                 숨기기
 여기는 나만을 위한 설정이에요.
 → 팀 설정 이어서 하기 · 2/5
                              [이어서 하기]
 시작하기 · 필수 2개 중 1개
 ✓ 내 도구 연결
 ○ Trina에게 여기서 뭘 할 수
   있는지 묻기                     [묻기]
 ○ 프로필 사진 넣기 · 선택     [사진 넣기]
 ─────────────────────────────────────────
 [ 무엇이든 물어보세요            ⏎ ]
```
(Only 내 스킬 left, for a computer: the setup row reads "팀 설정은 컴퓨터에서 이어서 해요", no button.)

Admin (made later, or invited as admin):

```
 Acme에 오신 걸 환영해요, 민수님                         숨기기
 5명이 함께해요 · 모두에 들어와 있어요
 시작하기 · 필수 3개 중 0개
 ○ 내 도구 연결                     Google Drive [연결] ...
 ○ 팀에 인사하기        모두에 올라가요   [👋 안녕하세요, 민수입니다]
 ○ Trina에게 여기서 뭘 할 수 있는지 묻기               [묻기]
 ○ 프로필 사진 넣기     선택                            [사진 넣기]
```

## Self-review (a non-developer owner walking every exit)

Walked on paper against the code on origin/dev, as a new owner, a customer owner on a server we set up, a new owner by
handover and a new admin. What the first draft got wrong, and the fix now in the plan:

1. **"준비 끝" over an unfinished team.** The draft let the card finish when tools and ask were done, while the team
   setup was still open; the owner read "all set" and then saw the setup row come back alone. Fix: all set waits for
   the setup (§5).
2. **Hide lost the way back.** Hiding the card hid the setup row inside it. Fix: Home shows the standalone row whenever
   no card shows (§2, §5).
3. **"팀 설정은 끝났어요" was false** on the unfinished card. Fix: the shorter line while the setup is open (§2).
4. **A flood of held notices.** A late row would have held the connection template notices of someone who has been
   here for weeks. Fix: late rows set `apps_seen_at` and hold nothing (§1).
5. **Two AI buttons.** Without AI the draft showed the setup row (whose first step is AI) and the ask row's "AI 연결하기".
   Fix: the setup row hides without AI, as it already does on Home (§5).
6. **A customer whose account we made a week before their first visit** would have had a card already counting down.
   Fix: the 14 days count from the card's write on their first Home read (§1).
7. Exits checked: 이어서 하기 → /welcome, whose "나중에 하기" returns Home to the same card; 연결 → the provider's sign-in
   and back to Home (unchanged flow), or Settings › Connectors for Google (its own back link); 묻기 → the new chat (the
   card stays on Home); 사진 넣기 → in place; 앱 열기 → /open-app with its back state; 숨기기 → a toast with Undo (new:
   the card's Hide had none, see §5), and Settings › Profile brings it back. No exit leaves without a way back.
   The setup row's button is "이어서 하기" (the app's word), not "이어 하기".

### Independent review (2026-11-28, second pass against origin/dev 59c42716c)

Ranked; each fix is now in the sections above.

1. **High: a slow setup lost its card.** The late card starts at the first Home read right after /setup, and
   `startMySetup` keeps an owner card as it is, so an owner who finished the setup after day 14 had no personal card
   (today they get 14 days from the end). Fix: the setup's end restarts an open card's days (§1).
2. **High: Sincere was described wrongly.** It was made with POST /api/setup, so it has a setup row (never opened)
   and is the unfinished case, not "no setup row". The card's setup row would also have said "이어서" for a setup
   never begun. Fix: §1 table, §2 "팀 설정 시작하기", §5 Sincere. `create-owner` servers are the no-row case.
3. **High (UX): no AI buried the one thing that matters.** For an owner with no AI, the AI row sat second, under a
   tall tools list, where Home today leads with it. Fix: the AI row first while no AI answers and they can connect it,
   in the team's words, not "내 AI" (§2).
4. **Medium: a surprise card after a disconnect.** "No working own connection" would make a card appear the day after
   a young owner ended their only tool. Fix: any own connection ever, in any status, blocks it (§1).
5. **Medium: the handover would hold notices again.** Reusing `startMySetup` for a late or handover card resets
   `apps_seen_at` to NULL. Fix: ensureOwnCard's own statement (§1).
6. **Medium: `setupOpen` for an ex-owner.** Not limited to the owner role, an ex-owner admin's owner card could never
   finish while the new owner's setup is open. Fix: owner role only (§2).
7. **Medium: "Hide → Undo toast" was not true** for this card. Fix: add it (§5).
8. **Medium: JDR is likely outside 30 days** (owner and admin made by ~11-06). Fix: check before release; it is the
   window as decided (§4, decision 1).
9. **Low: wording.** "이제 {name}님 차례예요" over an unfinished team, "필수 2개 중 2개" over a card that stays, and
   "팀 설정 이어 하기" vs the app's "설정 이어서 하기". Fix: §2.
10. **Low: tests and demo.** The real-server UI scenario now meets a card after setup; the old owner tests rely on
    backfillOwner; demo-company persons must be skipped. Fix: Tests, §1.

Checked and holding: the late-card rule otherwise; removing backfillOwner (its two jobs are covered, §3); no
migration (columns from 286 and 428, `via 'invite'` in the CHECK, `users.created_at` from 001; highest is 703); the
first-read start with several devices (one synchronous INSERT, no race); `apps_seen_at` on late rows (offerTemplates
holds only `apps_seen_at IS NULL`); one card at a time on Home (lead card, then the welcome card; HomeTop, the no-AI
line and "Ready in your team" all stay out under a card); guests; one owner at a time; teams on separate servers.

## Open decisions (one recommendation each)

1. **Late-card window.** Recommend **30 days from account creation** (`LATE_CARD_DAYS`), with "never had an own
   connection" as the second gate. Covers Sincere, owners with an unfinished setup and recent hosted teams; never shows
   to established owners. JDR is probably just outside it (made by ~11-06); a longer window to reach it would also
   reach people who have used the app for six weeks, so keep 30 and check JDR's dates before the release.
2. **The owner's counted rows.** Recommend **tools + ask**, photo and files optional, no "say hi" for the owner. While
   no AI answers and they can connect it, the ask row is the AI row and goes first.
3. **Card while the team setup is still open.** Recommend **yes, from the start**, the setup row first in the card,
   and the card's 14 days restarted at the setup's end. This changes the 2026-11-20 order ("team setup first, then My
   setup") so that Home shows one card instead of a lone row, and the owner has personal steps from day one; the
   restart keeps today's promise of 14 days after the setup.
4. **New owner by handover.** Recommend **a fresh owner card when they are young and never had an own connection**;
   otherwise their card stays hidden, as today.

## Result

Built on `feat/owner-personal-onboarding` as planned, with the four open decisions as recommended (the owner,
2026-11-28: "검수 끝나면 ㄱㄱ"):

- Server: `ensureOwnCard` (member-welcome.ts) replaces `backfillOwner`: its own INSERT with `apps_seen_at` set, the
  30-day window, "ever had an own connection" (a personal connection or Drive row in any status, or the audit log's
  `drive.connected`, `google_app.connected` and personal `integration.create`: a disconnect deletes the row, so the
  audit is what remembers it), no demo, no guest. `setupOpen` for the owner role only; the owner's `countedDone` is
  tools + asked + not setupOpen. `startMySetup` restarts an open owner card's days at the end (forward only). The
  handover calls `ensureOwnCard` after the commit.
- Web: the owner card's setup row ("팀 설정 이어서 하기 · n/5", "팀 설정 시작하기 · 1/5" while no step was taken, "남은
  일: …", the phone's "팀 설정은 컴퓨터에서 이어서 해요"), the ask row, the open-setup title, line and count line, the AI
  row first for anyone who can connect it (Home's no-AI buttons, exported as `TeamWaysButtons` from ConnectAi.tsx),
  Hide's undo toast; Home drops the owner no-AI exception. Six languages; "나만 보여요" removed.
- What differs: the decision file is `docs/decisions/20261128-owner-personal-onboarding.md` (the README names it after
  the branch), not `…-owner-admin-personal-card.md`. "Never started" on the web is "no step recorded" (the progress the
  web reads has no `openedAt`); a setup someone opened and left at step 1 also reads "팀 설정 시작하기 · 1/5", which is
  true there too. The JDR `created_at` check is skipped (the owner: don't touch the jdr server).
- Tests: tests/unit/b-owner-late-card.test.ts (new), b-member-welcome and b-my-setup-start (the two backfillOwner
  tests rewritten), b-welcome-at-setup (a row never opened), the guest role-read review list, web unit member-welcome
  and home-no-ai, web e2e my-setup-card (every card state at 1440 and 390, light and dark), tests/e2e-ui step 1.
