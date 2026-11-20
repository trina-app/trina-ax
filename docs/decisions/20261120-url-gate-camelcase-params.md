# camelCase words are not random-looking, and "always allow" covers a long plain query

- Date: 2026-11-20
- Status: accepted
- Supersedes: the "query over 200 characters always asks" part of rule ③ (archive, docs/DECISIONS.md, the web_fetch
  URL rules ①②③), for turns the person watches
- Branch: fix/url-gate-camelcase-params (the owner, 2026-11-20: "권한 너무 많아")

- **Ask:** the AI read two public Hacker News search addresses
  (`hn.algolia.com/api/v1/search?…&attributesToRetrieve=…&attributesToHighlight=none`) and each one raised its own
  address card with only "열지 않기 / 열기", with `attributesToRetrieve` and `attributesToHighlight` highlighted as
  "알아보기 어려운 긴 글자".
- **Rule 1 (opaqueParts, server/src/tools/url-gate.ts):** a run of letters only (no digits, `+` or `%`) is not a
  random-looking part when it reads as camelCase or PascalCase words (`camelWords`): split at case changes, every piece
  is a word (2 letters or more; a two-letter one has a vowel: To, By, Id) or a capital acronym (1 to 5 letters, at most
  2 of them: XML, the A of isAValue), the pieces are 3 letters or more on average, and the word letters are at least
  30% vowels (a e i o u y). Runs with digits keep the old rule (base64, base32, hex, JWT, keys). On 20,000 random
  mixed-case letter runs of 20-40 letters, fewer than 1 in 100 pass (the test pins it). The same function serves every
  caller (connection-urls echo windows, schedules, post-to-room, share-words, connection cards), so camelCase names
  are no longer highlighted anywhere.
- **Rule 2 (③):** in a turn the person watches, a plain address (a site, no random-looking part, no long name before the
  site, no user name or password, not an echo) whose query is over 200 characters opens under the person's site
  allowance for the conversation (①b) or their "Allow all websites" (①d), also while the exit address is unknown (①d
  only, as before for short queries). Its card now offers "allow this site" and "Allow all websites". A long query
  still asks when it was typed, allowed on a card or learned from a page (none of those open it without the card, as
  before), and is never opened in a run nobody watches (scheduled tasks, drafts, Slack questions); schedules.ts and
  onboarding/draft.ts keep their own long-query rules. A long query is still not remembered as an allowed address.
- **Why:** the owner's rules "always allow means done" and "no stricter than the tool". The 200-character limit was a
  hint for data carried in readable words; "Allow all websites" already accepts any number of plain addresses (its risk
  sentence says readable words can carry anything out), so one long plain address adds no new channel. Random-looking
  parts, echoes, user names and long subdomains are where the gate catches something, and those are unchanged.
- **Note:** the owner's two addresses have queries of 173 and 132 characters, under the limit; Rule 1 alone fixes them.
  Rule 2 covers the next, longer search.
- **Wording:** the site and Allow-all lines on the card and the Settings hints (6 languages) no longer say that
  addresses with a lot of text at the end still ask; docs/security-and-permissions(.ko).md say when a long query asks.
- **Tests:** tests/unit/url-gate-camelcase.test.ts (the owner's addresses, real parameter names, tokens, random letters,
  the gate outcomes); site-allow and web-allow-all tests updated for Rule 2.
- **Version impact:** patch (a bug fix: addresses the person's own setting should have opened asked).
