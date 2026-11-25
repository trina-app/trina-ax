# Trina keeps "how I want this task done" as a personal skill on its own

- Date (UTC): 2026-11-25 11:36
- Branch: `feat/auto-personal-skills` · Status: in progress (scope cut by the owner: one PR, no review pass, no curator)
- Where: server/src/chat (prompt, tools, personal-skills.ts), server/src/skills/guard.ts, shared step labels, web
  Steps.tsx. Why: memory, skills and the prompt live in the core (docs/REPOSITORY-RULES.md)
- Version impact: minor (Trina saves, fixes and removes personal skills on its own: new behaviour people see)

## Rules (prompt, chat/prompt.ts AUTO_SKILL_RULE next to AUTO_MEMORY_RULE, only when auto memory is on)
1. One-line facts and preferences → memory, as today. "How I want this kind of task done" → a personal skill, saved
   in the same answer without asking. A correction of a task a personal skill covered → fix that skill in place. A
   skill that turned out wrong, or the person says it is not needed → delete it. One thing goes to one store.
2. Only skills marked `metadata: origin: auto` are fixed or deleted on Trina's own; never person-written, team, group,
   project or pack skills. The promise rule: never "next time I'll…" unless something was saved.

## Server (small)
- skills/guard.ts: an AI-side write into `users/<id>/skills/**` passes only for `<name>/SKILL.md`: UTF-8 text, a header
  that loads, no `#!` first line, no secret (code blocks are fine: they are text). Every other file (scripts/, assets,
  other tools: unzip, save_url, moves) is refused. box_shell already cannot write there.
- chat/personal-skills.ts, called from the file tools' gate in chat/tools.ts: the auto-memory rules for that path (the
  switch "자동으로 기억하기"; none on its own in side, scheduled, Slack, template or confidential chats or for guests:
  there only when the person's own message asks for a skill), the asker's own words only (auto memory's copy and
  address checks), 2 per answer and 6 a day on its own. The server writes `origin: auto` into a skill it saves on its
  own and keeps the origin as it was on a change; a change on its own only to an `origin: auto` skill.
- delete_files: one exception, an `origin: auto` personal SKILL.md (its folder holds nothing else) goes to the trash
  with no card.
- Step: "스킬 저장함 / 고침 / 지움: <name>" with 보기 and 되돌리기, through the existing file routes (remove, restore a
  version, restore from the trash); no new table, no new route.

## Notes on the brief
- The existing write path has no checks today and can write scripts (personal skill scripts run): the guard closes it.
- Origin in frontmatter can be edited by hand; accepted (undo and the trash cover mistakes).

## Left out
Background review pass, curator, repeated-task offer, "used this skill" line, change-log table, new API route.

## Tests
Unit: the guard, the place/switch/own-words gate, origin, delete, the step labels; prompt-scenario checks with the fake
engine. `bun run typecheck`, `bun run check:prepush`.

## Result
Filled in at the end.
