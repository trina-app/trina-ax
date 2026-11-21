# Korean search across verb and adjective forms

- Date (UTC): 2026-11-21 10:13
- Branch: `fix/ko-search-forms`
- Status: done
- Where: trina-ax `shared/src/search-text.ts` (the one reading of a search's words, server and app), the searches
  that use it (`server/src/rooms/search.ts`, `server/src/rooms/reader.ts`, `server/src/routes/chats.ts`,
  `server/src/team-files/find.ts`) and the marks in `web/src/components/SearchDialog.tsx`. Why: the follow-up of
  docs/decisions/20261119-message-search-slack-level.md "Left out: Korean verb endings".
- Version impact: patch: search finds more of what was asked; no API field removed, no migration.

## Goal

A Korean search finds the other forms of the same verb or adjective: "만들다" and "만든" find "만들었어요" and
"만들어", "작성했어요" finds "작성했습니다", "보낸" finds "보냈어요". Particles keep working (보고서를 / 보고서가 /
보고서는).

## Cause

Every search matches each word as a part of the text (LIKE, or the trigram index of migration 267). Since 11-19 a
word loses a noun particle first (searchStem), but a verb ending is part of the word, and a Korean verb changes its
last syllable when it is conjugated (만들 → 만든 / 만듭니다, 보내 → 보냈, 하 → 해 / 했), so no single part of the
word is in every form. The chat records' search (AI chats), the AI's rooms tool and the team file names did not even
drop particles.

## Scope

In: query side only. `searchForms(word)`: the parts of the text any of which counts as the word (a list of strings;
the first is what the word is shown and ranked by): the word without its particle (as today), and for a Korean verb
or adjective its stem and the forms its last syllable takes (ㄴ/ㄹ/ㅂ/ㅆ endings, contractions 해/봐/줘/셔/써,
ㄹ, ㅂ, ㄷ, ㅅ, ㅎ, 르 irregulars), and a noun + 하다/되다/드리다/시키다 by the noun. Used by room messages and room
files (⌘K), the AI's rooms search, the chat records' search and the team file names; the app marks every form.

Out: the AI's grep (a regular expression the AI writes), an index change or new tokenizer (no migration, no new
package), one-syllable verb stems (봤어요, 갔다: too short to search by a part), Korean spelling mistakes by jamo.

## Steps

1. `searchForms` in shared/src/search-text.ts with `forms` in `SearchParts`; `searchStem` stays (forms[0] is never
   narrower than it).
2. Room messages: each term is any of its forms (the MATCH an OR of the forms' phrases when all have 3+ letters, the
   LIKE check an OR), best match and snippets by the form found; room files the same.
3. AI rooms search (reader.ts wordWhere), chat records (routes/chats.ts), team file names (find.ts): any form.
4. Web marks: every form.
5. Tests: a table of 15+ Korean query → text pairs (and pairs that must not match), English unchanged, server
   searches end to end, the visibility tests unchanged; times on 100,000 messages.
6. Decision file, changes/ note.

## Decisions

docs/decisions/20261121-ko-search-forms.md (extends docs/decisions/20261119-message-search-slack-level.md).

## Risks

More matches for a noun that looks like a verb form (a noun ending in ㄴ: "사진" also finds "사진" forms such as
"사질"): forms that are only the stem are used only when the word clearly has a verb ending; otherwise only full
forms. Speed: more LIKE alternatives per word; measured on 100,000 messages. Visibility: the filters and the SQL that
decides who sees what are not touched.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit search tests, tests/security.

## Result

Built as planned: `shared/src/search-ko.ts` (koVerbForms), `searchForms` / `searchTerm` / `findForm` and
`SearchParts.forms` in `shared/src/search-text.ts`, `server/src/search-forms.ts` (forms as a few GLOBs, the last
syllables as a class), used by room messages and files, the AI's rooms search, the chat records' search, team file
names and the app's marks. One change from the plan: the first version sent every form as its own LIKE, which made a
scan of 100,000 messages take seconds; grouping the forms into GLOBs brought the slowest case back near its old cost
(decision file, "Speed"). A word of only short forms now scans room_messages newest first instead of the trigram
LIKE. Korean query → text table: 6 of 27 found before, 27 of 27 after; 10 must-not-find pairs and English unchanged.
