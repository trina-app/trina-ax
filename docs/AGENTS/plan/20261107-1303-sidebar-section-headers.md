# Sidebar: 대화 and 트리나 기록 read as section titles

- Date (UTC): 2026-11-07 13:03
- Branch: `fix/sidebar-section-headers`
- Status: in progress
- Where: trina-ax `web/src/` (components/Sidebar.tsx, components/rooms/SidebarRooms.tsx, one shared class in
  components/ui.tsx). Why: a type and spacing fix in the web app's own sidebar (see docs/REPOSITORY-RULES.md).
- Version impact: patch. A visual fix; no new feature, no API or data change.

## Goal

The owner (2026-11-07, a screenshot of the English sidebar): "conversations, trina history? 저런게 눈에 너무 안띄어 다른
섹션인데". The two section titles of the sidebar are about as quiet as "Show more (2)", so the eye runs the rooms and
the AI's history together. After this, 대화 and 트리나 기록 read as the titles of two separate lists, on a computer and
in the phone's menu, in both looks, without a box, a card or a new button.

## Findings (measured before, 1440×900 and 390×844, light and dark, ko and en, member, admin and owner)

Computed in Chromium on the mock server (made-up rooms and chats, one with a long name).

1. Both titles (`h2.text-xs.font-medium.text-faint`, in SidebarRooms.tsx and Sidebar.tsx, the same classes written
   twice) are 12px / 500 / `--c-faint` (13px on phones): 5.22:1 on the sidebar (light), 5.28:1 (dark). They pass AA,
   but they are the quietest text in the sidebar.
2. "더 보기 (2)", "모든 대화", "모두 보기" and "접기" right above or below them are 12px / 400 / `--c-muted`: 7.70:1 and
   7.63:1. So the "show more" line under a list is darker than the title of the next list; the title wins on weight
   only (500 against 400).
3. Rows are 14px / 400 / `--c-muted` (15px on phones); an unread room is 14px / 600 / `--c-ink`.
4. Space: from the text of "더 보기 (2)" to the text of "트리나 기록" is 27px; from one row's text to the next is 19px;
   from a title to its first row 16px. The break between the two lists is only 8px more than between two rows.
5. Phone menu: "트리나 기록" (13px / 500 / faint) and the date heading under it, "오늘" (`text-micro` = 13px / 500 /
   faint there), look the same, so the section title reads as one more date heading.
6. The chevron is 12px in the title's colour; hover turns the title from faint to muted (lighter titles get darker on
   hover).
7. No other sidebar section title uses this style: the date headings ("오늘", "어제") are sub-headings of 트리나 기록
   and stay a step below it; the filter label beside 트리나 기록 is a value, not a title. Outside the sidebar the same
   classes label lists in the people picker and admin pages (not section titles of the sidebar: out of scope).

## Scope

In:

- One class for both titles, in `ui.tsx` (`sidebarSectionTitle`): 12px / 600 / `--c-ink` (13px on phones, from the
  `text-xs` token), 16.8:1 and 15.6:1 on the sidebar. A step smaller than the rows and heavier and darker than them
  and than "더 보기", so it is neither one more row nor as quiet as the line under a list.
- The chevron stays, in `--c-faint`; the toggle gets the sidebar's own hover fill (`hover:bg-hover`, as the "+" and the
  filter button beside it) instead of a colour change. Its text stays in line with the rows (negative margin for its
  padding).
- More room above 트리나 기록 on a computer: 24px after the 대화 list instead of 12px, so the break between the lists
  is about twice the gap between two rows. No hairline unless the screenshots show that space is not enough.
- The date headings keep 11px / 500 / faint (13px on phones), now clearly under the 13px / 600 / ink title.
- `docs/DESIGN-SYSTEM.md`: the sidebar line, the c-faint and contrast rows and a "sidebar-section" type style.
- CHANGELOG Unreleased line.
- Tests: the e2e that pins the title's size (12px) also pins weight and colour; a unit check that both titles use the
  one class.

Out:

- Rows, "더 보기" and the other entries, the nav rows above, the account row, copy, test ids, aria, the fold and "+".
- Section labels outside the sidebar.

## Steps

1. Screenshots and measurements before (done: findings above).
2. The shared class, both titles, the space above 트리나 기록.
3. Screenshots and measurements after, the same views; look at every one; adjust.
4. Docs, CHANGELOG, tests.
5. Checks; an independent review of the screenshots and the diff.

## Risks

- Space: 12px more before 트리나 기록 pushes its first rows down. The e2e "60 rooms at 1280×800" wants at least one
  AI chat in sight under five rooms; check it.
- A bold ink title must not look like an unread room (14px / 600 / ink): it is 2px smaller, has the chevron, and the
  space above it.
- Phones: the phone floor (13px) holds; the drawer has only 트리나 기록, after the nav rows.
- The five app languages: no copy change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, and the full
web e2e (chromium) on a free port.

## Result

Filled in at the end.
