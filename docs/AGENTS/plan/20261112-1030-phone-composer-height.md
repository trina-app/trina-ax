# Phones: a room's message box stays within about 35 % of the screen with the keyboard up

QA row TC-252 (phone audit 11-11). Expected: "the composer takes ≤ ~35 % of the visible height". After #439 the text
field was capped at 30 %, but the whole box (files' row, field, buttons, padding) took 46 % of a 390×480 view.

## Plan
- `RoomComposer.tsx`: on phones the field's cap is 35 % of the app height minus the box's other rows (5rem, or 8.5rem
  with the files' row), at most 200 px and at least one line (2.75rem).
- `phone-composer-keyboard.spec.ts`: the whole box ≤ 35 % (+2 px) with 6 files and the "@" list open.

## Result
Keyboard spec 2/2; phone attach sheet, composer-align, room-mentions, phone-keyboard and phone-overlay-back 47 passed.
