# Share dialog: Limit access says what it does, or why it does nothing

- Date (UTC): 2026-11-25 10:44
- Branch: `fix/folder-restrict-honest`
- Status: done (part 1); part 2 waits for review
- Where: web/ (Share dialog, `web/src/pages/admin/FolderSharing.tsx`) and the six locale files. Why: the dialog is the
  admin's Share panel in Files and Admin › Folder permissions (see docs/REPOSITORY-RULES.md)
- Version impact: patch. The dialog shows and words things differently; what the server saves and checks is unchanged.

## Goal

The owner opened Share on `shared/Finance` ("전사 공유" › Finance). The folder has no setting of its own, and the
company-wide folder above it lets in only the owner and admins. Turning **Limit access** on or off changed nothing on
screen, because it changed nobody: Limit access stops people the folders above let in, and the folders above let in
nobody but the owner and admins, who keep access anyway. The dialog never said so. Also the General access line read
"팀장과 관리자만 열 수 있어요. · '전사 공유'에서 · 거기서 바꾸기", and the Korean mixed 합니다체 and 음슴체 into 해요체.

The owner also asked why "전사 공유" can be admins only. Read from the code: a new team's `shared/` is "everyone can
edit" (`createDefaultFolders`); setup, the AI's folder tool (never General access or Limit access) and migrations do
not restrict it. Only an admin's choice in this dialog or Admin › Folder permissions does, or the one-time "access adds
up" conversion that kept an older team's stricter setting. The QA server's `shared/` is open (read-only check of its
rules and audit rows). So the dialog must make a restricted "전사 공유" read as an admin's choice, with one way to change
it.

## Scope

In:
- Limit access when it changes nobody now (the folders above let in only the owner and admins: the server's `above`
  answer has no rule row that opens it): the switch is shown greyed with one line why, in place of the long hint. It
  works again by itself when the folder above opens to someone.
- Limit access when it matters: turning it on lists the people it stops under "Access removed" at once (from the
  server's answer for the draft, with Add), not only after Save; the rows from the folders above leave the list and the
  General access line follows (already so).
- General access, a folder with no setting of its own: the hint on its own line, then "Follows '<folder>' · Change
  there ›" on the next (no "· 'X'에서 ·").
- `shared/` itself when Restricted: one line "Company-wide is usually open to the whole team. An admin restricted it."
- Korean: every sentence of the dialog in 해요체 (hints, row lines, Limit access, the notice); labels stay short.
- All six locales get the new keys.

Out: server rules and saves (unchanged); the admin notice after the conversion beyond its wording.

## Steps

1. `limitIdle` from `data.above` (only rule rows with access and people count); `LimitAccess` gets `idle`.
2. Draft "Access removed": people who lose access in the preview while the limit is turned on in this draft.
3. General access follow line and the `shared/` note; new keys `folderAccess.followsFolder`, `followsTop`,
   `limitIdle`, `sharedRestricted` in en and the five other locales.
4. ko wording to 해요체.
5. Tests: panel unit tests for each state (parent open / restricted, people added or none, subfolder / top folder,
   shared/ itself, member view refused); server save test that the limit still saves and cuts exactly who the preview
   named. Screens at 1440 and 390, light and dark, on a private local server with test data.

## Decisions

None new: Limit access works as docs/DECISIONS.md "Folder access adds up like Google Drive (P2)" says; only what the
dialog shows changes.

## Risks

Words in six languages; tests that compare old keys. No migration, no permission change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`, `web/test/unit/folder-sharing-panel.test.tsx`,
`tests/security/folder-sharing.test.ts`, web e2e `folder-access.spec.ts`.

## Result

Part 1 built as planned. After review (#590, cd93e96):
- Greyed only while the limit is off (a limit that is on can always be taken away).
- Greyed only when nothing above lets anyone in but the owner and admins: General access from above is Restricted
  (`everyoneAbove`) and no stored rule on the way up (to the nearest limited folder) names a person, a group,
  everyone or members (`aboveAdmits`, from the folder list the dialog already loads). The first version used today's
  head count, so a new team with no members yet showed the switch greyed under an open 전사 공유.
- On shared/ and skills/ the idle line goes while the draft changes General access; the "an admin restricted it" note
  reads the saved setting; more than 50 people cut is said as a number.
Also fixed a stale e2e step (Remove access no longer asks, docs/decisions/20261123-do-then-undo.md). Server checks:
`tests/unit/c-folder-limit-states.test.ts` (each state, a team with no members yet, an empty group above).

---

# Part 2 (review first, not built): who can open a folder, visible like Notion

Owner, 11-25: "권한이 눈에 안보여서 애매하다… 노션같은거 처럼?", then "검수 해보고 시작하자". Status: **plan for review**. No
UI code is written until the UX review and the owner's OK.

## What Drive and Notion show (looked at in a signed-in browser, 11-25; reference shots kept off the repo)

| Place | Google Drive | Notion |
|---|---|---|
| List rows | Only a "shared" folder icon (a person on the folder) or a small people icon after a shared file's name. No avatars, no count, **nothing on restricted rows**. | Page rows: icon and title only. Private vs team is the sidebar *section* ("Private", "Teamspaces", "Shared"), **no per-page lock or avatars**. |
| Inside / header | Breadcrumb plus one people icon (button "Shared"). **No avatar stack.** A shared drive shows "4 people · Manage members". Avatars are only in the Details panel ("Who has access": avatars, one sentence "Shared with A, B and C", Manage access). | The Share button's icon tells the state (lock = private, building = whole workspace); a private page shows "🔒 Private" in the breadcrumb. Avatars in the top bar are the people looking at the page now ("faded if not looking at the page"), not who can open it. |
| Share dialog, inherited | "People with access" does **not** say "inherited"; in a shared drive the inherited role is only greyed. Limited folders show "Access removed". Help: "always check both People with access and General access". | Groups are one row ("People in General · Teamspace · 1 person"), General access "Everyone at X". Inherited access is described only in help ("a subpage takes on the permissions of its parent"). |

Common to both: lists say at most "this is shared", never who; who, names and inheritance live in one place (the share
dialog or the details panel); only Notion puts faces in a page header.

## What we have now (read from the code)

- Folder header: the breadcrumb and one small chip (`FolderAccessChip`, `lib/folder-access.ts`): "팀 전체가 봐요",
  "팀장과 관리자만", "3명", "나만 봐요". Admins get a count apart from the owner and admins (the server's split);
  members get a count only where they can write (`GET /api/files/audience`: "counted, never named", docs/DECISIONS.md
  "Who can see a folder, in place"). A folder they can only read shows "읽기 전용 폴더" instead.
- List rows (`pages/Files.tsx`): "이동만" (pass-through), "멤버만" (project), "공유됨" (my own folders),
  and a **small lock after the name = read-only for you**. Team folders get no access mark.
- Share dialog: people and groups set here, people and groups from folders above (greyed, "거기서 바꾸기"), the owner
  and admins row. The team as a whole is said only by the General access line, not as a row.
- Data on hand: `/api/people` (every member: name, photo version; members only) and `/api/people/:id/avatar` (cached a
  year) are already loaded for avatars everywhere (`store/people`). The listing (`TeamFiles.list`) already has the
  in-memory `RuleSet` and every active principal for its own checks.

## Proposal (lean; what goes and what stays)

### 1. Folder header: the labelled chip keeps its words, with up to 3 faces inside

Notion's top-bar avatars show who is looking at the page now, not who can open it, so a bare avatar stack would read
wrong. The chip stays the one place that says who can open the folder, and gets faces inside it.

```
1440, now                                         1440, proposed
파일 › 전사 공유 › Finance [👥 팀장과 관리자만]       파일 › 전사 공유 › Finance [🛡 팀장과 관리자만]
파일 › 영업               [👥 3명]                   파일 › 영업               [(A)(B)(C) 5명]
파일 › 전사 공유           [👥 팀 전체가 봐요]        파일 › 전사 공유           [🏢 팀 전체가 봐요]

390, now                                          390, proposed
‹ 전사 공유    Finance     +                      ‹ 전사 공유    Finance   [🛡] [+]    (one 44 px top-bar button:
[🔍 파일 검색 ]                                   [🔍 파일 검색 ]                         icon + number, "5" or a shield)
[👥 팀 전체가 봐요]                               (chip row removed)
```

- Faces only for "some people": at most 3, in a stable order (people named on the folder first, then by name; owner
  and admins last), then the count. The whole team keeps the building icon and words; admins only keeps a shield and
  words; my own folder keeps "나만 봐요".
- The chip keeps its width while the answer loads (a reserved, empty chip), so the header does not jump.
- Click: the Share dialog for admins (as now), the read-only "who can open it" panel for members (as now).
- "읽기 전용 폴더" (your own access) stays its own badge.

### 2. List rows: a text badge where a folder is not open to the whole team

```
1440, proposed                                   390, proposed (line 1: name + badge)
📁 Finance        팀장과 관리자만   2026.11.25      📁 Finance  관리자만
📁 영업            3명만            2026.11.24      📁 영업     3명만
📁 회의록                           2026.11.20      📁 회의록
```

- Compared with the whole team, not with the folder on screen: a folder the whole team can open gets nothing (like
  Drive); anything less gets one short text badge ("3명만", "팀장과 관리자만").
- No icon: 👥 already means "shared" (my own folders' "공유됨") and the lock means "read-only for you". No faces in rows
  (neither Drive nor Notion shows them).

### 3. (cut) The inherited-team row in the Share dialog

Cut after review: Part 1's line "'전사 공유' 폴더 설정을 따라요 · 거기서 바꾸기 ›" under General access already says it.

## Roles and states

- Owner / admin: faces, marks and the team row everywhere they open (the admin endpoints already name everyone).
- Member: **decision needed**. Today a member gets a count only where they can write and never names (DECISIONS "Who
  can see a folder, in place"). Recommendation: faces where they can write (the place they already get the count;
  names are the team's own member list, which `/api/people` gives them anyway); read-only folders keep no faces. List
  marks for members only on folders they can write. This changes that decision: a new file in docs/decisions/.
- Guest: no faces, no marks, no team row, never member names (as now: guests get no member list).
- States: team-wide, admins only, N people, only me, a team project's folder (members, "멤버 N명", project rule
  unchanged), connected copy (as its folder), pass-through (nothing), loading (nothing until the answer, never a
  number taken back), error (nothing), more than 99 ("+99").

## Performance and API

- People are grouped into classes the way the server's `classesAt` does (people with the same groups and role answer
  the same), so a folder's check is per class, not per person; the answer is cached by the rules hash (and the member
  list's version) and dropped on any change.
- Header: `GET /api/files/audience` (already called per folder visit) gets `faces: string[]` (first 3 person ids, in
  the stable order above) next to `people`. Admins: the same field; their extra `/api/admin/access/tree?limit=1` call
  stays only for the split.
- Rows: the listing adds `audience?: { kind: 'admins' } | { kind: 'people'; n }` to folder entries on the returned page
  (at most 200) that are not open to the whole team. No per-row request, no N+1.
- A timing test: 1,000 people, 200 folders on a page, the listing within a set budget.
- No migration. API fields are optional (older clients ignore them).

## Tests (when built)

Server: faces and row badges per role (admin, member read vs write, guest gets nothing) and per state; an API test that
a member never gets person ids on a folder they can only read; faces in a stable order; the 1,000-person timing test.
Web: the chip per state at 1440/390 light/dark with its width kept while loading, row badges only on folders not open
to the whole team, the phone top-bar button. e2e: the chip opens Share (admin) / the panel (member).

## Open questions for the review

1. Member faces where they can write (recommended) or nowhere (counts only, as today)?
2. Row badges for members too (only on folders they can write), or admins only?
3. 390: one top-bar button (icon and a number, recommended; removes the chip row) or keep the chip row?
