# Projects list: cards of one height, and plain words on them

- Date (UTC): 2026-11-11 06:41
- Branch: `fix/projects-even-cards`
- Status: done
- Where: trina-ax core (`web/src/pages/Projects.tsx`, web i18n, the Projects list e2e). Why: the Projects page is
  core UI in all five languages (see docs/REPOSITORY-RULES.md)
- Version impact: patch, layout and words on one page; no API, data or permission change

## Goal

On the Projects list a project with no instructions got a much shorter card than its neighbours, so the row looked
broken and empty under it. Each card also showed its raw folder path (`projects/acme-sales`), and the page line under
the title spoke of "a folder of the team folder plus instructions" and "context". Trina AX is used by ordinary people
at work, not developers: the cards should be one size and say what a person cares about.

## Scope

In:
- Cards in a row have the same height (the grid stretches its items; the card fills its cell). Every card keeps two
  lines for the instructions' first paragraph; a card without any says the project page's own "No instructions." in
  faint text, so it never collapses.
- The path line becomes who sees the project, by the rule and in the words of the project page's 멤버 line: "멤버 3명"
  for the owner and admins (its own people), "9명이 봐요" for anyone else, "나만 봐요", "나와 관리자만 봐요". One function
  gives both, so they cannot drift.
- The page line, plainly: "Keep the files, instructions and chats for one piece of work in one place." (5 languages).
- Phones (390): one card per row as now, same rules.

Out:
- "Updated 2 days ago": a project has no last-activity time in the API; adding one is a server change for another PR.
- What a non-member admin sees on a card (PR #355 adds an "in the trash" / "no members left" note to this line).

## Steps

1. Plan (this file).
2. `Projects.tsx`: grid without `items-start`, the card a flex column at full height, the who line, the two-line slot.
   Move the 멤버 line's words into one function used by `MembersRow` and the card.
3. i18n: `projects.desc` in ko, en, id, ja, es. The card reuses `projects.whoMembers`, `projects.noInstructions` and
   the who-sees strings.
4. e2e: cards in one row have one height at 1440, one card per row at 390, the who line and the empty line.
5. `changes/projects-even-cards.md`.

## Risks

- PR #355 changes the same card line and the 멤버 line's rule; whichever lands second moves the other's rule into the
  shared function.
- The two-line slot uses `min-h-[2lh]` (line-height units), so it follows the text size.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the projects
e2e specs (`project-list-menu`, `project-page`, `project-participants`, `shared-project-chats`).

## Result

Built as planned in https://github.com/trina-app/trina-ax/pull/374. The cards of a row are one height (the grid
stretches its cells; two lines' room for the instructions, "No instructions." when there are none). The path line
became who sees the project, from `whoSeesProject`, which the 멤버 line on the project page now uses too. The page
line is plain in all five languages. The e2e test puts a name that wraps beside two short ones, so the stretch itself
is checked at 1440, and checks one card per row at 390. Not done: last activity (no such time in the API).
