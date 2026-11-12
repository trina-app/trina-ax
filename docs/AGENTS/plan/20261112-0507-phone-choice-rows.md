# Phones: settings choices as rows that open a sheet, not select boxes

- Date (UTC): 2026-11-12 05:07
- Branch: `fix/phone-choice-rows`
- Status: in progress
- Where: `web/`. Why: the phone app is a WebView of the web app, so a phone's look is the web app's below 768 px.
- Version impact: patch, phone layout only; no API or data change.

## Goal

QA TC-378. The owner: "아직도 우리 모바일 화면이 많이 구린데… 아직도 데스크톱 화면이 그냥 단순히 모바일로만 된게 많은데".
Team settings and Usage on a phone still show a computer's form: select boxes ("한국어 ⌄", "Claude ⌄", "Off ⌄",
"Range Last 30 days ⌄"), a two-part segmented box ("No (default) | Everyone") and number fields with ⌃⌄. On a phone each
setting becomes one row "Name   value ›" (or a switch); a tap opens a bottom sheet with the choices, ✓ on the current
one. Computers stay as they are.

## Scope

In:
- One phone primitive, `components/phone/PhoneChoice.tsx`: a choice row (name, short line, value, ›) and a choice pill
  (a toolbar's "Range  Last 30 days ›"). A tap opens the existing bottom sheet of `rooms/MenuButton.tsx` (Back closes it
  through `useOverlayEntry`) with ✓ on the current choice; a pick calls the same `onChange` the select had. A long list
  (time zones) opens scrolled to the current one.
- Team settings › General (language, time zone), Members & AI (presentation length), AI engine (engine, model; "who
  picks" as ✓ rows), Voice input (speech to text), Keeping data, and the number fields there: no spinners, the numeric
  keyboard, value and unit at the row's end.
- Admin › Usage (Range, Group by) and Me › Usage (Period): `FilterPill`'s setting pills (`neutral`) open the sheet on a
  phone. The filters inside the Filters sheet stay as they are (PR #568's part).
- Other `<select>`s on pages a phone shows, where it is straightforward; the rest listed in the PR with the reason.

Out:
- `ui.tsx` shared defaults (TC-189), the selects inside dialogs (a sheet over a sheet), Members and Audit (PR #568),
  Profile and Change password (PR #566).

## Steps

1. `PhoneChoice.tsx` on top of `MenuButton` (no second sheet system).
2. Team settings and its AI groups: a phone branch per control; saving stays as it is (the form's save bar, the AI
   groups' Save, immediate for Usage).
3. `FilterPill`: a phone branch for setting pills.
4. Survey the other selects; convert the straightforward ones.
5. i18n in the five languages where words are new; phone e2e (Chromium and WebKit, 390×844, touch); 1440 screenshots
   before and after.

## Risks

- Saving must not change: each row calls the handler the select called.
- PR #568 changes Usage's phone toolbar: the Range pill changes inside `FilterPill` only, not Usage's lines.
- Desktop unchanged: every change is behind `max-width: 767.98px`.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`; new phone
e2e `phone-choice-rows` (no select in sight, the value in each row, the sheet with ✓, a pick saves, Back closes).

## Result

(filled in at the end)
