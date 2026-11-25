# Personal skills: daily cap per skill, quiet save reply, card and step words

- Date (UTC): 2026-11-25 20:31
- Branch: `fix/personal-skills-polish`
- Status: in progress
- Where: server/src/chat (personal-skills.ts, prompt.ts, i18n.ts), tests/unit. Why: real-AI QA of auto personal
  skills (#594/#606) found four rough edges people see (see docs/REPOSITORY-RULES.md)
- Version impact: patch — fixes to a shipped feature, no new surface or setting

## Goal

People who are not developers refine one skill a few times, read the reply after a save and the card for their own
skill. Today they hit "오늘은 더 바꿀 수 없어요" after a few refinements of the same skill, read "/weekly-report로 바로
시작…" nobody asked for, read `"meeting-notes"을(를)` on the card, and a step line with the file path
`내 파일 › skills › meeting-notes › SKILL.md`.

## Scope

In:
1. Daily cap counts distinct skills saved, changed or deleted in 24 hours (6), so repeated edits of one skill count
   once; the per-answer cap (2) and the anti-spam intent stay. Decision doc line updated.
2. Prompt rule: after a save the reply does not name the skill's slash command, file or path; one short plain line at
   most (the step line already shows it).
3. Card question for the person's own skill puts the particle after "스킬", not after the quoted name
   ("직접 만든 "meeting-notes" 스킬을 이렇게 고칠까요?"), as moveConfirm does; other languages checked.
4. The step line of a skill save always reads "스킬 고침: <name>" (its title, else its first heading, else its folder
   name): never the file path, also for a skill the person wrote, changed after their yes on the card.

Out: any change to which saves need a card; the skill list or the Skills screen.

## Steps

1. Plan (this file).
2. capReached: per-answer count as now; daily count `count(DISTINCT target)` with the current target excluded when it
   is already counted.
3. autoSkillRule: the reply rule.
4. i18n ownSkillChangeConfirm / ownSkillDeleteConfirm wording; docs/ASKS.md rows.
5. Step: find why the step keeps the path line for a person-written skill and fix it there; titleOf falls back to the
   first heading.
6. Tests in tests/unit/auto-personal-skills.test.ts; changes/personal-skills-polish.md.

## Decisions

- The daily cap is about how many different skills change in a day, not how many saves: refining one skill is one
  change of what Trina follows.

## Result

(filled in at the end)
