# A long answer no longer offers slides

- Date: 2026-11-21
- Status: accepted
- Supersedes: the `ppt` line of [X — Lean onboarding](../DECISIONS.md#x--lean-onboarding-two-steps-a-short-form-one-preview-a-folded-invite-one-suggestion-featonboarding-x-2026-11-04) (only that line; the rest of X stands)
- Branch: fix/remove-slides-offer (the owner, screenshot, 2026-11-21)

- **Ask:** the owner, on a screenshot of the line above the message box ("Turn this into slides too?" [Make slides] ✕):
  "이건 이제 안떠도 될듯?" The owner: this offer no longer shows.
- **Rule:** a long report-like answer (2,000+ characters of prose) gets no suggestion line. The server's rule for it is
  gone (`reportLike`, `PPT_SUGGEST_CHARS` in `server/src/onboarding/suggestions.ts` and the contract), the contract
  has no `ppt` kind and `ppt` is no longer a key to close (`SuggestionKey`), and the web app has no branch, icon or
  words for it (`resultTip.ppt.*` removed in all six languages). Anyone can still ask for slides in the chat.
- **Kept:** the other suggestions under a result stay as they were: `schedule` ("Get this automatically every week at
  this time?"), `team-skill` ("Make this way of working a team skill?"), `contribute` (a member's first run of the
  landing skill), and `deck-video` (in the contract, never sent while `DECK_VIDEO_SUGGESTION` is off). Where the slides
  line used to come next (a member's later landing-skill run, a phone without a team folder), there is now no line.
- **Data:** old `ppt` rows in `suggestion_dismissals` stay; nothing reads them. No migration.
- **Tests:** `tests/unit/b-result-suggestions.test.ts` (a long answer gets nothing, with or without a skill; the schedule
  still wins; `ppt` is neither a kind nor a key), `tests/unit/b-member-contribute.test.ts` (no line after the
  contribute one), `web/test/unit/result-suggestion.test.tsx`.
- **Version impact:** patch (a suggestion line is no longer shown; no new feature).
