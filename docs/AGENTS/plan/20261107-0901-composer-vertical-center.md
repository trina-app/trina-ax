# Message boxes: the buttons and the text share one centre

- Date (UTC): 2026-11-07 09:01
- Branch: `fix/composer-vertical-center`
- Status: done
- Where: trina-ax `web/src/` (the message boxes: components/rooms/RoomComposer.tsx, components/chat/Composer.tsx;
  one size in index.css). Why: a layout fix in the web app's own components (see docs/REPOSITORY-RULES.md).
- Version impact: patch. A visual fix; no new feature, no API or data change.

## Goal

In a room's message box the clip and the mic sit about 3 px lower than the text and the send button. The row is
bottom-aligned (`items-end`) and every control gets the same `mb-0.5`, but the controls differ in height (the clip and
the mic 30 px, send 36 px; on phones 34 and 40), so their centres differ. The AI chat's box nudges each group with its
own bottom padding (`pb-1`, `pb-1.5`, `pb-2`), close but not equal on phones.

After this, in every message box (a room, a thread, the AI chat on Home and in a chat): with one line of text or
none, the clip or "+", the text and its placeholder, the mic and send share one vertical centre (within 1 px). With
more lines the buttons stay at the bottom, centred on the last line (as in ChatGPT and Slack). The recording bar is as
tall as the row it replaces.

## Scope

In:

- One height for a control's slot: one text line's box (the reading line height plus 8 px above and below), a theme
  size in `web/src/index.css`. It follows the phone's larger line and the person's text size (both rem).
- RoomComposer: the clip and the mic and send sit in slots of that height, centred; the row stays bottom-aligned; no
  per-button margins. The recording bar is the row's height (its content at least one slot).
- Composer (AI chat): the same slots for "+" (phones), the mic and send / stop / send-later / send-answer, in place of
  the three bottom paddings; the text box's bottom padding becomes the slot's 8 px, the rest of the space under it
  moves to the row, so the box keeps its height.
- An e2e spec that measures it with getBoundingClientRect: empty and four lines, in a room, a thread and the AI chat
  box, at 1440 and 390 px.

Out:

- The edit form of a room message (its buttons are in a row under the text, not beside it).
- Any change of sizes, colours, hover and focus styles, tooltips or test ids.

## Steps

1. Screenshots before (1440 and 390, light and dark, empty and four lines) of the three boxes.
2. The alignment spec (fails before the fix).
3. The slot size and the two boxes and the recording bar.
4. Screenshots after; an independent visual and CSS review; fixes.
5. Checks, CHANGELOG, PR to dev.

## Risks

- The phone app (coarse pointer: 16 px+ text in the box) keeps the line height, so the slot still fits.
- The "#" token layer of the AI chat's box copies the text box's padding by class: it changes with it.
- Tooltips wrap the button itself (no wrapper changes what they anchor to).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run --cwd web build`, the e2e specs
`voice.spec.ts`, `chat-look.spec.ts` and the new one, and the web unit suite in Docker like CI.

## Result

- `--spacing-composer-line` (`calc(var(--leading-reading) + 1rem)`) in `web/src/index.css`; the room and thread box
  and the AI chat box put every control beside the text in an `h-composer-line` slot, centred; the rows stay
  `items-end`. The AI chat's text box has `pb-2` and its row `pb-1` (the box keeps its height); an answer to the AI's
  question uses `pt-2` (it rendered so with the slot). Both recording bars are `box-content min-h-composer-line` with
  the row's padding, so they are exactly as tall as the row.
- Measured before (e2e and screenshots): room and thread 3 px off on computers, 2–4 px on phones and in a narrow
  window; the AI chat's "+" 1.5 px off on phones; the AI chat's box 12 px (14 px on phones) taller while recording.
  After: within 0.5 px everywhere, also at the largest text size and while an answer runs. The AI chat box on a
  computer is pixel-identical to before.
- `web/test/e2e/composer-align.spec.ts`: 9 tests (computer 1440, narrow window 700, phone 390 with touch).
- An independent review (screenshots and CSS) found nothing that must be fixed; its should-fix (check that the
  largest text size took effect) and three nits were applied. Left as is: the ✓ in the AI chat's recording bar is
  6 px from the box's top and bottom (the room box's send has 8 px), and the AI chat's "#" token layer can differ from
  the text box's font size where the reading size is under 16 px on a touch screen (older than this change).
- Differs from the plan: VoiceBar.tsx itself did not change (its callers pass the slot classes).
- PR: https://github.com/trina-app/trina-ax/pull/158
