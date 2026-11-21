# Korean search finds the other forms of a verb or adjective, by rules on the query, with no new index

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (extends [Message search at least as good as Slack's](20261119-message-search-slack-level.md), whose
  "Left out: Korean verb endings" this does)
- Branch: fix/ko-search-forms (the known follow-up of 11-20)

넣을 곳: trina-ax `shared/src/search-ko.ts`, `shared/src/search-text.ts`, `server/src/search-forms.ts` and the searches
that use them, 이유: one reading of a search word for every search, server and app.

- **Ask:** a Korean search finds a word in another form: "만들다" and "만든" find "만들었어요" and "만들어",
  "보고서 작성" finds "보고서를 작성했습니다", particles keep working (보고서를 / 보고서가 / 보고서는).
- **Cause:** every search matches a word as a part of the text (LIKE, or the trigram index of migration 267). A noun's
  particle was taken off (searchStem, 11-19), but a Korean verb changes its last syllable when it is conjugated
  (만들 → 만든 / 만듭니다, 보내 → 보냈어요, 하 → 해 / 했), so no one part of the typed word is in every form. The
  chat records' search, the AI's rooms search and the team file names took the word as typed, particle and all.
- **Rule: a word is any of its forms** (`searchForms`): its searchStem (what it was found by before: nothing it found
  is lost) and, for a word of Hangul syllables, the forms below. A text holds the word when it holds any of them as a
  part of it; every word must be there, as before.
  - a noun + 하다 / 되다 / 드리다 / 시키다 in any form ("작성했습니다", "확인해주세요", "공유된", "전달드렸어요") is the noun;
  - a word with a verb ending (었어요, 습니다, 세요, 는데, 지만, 어서, a plain 다 or 요 after two syllables …) is its stem,
    and the stem's other forms: ㄴ / ㄹ / ㅂ / ㅁ / ㅆ written into its last syllable (보낸, 보낼, 보냅니다, 보냈), the
    contractions (봐, 줘, 셔, 써, 해, 돼), and the ㄹ, ㄷ, ㅂ, ㅅ, ㅎ and 르 irregulars (만든, 들어, 어려워, 나아, 그래,
    몰라). Before 이다 (예요, 이에요, 입니다) it is the noun as it is;
  - a word that may be a verb's form or a noun ("만든", "보낸", "만드는", "괜찮은"; "사진", "시간" alike) adds only whole
    forms of the stem, the stem with an ending's first syllable after it ("만들었", "만들어", "보내고"), never the stem
    alone: "시간" never finds "시가 총액", "이미지" never "이미", "보고서" never "보고 드릴게요";
  - a stem of one syllable ("봤어요", "갔다") stays as typed (one syllable would find nearly everything);
  - a "quoted phrase" is found as typed, as before; English and anything else as before (searchStem).
- **Where:** ⌘K's room messages and room files (with from:, in:, best match, snippets and the marks in the app), the
  AI's rooms search, the chat records' search (titles and messages) and the team file names. Not the AI's grep (a
  regular expression the AI writes itself).
- **Rule: who sees what is unchanged.** Only the text condition changed; the rooms, SEE_MEMBER_SQL, canSee,
  messagesOut, the chat records' audiences and the files' visiblePath are as they were.
- **Speed, no migration:** a verb's forms that differ only in their last syllable go to SQLite as one GLOB per shared
  start with the syllables as a class (`*만[든들듭]*`, `*보내[고지게]*`: search-forms.ts), so a scan reads each row two
  or three times, not thirty. Forms of 3 characters or more use the trigram index (one MATCH, the forms joined by OR);
  a word of only short forms ("만든") scans the rooms' messages newest first and stops when the page is full. On
  100,000 messages on the build Mac under heavy load (load average 560), the slowest case, a two-syllable noun found
  nowhere ("시간", "사진"), took 230–330 ms against 150–190 ms before (both scans); a common word ("확인") and a verb
  that is there ("만든", "보낸") 0.3–0.5 ms. The index size is unchanged.
- **Why not a new tokenizer or index:** a Korean morphological analyser (mecab-ko, a jamo index) is a native package
  for every platform and a reindex of every team; the query side reaches the cases people type with a page of rules.
- **Left out:** irregular verbs with one-syllable stems (하다 and 되다 are handled through their noun), "어/아" typed as
  the last syllable ("만들어" finds 만들어요, 만들어서, not 만들었어요), spelling mistakes by jamo.
- **Tests:** `tests/unit/search-ko-forms.test.ts` (27 query → text pairs that must be found, 10 that must not, English
  unchanged), `tests/unit/b-rooms-search-slack.test.ts` (messages, best match, files, the AI's search and the chat
  records through the server, who sees it; the 100,000-message times).
- **Version impact:** patch: search finds more of what was asked; no API field removed (`forms` added to the shared
  parse), no migration.
