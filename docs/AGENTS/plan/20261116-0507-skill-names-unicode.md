# Skill folders may have names in any language (거래처-응대)

- Date (UTC): 2026-11-16 05:07
- Branch: `fix/skill-names-unicode`
- Status: in progress
- Where: server/src/chat/skills.ts, server/src/skills, web/src/pages/Skills.tsx. Why: the name rule lives in the
  skill loader and the places that check a new name (see docs/REPOSITORY-RULES.md)
- Version impact: patch, skills that were left out now load; no data change

## Goal

`skills/거래처-응대/SKILL.md` with `name: 거래처-응대` failed the name rule (lowercase a-z, 0-9, hyphens) and was left
out of the skill list without a word to the person using it; the AI then said "you have no access" (AI scenario
check SKL-11, root cause #10). Office workers name folders in their own language. The Agent Skills reference
validator (skills-ref) accepts Unicode lowercase letters too, so the rule can follow it.

## Scope

In: one name rule (`isSkillName`): words of lowercase letters (any script; no capitals where the script has case),
marks and digits joined by single hyphens, at most 64 characters, NFC and NFKC-stable (no full-width or compatibility
forms); the folder name compared NFC. Used by the loader, the write note, a renamed or moved copy, skill_files'
rename, skill shares and suggestions, and the Skills page's folder-name check. "/거래처-응대" runs it. Server and web
texts that state the rule.
Out: plugin manifests (`shared/src/plugins.ts`, another format); generated names (drafts, imports) stay ASCII
slugs as before.

## Steps

1. Rule in chat/skills.ts; the other checks use it.
2. Texts (server tool results, server/src/skills/text.ts, web i18n).
3. Tests; decision file.

## Decisions

docs/decisions/20261116-skill-names-unicode.md (changes the "lowercase ASCII" note in docs/DECISIONS.md "P —
Onboarding polish").

## Risks

Look-alike letters from another script (a Cyrillic "о"): names are compared exactly, and a title can already be any
text, so this adds no new way to look like another skill. Paths with non-ASCII folder names already exist everywhere
in the team folder. Five app languages for the changed texts.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run changelog:check`, the skill unit
tests; scenario SKL-11, FLOW-02, SKL-03.

## Result

