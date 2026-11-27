# Desktop "Your teams": quiet action rows instead of the orange block

- Date (UTC): 2026-11-27 10:28
- Branch: `feat/team-picker-actions-redesign`
- Status: done
- Where: `desktop/src/ui/` (welcome.ts, ui.css) and `desktop/src/common/i18n.ts`. Why: the desktop app's own first
  screen lives there (docs/REPOSITORY-RULES.md)
- Version impact: patch. A visual change to one existing screen; no new feature, setting or API.

## Goal

The owner finds the actions under the team list on the desktop "Your teams" screen ugly: a big solid orange block
("Create a team for free", dark text on orange that reads poorly), a big outlined box ("Join with an invite link") that
does not match it, a loose demo link, and a footer with a "Language" label and a wide select. Team pickers in Slack,
Notion, Linear, Figma and Discord show "create" and "join" as quiet list rows in the same style as the workspace rows,
each with a small icon tile, and keep colour to one small accent.

## Scope

In:
- "Create a team for free" and "Join with an invite link" become list rows with the team rows' geometry: a 28px tile
  (a "+" for create, a link icon for join), the title, and for create a short muted subline. The "+" tile is the
  screen's one accent; the rows themselves use the team rows' hover fill.
- A hairline divides the team list from the action rows (only when teams are listed).
- The create subline gets shorter in all six languages ("Free, no card · ready in a minute or two").
- "Just look around first ↗" stays a small muted ghost link, aligned with the rows.
- Language becomes a compact footer control (a globe icon and the select, no visible "Language" word; its accessible
  name stays "Language").
- The team row's outlined "Open" shows on hover and keyboard focus (always on touch screens), so a resting list is not
  a column of buttons. The whole row stays the one button that opens the team.

Removed: the orange block, the outlined box, the visible "Language" label, the always-on "Open" pills.

Out: the create and join screens after S0, the web app, the Mac App Store build's first screen (it keeps ①).

## Steps

1. welcome.ts `start()`: action rows (`button.action-row` with an icon tile, title, optional sub), same test ids and
   ids (`create-team`, `join-team`, `demo`) so focus and e2e code stay.
2. welcome.ts `languagePicker()`: a globe glyph, an sr-only "Language" in the label.
3. ui.css: action-row styles from `.team-row`, remove `.choice*`, compact `.language`, Open pill on hover/focus.
4. i18n.ts: shorter `start.createSub` in ko, en, id, ja, es, zh.
5. Update `desktop/e2e/create-team.spec.ts` and `tests/unit/e-desktop-team-list-open.test.ts` for the new subline and
   the hover Open.
6. Before/after screenshots: ko and en, light and dark, narrow and normal width, keyboard focus.

## Decisions

None new. Keeps docs/decisions/20261126-desktop-create-team.md (what S0 offers); only its look changes.

## Risks

Korean and the other languages must fit at a narrow window (the subline wraps, titles do not clip). Keyboard order
stays: team rows, their "···", Create, Join, demo, Back, language. Touch screens keep 44px targets.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun test tests/unit/e-desktop-team-list-open.test.ts
tests/unit/e-desktop-common.test.ts`, desktop e2e `create-team.spec.ts` and `language.spec.ts`.

## Result

Built as planned. Create and Join are list rows with a 28px tile ("+" in the accent-soft fill, the one accent; link in the plain fill) under a hairline; the create line is shorter in all six languages; Language is a globe plus a content-sized select with a ring round both; "Open" shows on hover, keyboard focus and an open menu (always on touch screens). References (Notion join/create rows, Linear and Figma switchers with a check on the current workspace, Discord's create/join rows) all use quiet rows and almost no colour. Tests: the two unit files, desktop e2e create-team, language and keyboard-focus.
