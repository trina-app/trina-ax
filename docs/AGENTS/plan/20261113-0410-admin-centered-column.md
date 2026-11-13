# Admin pages: the content column sits in the middle of the area

- Date (UTC): 2026-11-13 04:10
- Branch: `fix/admin-centered-column`
- Status: in progress
- Where: web/src/pages/admin/AdminLayout.tsx. Why: Team settings and System stay at the left edge of the area (QA TC-193, tracking TC-743).
- Version impact: patch, a layout fix on computers only

## Goal

On a computer, every admin page keeps its column in the middle of the area beside the menu, with equal space on both
sides. Today the wide pages (6xl column) are centred, but Team settings and System pin their own narrow (3xl) form to the
left, so a third of the area is empty on the right.

## Scope

In: the shared admin layout wraps the page in one column: narrow (3xl) and centred for the form pages (Team settings,
System), the usual width for all others. The "Applies to everyone" line and the page title move with the column.
Out: page contents, the Providers page and Connectors dialogs, phones (unchanged, a separate branch of the layout).

## Steps

1. AdminLayout: a column div with `mx-auto max-w-3xl` for settings and system.
2. Measure and screenshot all admin pages at 1440 and 1920, menu shown and hidden; 390 unchanged.
3. Run the admin e2e specs.

## Risks

Wide pages (Activity log, Usage, Members) keep the same width as before. Pages inside the narrow column keep their own
max-w-3xl, which is now the same width.

## Plain-words check

No words on screen change.

## Result

(fill in at the end)
