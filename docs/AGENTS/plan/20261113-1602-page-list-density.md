# Page lists use page density (TC-1050)

- Date (UTC): 2026-11-13 16:02
- Branch: `fix/page-list-density`
- Status: in progress
- Where: `web/src/components/list/List.tsx` (ListRow), its tokens in `web/src/index.css`. Why: the row's density is a
  shared list decision, so a page's main list gets it from the shared piece, not from markup of its own
  (docs/REPOSITORY-RULES.md, docs/DECISIONS.md "Lists: every row on ListRow").
- Version impact: patch: a layout fix, no API or data change.

## Goal

The owner, 2026-11-13, at 1440 on a project page: "isn't the row height too short? is it supposed to be like that?"
#752 gave "Trina history" 48 px rows with titles flush with the heading; #753 moved them onto ListRow, which has the
sidebar's density (30 px rows, 12 px inset), so the rows shrank and the titles moved in from the heading. A page's main
list should not use the sidebar's density.

## Scope

In:
- `ListRow` `scale="page"`: rows at least 48 px on a computer and a phone (`--spacing-row-page`), the row's words flush
  with the section's heading and its hover fill bleeding out past them (a negative margin), the "···" and `actions`
  moving out with it so the time column stays at one edge; read names in ink (a page's list is read, not scanned).
- Use it for the project page's chats and folded task (ProjectChatRow, ProjectTaskRow) and the 팀 스킬 page's skills
  (AvailableSkills), dropping their callers' `-mx-3`.
- e2e `web/test/e2e/project-schedule-row.spec.ts`: row heights, title x = h2 x within 1 px, time right edges, faces.
- DECISIONS note "Page lists: page density", `changes/page-list-density.md`.

Out: panels, the sidebar, phone tabs and the drawer keep `rowBox` (30 px / 48 px phone). The task page's runs list
(two-line rows, already ~50 px) and the project files box (a side panel) stay as they are.

## Steps

1. Token `--spacing-row-page` and `pageRowBox` beside `rowBox`/`headBox`; `scale` on ListRow.
2. Project page rows and the skills list on it.
3. e2e, screenshots before/after at 1440/390, light/dark, owner/member.
4. typecheck, check:i18n, web unit, affected e2e.

## Risks

Shared component: the default stays the panel density, so every other ListRow is unchanged. No migration, no copy.
