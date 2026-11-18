# Phones: the icons under an answer sit close together, as on a computer

- Date (UTC): 2026-11-18 12:24
- Branch: `fix/answer-actions-spacing`
- Status: done
- Where: web/src/components/chat/Messages.tsx (the answer's action row). Why: the row is the core chat's, shared by
  the full chat, the side chat and shared chats.
- Version impact: patch, a spacing fix

## Goal

On a phone the icons under an answer (copy, share, retry, save as a skill, the model) were spread out: each button is a
44 px tap box and the row added a 12 px gap between them, so icons stood 56 px apart against 29 px on a computer. The
group should read as one compact row from the left, like the computer's.

## Scope

In: the answer action row and its inner groups use the desktop gap (4 px) on every width; the 44 px tap boxes stay.
Out: the code block's Copy/Download text buttons (labelled buttons, a different row), the user message's row (already
4 px).

## Steps

1. Measure the row at 390 and 1440, light and dark (e2e mock).
2. Drop the phone-only `gap-3` from the row and its groups.
3. An e2e check: at 390 the gap between two icons is at most the desktop gap + 4 px, each button at least 40 px.

## Decisions

None.

## Risks

Tap boxes: buttons stay 44 px wide and do not overlap (4 px apart). Phone and desktop, light and dark checked.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, the chat e2e specs that use
the row (chat-look, phone-polish-2, chat-threads, room-copy, shared-project-chats, a11y, phone-targets) and the new
answer-actions-spacing spec.

## Result

Built as planned. At 390 the icons now stand 48 px apart (44 px tap box + 4 px), was 56 px (44 + 12); 1440 unchanged at 29 px. The new e2e spec answer-actions-spacing checks it in light and dark.
