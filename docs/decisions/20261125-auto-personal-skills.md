# Trina keeps "how to do this task for this person" as a personal skill on its own; memory keeps standing facts

- Date: 2026-11-25
- Status: accepted
- Supersedes: "Skills are saved only when the user asks" for personal skills (chat/prompt.ts skillsSection before this
  change). [20261122-auto-memory.md](20261122-auto-memory.md) stays as it is for memory.
- Branch: feat/auto-personal-skills (the owner, 2026-11-25)
- Plan: [docs/AGENTS/plan/20261125-1136-auto-personal-skills.md](../AGENTS/plan/20261125-1136-auto-personal-skills.md)

- **Ask:** the owner: keep the words "memory" and "skill", but people should not need to know the difference; Trina
  decides on its own, saves, fixes and removes what it learned, with no offers and no asking. Keep it simple.
- **Rule (routing, prompt):** one-line facts and preferences go to memory, as before. How the person wants a kind of
  task done is a personal skill, saved in the same answer without asking. When the person corrects a task a personal
  skill covered, that skill is fixed in place; one that turned out wrong or that the person no longer needs is deleted.
  One thing goes to one store. The wording follows Hermes Agent's review prompts (NousResearch/hermes-agent,
  `agent/background_review.py` `_MEMORY_ROUTING_BLOCK`, `_LESSON_LAYER_BLOCK`).
- **Rule (origin):** a skill Trina saves on its own carries `metadata: origin: auto` in its header (the server writes
  it). Trina changes or deletes on its own only those; never person-written, team, group, project or pack skills. A
  skill the person asked for has no origin line. Accepted gap: a person who edits the file by hand and keeps the line
  leaves it "auto" (undo and the trash cover mistakes).
- **Rule (server guard):** an AI-side write into `users/<id>/skills/**` is only `<name>/SKILL.md`, UTF-8 text with a
  header that loads, no `#!` first line and no secret. Code blocks are allowed (text). Every other file, and every
  other tool that saves files, is refused there: a personal skill's scripts run in box_shell, so an AI-written script
  never lands there. The turn's gate applies the auto-memory rules: the switch "자동으로 기억하기", no saving on its own
  in side, scheduled, Slack, template or confidential chats or for guests (there only when the person's own message
  asks for a skill), the asker's own words only, 2 per answer and 6 a day.
- **Rule (delete):** delete_files moves an `origin: auto` personal SKILL.md (its folder holds nothing else) to the
  trash with no card. Every other skill path stays refused by delete_files.
- **Rule (step):** "스킬 저장함 / 고침 / 지움: <name>" with 보기 and 되돌리기, like a memory, through the file routes
  people already have (remove, restore a version, restore from the trash).
- **DS3 does not apply:** [DS3](../DECISIONS.md) forbids auto-adding pack skills of unknown origin and a "new skills,
  add them?" prompt. These skills come from the person's own words in their own chat, only they see them, and nothing
  is asked.
- **Left out:** a background review pass, a curator (stale and archived skills), a repeated-task offer, a "used this
  skill" line.
- **Version impact:** minor.
