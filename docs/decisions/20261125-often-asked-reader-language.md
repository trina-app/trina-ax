# What my group often asks: in each reader's own language

- Date: 2026-11-25
- Status: accepted
- Supersedes: in [Home: what my group often asks](../DECISIONS.md#home-what-my-group-often-asks--우리-부서에서-자주-묻는-질문-featgroup-often-asks-2026-11-11-product-owner), "one short sentence per group in the team's language" and, in its plan's Out, "sentences in each viewer's own language (everyone sees the team's language)"
- Branch: fix/usage-limit-notice-home-chips (the owner, 2026-11-25; plan docs/AGENTS/plan/20261125-1735-usage-limit-notice-home-chips.md)

- **Ask:** Home on a Korean screen showed the chips "Find my files", "Share it so they can view it", "Sho…": the daily
  run wrote every list in the team's default language (English there), whatever language the reader uses.
- **Rule:**
  - The run asks the AI once per language people read the app in (the team's default and each active member's own,
    `readerLocales`), and only for a language that 3 or more people typed lines in (`typedIn`): a sentence in another
    language could never pass the word check, so the call is not made.
  - At most 3 languages a run (`OFTEN_ASKED.maxLanguages`): the team's first, then by how many people read the app
    in each. English, Spanish and Indonesian share one script, so English lines alone pass `typedIn` for all three.
  - Each call writes in its language. A sentence is stored for that language only when it is written in its script
    (`writtenIn`: Hangul for Korean, kana for Japanese, Han alone for Chinese, Latin alone for English, Spanish and
    Indonesian). The checks are unchanged: every topic word is one 3+ people typed (fail closed). No sentence is
    translated: a translated word is not one people typed.
  - `often_asked_items.locale` (migration 454) keeps each sentence's language; a row from before (NULL) is the team's
    default language's.
  - Home reads the caller's own language's list (`users.locale`), never another language's. A reader whose language
    nobody typed in sees no list, as a team with too few askers does.
- **Why:** the suggestions are things to tap and send; a list in a language the person does not use is noise.
- **Left out:** translating a list for readers of another language (see above); per-person lists.
- **Cost:** one small-model call a day per language that has a list's worth of lines, at most 3; most teams have one.
- **Tests:** tests/unit/b-often-asked.test.ts, tests/unit/b-often-asked-run.test.ts ("the reader's language").
- **Version impact:** patch.
