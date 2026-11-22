# Demo notes: headline vs. word edit, verbatim words, no tool for a recolor, no false send apology

- Date (UTC): 2026-11-22 03:33
- Branch: `fix/demo-replay-prompt`
- Status: done
- Where: server, the demo notes in the AI's instructions (`server/src/chat/prompt.ts` DEMO_BANNER_NOTE,
  DEMO_FAKES_NOTE) and their unit tests. Why: the live replay of the owner's own asks on demo.trina.app (0.9.1)
- Version impact: patch, a demo-only fix of the AI's instructions

## Goal

The owner's replay on demo.trina.app failed four ways:

1. After the banner "흐린 아침 → 밝은 아침", the owner sent only "작지 않아 큰 햇살이야!". The AI swapped one word
   ("밝은 아침에, 큰 햇살 한 잔.") instead of making the phrase the headline. The note led with "change only the words
   the user named… never rewrite", which outweighed the short-phrase rule.
2. The retry added a comma ("작지 않아,\n*큰 햇살이야!*").
3. "change bag color to red not green" got a Higgsfield "Generate image" send card and then a long answer.
4. After a Gmail send through the card, the AI apologized for "not showing the draft first", though the card showed it.

After this change: a standalone phrase after a banner becomes the whole headline, exactly as typed; a recolor or edit
of a photo gets one short line listing the prepared scenes, with no tool call; no apology after a card send.

## Scope

In (prompt.ts only):
- DEMO_BANNER_NOTE: one rule with priority. (a) old→new words named → edit exactly those words. (b) a standalone
  phrase with no edit verb right after a banner, or "make the headline …" → the whole headline is that phrase.
  (c) never mix the two. English examples only.
- DEMO_BANNER_NOTE: use the user's words and punctuation verbatim; only the renderer picks line breaks.
- DEMO_FAKES_NOTE: list the prepared scenes (the banner kit's scene ids one-cup, two-cups, pouch, cafe, in English
  words; the green pouch in every photo); recoloring or editing a photo is impossible here; a recolor, an edit or an
  unlisted scene gets one short line with no tool call, offering the listed scenes.
- DEMO_FAKES_NOTE: the send card shows the full draft before sending; never apologize for not showing it.

Out: `server/src/tools/demo-banner.ts` and `web/` (another agent's), the hosted demo.

## Steps

1. prompt.ts: DEMO_SCENES (scene id → English words), the rewritten notes.
2. Tests: the rules, the scene list matching the Steepling kit's scenes.json ids, no Korean in the notes.

## Decisions

none

## Risks

- A phrase meant as a word edit but sent with no edit verb now replaces the whole headline. The AI offers to undo.
