# The AI saves a new skill as a folder with SKILL.md

- Date (UTC): 2026-11-16 05:00
- Branch: `fix/skills-save-as-folder`
- Status: done
- Where: server/src/chat. Why: the save instructions live in the prompt and the write note (see docs/REPOSITORY-RULES.md)
- Version impact: patch, the AI's save instructions change; nothing that loads changes

## Goal

Asked to make a skill (from a form or a chat), the AI saved `skills/agreement-draft.md`, a single file with a header
(AI scenario check SKL-06, root cause #9). The prompt told it to: the team, group and personal save lines said
`<root>/<short-name>.md`; only the project line said `<short-name>/SKILL.md`. New skills should be the standard
folder form `<root>/<name>/SKILL.md`, which holds a form, a title and extra files.

## Scope

In: the team, group and personal save lines in `skillsSection` say `<root>/<name>/SKILL.md` (the folder name is the
name). `skillWriteNote`: when the AI creates a NEW single .md skill file with a header in a skill root, the result
says to use the folder form. Unit tests.
Out: old single-file skills keep loading and are not moved; team rule files (skills/*.md without a header) are
unchanged; no refusal of a single-file skill.

## Steps

1. Prompt lines (prompt.ts skillsSection).
2. Write note for a new single-file skill (skills.ts, files/service.ts write).
3. Tests, docs.

## Decisions

none (the folder form is the standard already: docs/DECISIONS.md "Skills: Agent Skills folders").

## Risks

Prompt text is in every turn: the lines get a few words longer. No migration, no UI.

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run changelog:check`, the skill unit tests; scenario SKL-06, SKL-03.

## Result

Built as planned. The note is a hint, not a refusal: a refusal of new single-file skills would change older paths and
tests, and the prompt line is what fixes SKL-06 (after-run: the AI wrote skills/<name>/SKILL.md both times). Also fixed
on the way: a member who cannot write skills/ got "with the same header" for their personal skills with no header said
before it; the first save line now says the header. The AI picked a Korean folder name once
(skills/업무협약서-초안/SKILL.md): that loads only with fix/skill-names-unicode, so #1069 must merge first (or together); this PR merges after #1069. Review follow-up: the header also says "no dots or underscores", and a test covers a project-only writer, whose project line carries the full header.

