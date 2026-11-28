# A personal "My setup" card for every owner and admin, not only an owner who reached the setup's end screen

- Date (UTC): 2026-11-28 05:40
- Branch: `plan/owner-personal-onboarding` (plan only; the build branch is `feat/owner-personal-onboarding`)
- Status: draft
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
| A server we set up for a customer (Sincere, JDR): owner made by `admin create-owner`, no welcome-progress row | none |
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
- The owner card: an ask row, a "팀 설정 이어 하기" row while the setup is open, and its "all set" waits for the setup.
- The handover makes the new owner's card the owner card.
- Words in en, ko, ja, zh, es, id (en.ts is the source).

Out: a card for members who joined before the member card existed (2026-11-11); an admin-written welcome; any new Home
element; changes to the team setup steps; changes to the 7-day goal card.

## 1. Who gets a personal card, and when

One function, `ensureOwnCard(ctx, userId, now)`, runs on every `GET /api/me/welcome` (where `backfillOwner` runs now)
and once at the handover. It never throws and does nothing for a person who already has a row that still counts
(a shown, hidden or finished card stays as it is).

A person gets a **late card** when all of these hold:
- an owner or an admin (not a guest, not a member: members get theirs at the join, as before);
- their account is young: `users.created_at` within `LATE_CARD_DAYS = 30` days;
- nothing personal is done: no working connection of their own (`hasOwnTool`), and the team lets people connect their
  own (`personalIntegrations` is not off). A free-roam demo never gets one;
- they have no member_welcome row, or only a hidden member row of an owner (the handover's hide).

What it writes: an owner gets `setup = 1` (the owner card, as `startMySetup` makes it); an admin gets a member row
(`setup = 0`, via `invite`, no inviter: the card already handles "no inviter"). Its 14 days count from this write, so
from the first time the person opens Home, not from when we made the account. It sets `apps_seen_at` to the same time:
a late card holds no connection template notices (they may already be waiting; only cards made at a join hold them).

Per case:

| Case | Rule | When the card appears |
|---|---|---|
| Creator owner, setup finished or ✕ | as today: `startMySetup` at the end, 14 days from it | at the end screen |
| Creator owner, setup unfinished | late card (young account) with the "팀 설정 이어 하기" row | first Home read after this release, or right after /setup |
| Owner by handover | the handover calls `ensureOwnCard` for the new owner: their hidden member row becomes a fresh owner card if they are young and have no tool; else it stays hidden, as today | right after the handover |
| Admin made later | a live member card stays as it is; no row and a young account: a late member card. Older than 30 days: none (they had their start) | first Home read |
| Owner on a server we set up | late card on first Home read (no setup row there, so no setup row in the card) | the customer's first visit |
| Hosted owner whose setup ended before my-setup | late card if the account is younger than 30 days and has no tool; the 14-day limit of backfillOwner goes | next Home read |

## 2. What the owner or admin card shows

- **Owner** (kind `owner`), rows in order:
  1. "팀 설정 이어 하기 · 2/5" (only while the setup is open, for the owner: started, not finished, not ✕; quiet, a
     link to /welcome at its step; the same words as `setupRowWords`). Not counted.
  2. 내 도구 연결 (counted, unchanged).
  3. **Trina에게 묻기** (counted, new for the owner): the member's ask row and its fixed question. While no AI answers,
     it is the no-AI way out ("AI 연결하기" for the owner), exactly as for an admin today.
  4. 프로필 사진 (optional), 5. this computer's files / 데스크톱 앱 열기 (optional), unchanged.
  - **No "팀에 인사하기"** for the owner: at the start they are often alone, and a team's first message from its owner is
    an announcement, not a hello. An admin keeps it (they join people who are there).
  - Title stays "이제 {name}님 차례예요". The line under it: "팀 설정은 끝났어요. 여기는 나만을 위한 설정이에요." when the
    setup is over; while it is open: "여기는 나만을 위한 설정이에요." (the card no longer claims the team is set up).
  - Count line: "시작하기 · 필수 2개 중 {n}개" (replaces "나만 보여요", which explained a one-row card).
- **Admin**: the member card as it is (tools, hi, ask, photo, files). Nothing new.
- **Two cards never show.** The card takes Home's top as now; Home's standalone "설정 이어서 하기" (WelcomeResume)
  shows only when no card does (hidden, finished, days over). The no-AI line is not shown beside an owner card any
  more: its ask row is the no-AI way out, like a member's.

## 3. Lean: what is removed or merged

- Merged: the setup's way back on Home into the card (one row), and the no-AI line into the owner card's ask row.
- Removed: `backfillOwner` (replaced by `ensureOwnCard`), the Home special case `!(welcome.kind === 'owner' && noAi)`,
  the "나만 보여요" line.
- Added: one row for the owner (ask), one optional answer field (`setupOpen`). No new card, page, button bar or setting.

## 4. Existing teams

- Owners and admins who already did everything never see a card: one working own connection blocks the late card.
- Accounts older than 30 days never get a late card (potenlab.trina.app's owner and admins, for example).
- A card a person hid, finished or outlived is never made again (any existing row blocks it, except the handover's
  hidden member row of an owner).
- After the release, the people who will see one: young owners and admins with no own tool, on any server. That is
  exactly the asked-for set (Sincere, JDR, owners with an unfinished setup, handed-over teams).

## 5. Edge cases

- **Phone:** the same card. The setup row shows on a phone when the steps have a step for a phone (`showResume(p,
  false)`); when only "내 스킬" is left for a computer, the row reads "팀 설정은 컴퓨터에서 이어서 해요" with no button
  (the words of SkillsOnComputer). No files row on a phone, as today.
- **Guest:** never a card, unchanged.
- **Multiple owners:** there is one active owner at a time (transferOwnership checks it). The ex-owner, now an admin,
  keeps an owner card they still have, without the setup row (the steps are owner-only). The new owner: §1.
- **Hidden and shown again:** Hide closes the whole card; while the setup is open, Home shows the standalone
  "설정 이어서 하기" again, so the way back is never lost. Settings › Profile "Show my setup on Home again" works for the
  late cards too (the same `hidden` / PATCH `{ show }`).
- **"All set" timing:** an owner's card is all set when tools and ask are done **and** the setup is not open
  (`setupOpen` false). While it is open, the personal rows show ✓ and the setup row is the one thing left, so "준비 끝"
  never shows over an unfinished team. When the 14 days end first, the card goes and the standalone row stays.
- **No AI:** the setup row hides while no AI answers (as `setupRowState` does on Home); the ask row says "AI 연결하기".
  After connecting, the setup row comes back.
- **Lead card:** a pending lead-handover card still takes the top before the welcome card (unchanged).

## 6. Migration needs

None. `member_welcome` has `setup`, `apps_seen_at`, `hidden_at`; `via 'invite'` is in its CHECK; `users.created_at`
exists since 001. Highest migration on dev is 703; this adds none. Rollback: an older build reads late rows as ordinary
cards (owner card without the ask row), and no data is lost.

## Steps

1. Server: `ensureOwnCard` in member-welcome.ts (replaces backfillOwner), `setupOpen` in the answer, owner `countedDone`
   = tools + asked + not setupOpen, `apps_seen_at` on late rows. Handover calls it after the commit.
2. Shared: `setupOpen?: boolean` on MemberWelcome; `countedSteps` for the owner.
3. Web: the owner card gets the setup row and the ask row, drops "나만 보여요"; Home drops the owner no-AI exception and
   shows WelcomeResume only without a card.
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

tests/unit/b-member-welcome.test.ts (each row of the table in §1, older than 30 days, own tool, hidden, handover,
admin), web/test/unit/member-welcome.test.tsx (owner rows, setup row, all set waits), web/test/unit/home-no-ai.test.tsx,
web/test/e2e/my-setup-card.spec.ts (owner unfinished → setup row → /welcome → back; hide → standalone row), and a
walk of every exit at 1440 and 390, light and dark. `bun run typecheck`, `bun run check:docs`, `bun run test:unit`.

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
 이제 다현님 차례예요                                    숨기기
 여기는 나만을 위한 설정이에요.
 → 팀 설정 이어 하기 · 2/5                              이어 하기
 시작하기 · 필수 2개 중 1개
 ✓ 내 도구 연결
 ○ Trina에게 여기서 뭘 할 수 있는지 묻기               [묻기]
 ○ 프로필 사진 넣기     선택                            [사진 넣기]
 ○ 데스크톱 앱 열기     선택                            [앱 열기]
```

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
7. Exits checked: 이어 하기 → /welcome, whose "나중에 하기" returns Home to the same card; 연결 → the provider's sign-in
   and back to Home (unchanged flow), or Settings › Connectors for Google (its own back link); 묻기 → the new chat (the
   card stays on Home); 사진 넣기 → in place; 앱 열기 → /open-app with its back state; 숨기기 → a toast with Undo, and
   Settings › Profile brings it back. No exit leaves without a way back.

## Open decisions (one recommendation each)

1. **Late-card window.** Recommend **30 days from account creation** (`LATE_CARD_DAYS`), with "no own tool" as the
   second gate. Covers Sincere, JDR and recent hosted teams; never shows to established owners.
2. **The owner's counted rows.** Recommend **tools + ask**, photo and files optional, no "say hi" for the owner.
3. **Card while the team setup is still open.** Recommend **yes, from the start**, the setup row first in the card. This
   changes the 2026-11-20 order ("team setup first, then My setup") so that Home shows one card instead of a lone row,
   and the owner has personal steps from day one.
4. **New owner by handover.** Recommend **a fresh owner card when they are young and have no own tool**; otherwise their
   card stays hidden, as today.

## Result

Filled in at the end.
