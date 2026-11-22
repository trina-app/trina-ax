# Demo banner: the AI sees the banner's current words and changes only the part asked for

- Date (UTC): 2026-11-22 00:51
- Branch: `fix/demo-banner-current-words`
- Status: in progress
- Where: server (demo fakes, change_banner_text, the demo note in the AI's instructions). Why: the owner's live ko demo
  test of 11-22 (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a demo-only fix of the AI's banner edits

## Goal

In the 유자 진저 project chat the launch banner says "흐린 아침에, 작은 햇살 한 잔.". The owner asked "흐린 아침 말고,
밝은 아침으로 해줘". The AI took it as a request for a new scene photo, then rewrote the whole headline with made-up
words, then said it did not know the original words. It took four messages to get "밝은 아침에, 작은 햇살 한 잔.".
After this change the first message gives that headline.

Root cause: the AI never sees the banner's current words (only the tool result of the turn that drew it, which a later
turn may not keep), and change_banner_text can only replace a whole field. So a partial edit means retyping words it
does not know. The last banner was also one per demo instance, not per chat or project.

## Scope

In:
- The current words of the last banner in this chat's project (else this chat), or the launch words, go into the demo
  note of every turn (prompt.ts DEMO_BANNER_NOTE + a "current banner" line built from the kit and the saved state).
- change_banner_text gets `replace: [{ from, to }]`: a phrase replaced in the current words, everything else kept. A
  `from` that is not on the banner fails with the current words listed.
- Every result says these are now the banner's full current words (headline, line, badge, button, size, photo).
- The last banner is kept per project (else per chat): a banner made in a chat of another project does not change
  this one.
- Instructions: "X 말고 Y", "change X to Y", "X → Y" → replace; words the user did not name stay as they are; words
  that are on the banner make a text edit, never a new-scene request.

Out: the hosted demo itself (deployed separately), Higgsfield's generate_image scene matcher (the prompt rule routes
banner words away from it).

## Steps

1. State: `banner.scope` on a saved banner; DemoBanners.current(scope) and make(args, scope).
2. replace mode in banners.ts (exact match first, then one that ignores spaces, line breaks and *stars*).
3. Tool: input `replace`, the scope from the turn's chat (project id, else chat id), the result line "current words".
4. prompt.ts: the demo input carries the current words; the demo note says how to use them and replace.
5. turn.ts passes the current words for the chat's scope.
6. Tests: replace (incl. not found), the words in the instructions, the 4-message transcript as tool calls, per-project
   state.

## Decisions

none

## Risks

Demo only (the tool and the note exist only on a demo server with a banner kit). The demo note now changes after a
banner edit, so a demo turn's instructions differ from the previous turn's; that is only on demo servers.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, tests/unit/*demo*.test.ts, b-shared-save-card,
the prompt tests.

## Result

(filled in at the end)
