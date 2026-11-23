# "Always allow" on a picture card covers that picture only

- Date: 2026-11-23
- Status: accepted
- Supersedes: none
- Branch: batch/20261123-sign

- **Ask:** the owner, 2026-11-23, on whether the card for a picture the person did not upload offers Always:
  "클로드랑 동일한 기준 ㄱ". Claude Code scopes "Yes, and don't ask again" to the thing approved, not to the whole tool.
- **Rule:** the card of `edit_office` `insert_picture` and of `edit_hwp`'s image change lists every picture still to
  approve and offers [Put it in] [Always allow] [Don't]. Always keeps one row per listed picture for this person in
  `card_always_allow`: `picture:t:<team path>` or `picture:c:<chat file id>`. A different picture still gets the card.
- **Where it holds:** as every Always (Rule A): every chat of the person and their own scheduled run, with no caps. In a
  scheduled run a picture without an Always is refused and nothing is saved. Settings › 트리나에게 허용한 것 lists one row
  per picture and takes it back. The team's "Always allow" switch and a confidential chat work as for every other card.
- **Scope is the name, not the bytes:** a new version at the same path or of the same chat file stays approved, as a
  Claude Code path rule does.
- **Tests:** `tests/unit/picture-always.test.ts`.
- **Version impact:** minor, with the new card option and Settings row.
