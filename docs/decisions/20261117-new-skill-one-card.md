# A new skill: the name asked once, one save card, plain words on the card

- Date: 2026-11-17
- Status: accepted
- Note: its pass-through for other files (no card after a Save on SKILL.md) is replaced by [20261117-new-skill-files-on-card.md](20261117-new-skill-files-on-card.md)
- Supersedes: none (extends 20261116-skill-save-one-card.md)
- Branch: fix/qa-man-052 (QA hands-on AI row MAN-052)

- **What happened:** "Make this a skill for the team" with an attached leave request form showed two save cards, one
  for `skills/leave-request/SKILL.md` and one for `skills/leave-request/assets/leave-request-form.md`. Both showed only
  the raw file ("---", "name:", "## Steps"). The AI picked the name itself and did not ask.
- **Cause:** `confirmSkillWrite` (server/src/chat/turn.ts) asks once per write call into a skills folder, and the AI
  saved the skill in two calls. The skills section of the instructions said how a SKILL.md starts, but nothing about the
  name or about keeping a form in the skill. The card's preview (web AskCard SkillPreview) shows only the diff.
- **Rule:**
  - Instructions (`NEW_SKILL_RULE`, server/src/chat/prompt.ts): when the user did not say the skill's name, ask once
    with ask_user, with one suggested name as the first choice. Keep a new skill in one SKILL.md, with a short form or
    template word for word as a section. Use assets/ or references/ only for a file that must stay as it is, and save
    SKILL.md first. Say in plain words what the skill does; do not paste the file.
  - Server: skill cards in one answer are asked one after the other. After the person says Save on a new SKILL.md, the
    other new files in that skill's folder in the same answer need no card of their own. An existing file, a file saved
    before the SKILL.md, another skill's folder, another answer, a "Don't save" and content that the SKILL.md's yes did
    not cover for more people still ask.
  - Card: a new skill's card shows "What it does" (the description) and "Parts" (its `##` titles); the diff stays one
    click away under "Show the file". Changes, rules and other files keep the open diff.
- **Why the owner's OK:** the skill card guards what every teammate's AI follows. With this change a Save on SKILL.md
  also saves the skill's other new files without showing them. The SKILL.md decides when those files are read, and
  the person saw it, but the files' own text is not shown. The instructions keep a new skill in one file, so this
  path is the fallback.
- **Tests:** `tests/unit/b-new-skill-one-card.test.ts` (one card for SKILL.md then a form file; the cases that still
  ask; the instructions), `web/test/unit/ask-card-new-skill.test.tsx` (the plain words, the folded file, a change keeps
  the diff), `web/test/e2e/team-skills.spec.ts` (opens "Show the file" before it checks the diff).
- **Version impact:** patch (AI instructions, one card fewer, card words; no data change).
