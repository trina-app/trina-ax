# Prepared skills: names and one lines in the viewer's language

- Date (UTC): 2026-11-22 05:00
- Branch: `fix/skill-labels-viewer-lang`
- Status: done
- Where: server (onboarding/skill-packs.ts catalog, skills/examples.ts Home block), tests. Why: QA TC-7962, TC-7963
- Version impact: patch, a display fix (labels only; the installed skill text and the API shape are unchanged)

## Goal

1. TC-7962: a team and account in 日本語 saw "Natural writing" and "Company slide deck" in English in the skills step,
   on Team skills › "트리나가 준비한 스킬" and in the example dialog titles. The title came from the pack's SKILL.md,
   and those packs have only Korean and English text. After this change every prepared skill has a display title in all
   six app languages.
2. TC-7963: an account in 한국어 on a 日本語 team saw Japanese names next to Korean one lines. After this change the name
   and the one line both follow the viewer's UI language, like the rest of the UI.

## Scope

In:
- A TITLE table next to SUMMARY in skill-packs.ts (en, ko, ja, zh, es, id for all eight prepared skills; in the
  languages a pack has text in, the SKILL.md's own title, and a test holds them equal). `packTitle(name, locale)`.
- skillPackCatalog: `title` = packTitle(name, caller's locale) (GET /api/onboarding/packs; the skills step, the Team
  skills fold and the example dialog all read it).
- teamPrepared (GET /api/skills/examples, Home's block and its example dialog): a kept skill whose installed title is
  still one of the pack's titles (any language) or its name shows packTitle in the caller's language; a title the team
  edited stays.

Out: the installed SKILL.md (still the team's language, English when the pack has none), slash names, the web (it shows
the server's fields), the examples' bodies.

## Steps

1. TITLE + packTitle; the catalog and the Home block use them.
2. Tests: a ja team with a ja account sees every name in Japanese; a ko account on a ja team sees Korean names and
   lines; the response keeps its shape (an older client reading `title`/`description` works); TITLE matches each pack
   text's title.
3. changes/skill-labels-viewer-language.md.

## Decisions

Owner's (relayed): display labels follow the viewer's UI language; the installed text follows the team language.

## Risks

- A team that edited an installed skill's title to exactly another language's pack title sees the viewer's title on
  Home. Acceptable.
