# Phone polish: small items from the 11-11 phone audit (QA TC-265)

- Date (UTC): 2026-11-11 17:08
- Branch: `fix/phone-polish-small`
- Status: done
- Where: trina-ax (web). Why: rough edges of the core web app's phone screens (see docs/REPOSITORY-RULES.md)
- Version impact: patch, look and wording fixes on existing screens; no API or data change

## Goal

Small things a person met on a phone (390 px) in the 11-11 audit, each fixed where it is drawn.

## Scope

In:

1. Dark theme: a Mermaid diagram in an answer is drawn with Mermaid's dark theme on a dark card (it was a white box).
2. Answer tables: a cell with one number and a short unit ("1,234,567원", "12,345건", "3.5만 원") stays on one line
   with tabular digits, like a bare number already did.
3. A file preview (the side panel, a full-screen sheet on a phone) and the image/file viewer make the page behind them
   inert (no tap, scroll or focus reaches it) while they are open.
4. Counters ("2 / 6", "v2 / 6") never wrap: the artifact version, deck page, answer branch, viewer count, PDF page.
5. Usage filters (FilterPill) show one ⌄: the one every `<select>` draws (index.css); the pill's own icon goes.
6. (dropped) The blank band above the Settings list: not reproduced on `dev` at 390 px (with or without a top inset),
   and the open phone Settings redesign (#339, #340, #342, #344) replaces that list; left to it.
7. The empty room box's placeholder is shorter in all five languages, so it fits on one line on a phone.
8. The room's ✦ side chat on a phone (already full screen) has no "Open full screen"; the file viewer's sheet keeps it.

Out: my messages on the right (CHATS-24), where side-chat history lives (CHATS-21), what tapping a member shows
(CHATS-20): owner decisions. Mermaid artifacts (their own sandboxed page) keep their look.

## Steps

1. Plan (this file).
2. The fixes above; unit test of the number cell rule; e2e at 390×844 of each item.
3. Checks (typecheck, check:i18n, check:docs, web unit, touched e2e), before/after screenshots, independent review.

## Risks

Inert on the app under the viewer: toasts and dialogs sit outside the Layout (App.tsx, portals), so they stay
reachable. Five languages for the placeholder. Overlap with #339–#344: FilterPill and SideChatPanel are not in them;
Settings is left alone.

## Result

All items but 6 done; see the PR.
