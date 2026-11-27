# Desktop "Your teams": action rows that read as actions (follows #693)

- Date (UTC): 2026-11-27 10:53
- Branch: `ui/team-picker-polish-2` (off #693's head 48972e692)
- Status: done
- Where: `desktop/src/ui/` (welcome.ts, ui.css). Why: the desktop app's own first screen lives there
  (docs/REPOSITORY-RULES.md)
- Version impact: patch. A visual change to one existing screen; no new feature, setting or API.

## Goal

#693 replaced the orange block and outlined box with quiet rows. A design critique of its screenshots found: the
Create and Join rows use the exact team-row recipe (filled 28px tile, 15px/500 title, a two-line row for Create), so
at a glance they read as two more teams; on the first run (no teams) nothing on the card says "press this", Create is
only a pale orange tile; "Just look around first ↗" floats on its own between the rows and the footer (it lines up
with the tiles, not the titles, and uses a text arrow); nothing in a resting row says it goes somewhere; the team
row's "···" rests at 45% of the faint colour.

## Scope

In:
- Action rows get their own voice: a bare line icon (no tile fill) except Create's "+" tile (the one accent), a 14px
  title, a faint chevron at the right (the demo row: a drawn "open outside" arrow), a 40px single-line row.
- First run (no teams): Create leads with a hairline outline and its short line ("No card · ready in a minute or two");
  with teams listed the short line is left out (people who already have a team know it).
- "Just look around first" becomes the third action row (muted title, a compass icon), so the card is one list and
  one foot line, and its text lines up with the other titles.
- The "···" rests at 75% instead of 45%.

Removed: the floating demo link on S0 and its text arrow.

Out: the flow, ids, test ids and the tab order (team rows, their "···", Create, Join, demo, Back, language); the S1
box and help views; the web app.

## Steps

1. welcome.ts `actionRow()`: optional `lead`, `quiet`, trailing chevron or external glyph; `start()` uses three rows.
2. ui.css: action-row styles (bare tile, chevron, lead outline, 40px rows), "···" resting opacity, foot gap.
3. Update `tests/unit/e-desktop-team-list-open.test.ts` for the new row code.
4. Screenshots after2-*: ko/en, light/dark, normal/narrow, first run.

## Decisions

None new; keeps docs/decisions/20261126-desktop-create-team.md and #693's plan.

## Risks

Long titles in other languages (es, id) at a narrow window: titles wrap, the chevron stays at the right.

## Tests

`bun run typecheck`, `bun run check:prepush`, the desktop unit tests, desktop e2e `create-team.spec.ts`,
`language.spec.ts`, `keyboard-focus.spec.ts`.

## Result

Built as planned. Create, Join and "Just look around first" are one list of 40px rows (bare icon, 14px title, faint
chevron or arrow out); Create's "+" tile is the one accent; on the first run Create is outlined with its short line.
Tests: the desktop unit tests, `bun run typecheck`, `bun run check:prepush`, desktop e2e create-team, language and
keyboard-focus (19 passed).
