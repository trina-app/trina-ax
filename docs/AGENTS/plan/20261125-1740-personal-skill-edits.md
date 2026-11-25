# Personal skills: Trina can finish fixing a skill it made; plain names; a waiting card looks waiting

- Date (UTC): 2026-11-25 17:40
- Branch: `fix/personal-skill-edits` · Status: done
- Where: server/src/chat (personal-skills.ts, prompt.ts, turn.ts), server/src/skills/personal-guard.ts, shared step
  types, web Steps.tsx. Why: the personal-skill gate and the step list live in the core (docs/REPOSITORY-RULES.md)
- Version impact: patch (fixes to the feature of #594: edits that were refused, a doubled header line, wording, a step
  mark; no new behaviour)

## Goal

Real-AI QA of #594 (local copy, step c "5개로, 앞으로도"): Trina updated only a notes line of a skill it had made; step 2
still said "정확히 3개", and every later edit was refused ("its words … come from tool output"). Also: the header had
`origin: auto` twice; the saved line and the answer said "SKILL.md" and "/weekly-report"; the step showed "파일 수정 ✓"
while the person's card was still open.

## Root causes and fixes

1. **Own-words check counts the skill's own text as tool output.** Trina reads the skill before editing it; that read
   is outside content (rt.outside), so a changed line that keeps most of an old line ("2. … 정확히 5개") is a "copy".
   Fix: for a save into a skill, the skill file's current text counts as the person's own words (it passed the same
   check when it was saved, or the person wrote it, or its change was on a card); every other file, page or message
   still counts as outside. Only lines new against the old file are checked (as before).
   Prompt: a correction changes every place of the skill it affects (the step itself), not a note added below it.
2. **Two origin lines.** The AI wrote `origin: auto` at the top level itself and the server added it under
   `metadata:`. Fix: one place, `metadata: origin: auto`; withOrigin removes any top-level `origin:` line, and
   originAuto reads only the metadata one. The prompt no longer names the line (the server writes it).
3. **Jargon.** A skill gets a display name in the person's language in `metadata: title:` (the field the Skills page
   and the "/" list already show: chat/skills.ts readSkillTitle); the folder name stays the "/" name. The step line and
   the cards say the title; the prompt says: call it 스킬 "<title>" and never name the file, its path or the "/" command
   unless the user asks how to start it.
4. **A waiting card looks done.** A call whose card waits after the answer (chat/turn.ts markCallWaiting) keeps a ✓.
   Fix: the step is marked `waiting` (a waiting icon and "Waiting for your answer"); when the card's answer runs the
   call again (replayCalls), the original step becomes ✓ or "Declined".

## Tests

Unit: read then edit step 2 from 3 to 5 saves; an edit that adds a page's text is still refused; a rewrite in place of
an auto skill's lines saves; one origin line after the AI wrote one at the top level; the step and card use the title;
a waiting step's mark and its settle after the answer. `bun run typecheck`, `bun run check:prepush`.

## Result

Built as planned. The skill's current text joins the person's own words for its own save (chat/personal-skills.ts
ownWordsProblem); withOrigin removes any top-level origin line; the step line and the cards say the skill's title; a
waiting card's step carries `waiting` until its answer settles it (chat/turn.ts settleWaitingStep), and such a step
stays in view while the step list is folded. The regression test for the edit fails without the fix (checked). Tests:
tests/unit/personal-skill-edits.test.ts, web/test/unit/steps-card-waiting.test.tsx; prompt pins recorded again.
