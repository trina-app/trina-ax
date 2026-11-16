# Skill edits in shared project chats, and plain refusals

- Date (UTC): 2026-11-16
- Branch: `fix/shared-chat-skill-edits`
- Status: done
- Where: Team AX core (`server/src/chat/`). Why: chat and skills are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, prompt wording and a card label

## Goal

The owner asked the team AI, in a shared project chat, to change a path in a skill and to put a seal on a quote PDF.
It refused both and said "no terminal, can't run Python". This PR fixes the refusal of the skill edit and the jargon.
The PDF tools come in a separate PR (feat/stamp-pdf-skill-edits).

## Scope

In: "saving skills" out of the shared chat's not-available line (moving and renaming stay blocked); a line that a skill's
text can be changed there behind the skill card; "Always allow skill edits I ask for" on that card; one quiet line in the
answer after a skill save in a shared chat; a plain-words rule; the three lines that primed the jargon.
Out: PDF editing (its own PR).

## Steps

1. Prompt lines and the plain-words rule.
2. The card label (existing `skill_save` always-allow kind) and the quiet line (TurnExec.sharedSkillNote).
3. Tests, real-AI run, independent review.

## Decisions

`docs/decisions/20261116-shared-chat-skill-edits.md`.

## Risks

Prompt injection in shared chats: the first skill edit still needs the asker's yes on a card only they see, unless they
already chose Always allow for skill saves (their own choice).

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `tests/unit/b-shared-chat-skill-edits.test.ts`,
`tests/unit/refusal-texts.test.ts`, a real-AI run in a shared project chat.

## Result

Built as planned. Real-AI run (local dev server, made-up team): the skill path change raised the card with "Always allow
skill edits I ask for", saved after Save, and the answer ended with "People in this chat can see this change."; a
request to change text inside a PDF got a plain refusal with an alternative, no terminal/Python words.
