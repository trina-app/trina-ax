# web_fetch opens a page of the app's own docs with no address card

- Date: 2026-11-25
- Status: accepted
- Supersedes: none. Adds a rule ①e to the address card ([tools/url-gate.ts](../../server/src/tools/url-gate.ts)); builds
  on [The AI answers questions about the app from its own docs](20261124-trina-docs-tool.md)
- Branch: fix/docs-no-web-fetch-card (QA TC-9174)

- **Ask:** since `trina_docs` (#535) the AI answers app questions from the docs the server carries and ends with the
  page's link. In 5 of 8 real-AI doc questions on qa it then also opened that page with `web_fetch`
  (ax.trina.app/docs/...), and the address card asked "check that it doesn't contain your information", with the
  all-sites offer. Declining still gave a full answer: the fetch adds nothing and the card is noise.
- **Rule:**
  - **The tool says its text is the page.** The `trina_docs` result reads "Each passage is the page's own text, so do
    not fetch the links"; the instructions' line reads "answer from its text (don't fetch the page)". The line stays
    under the size test's 60 tokens.
  - **①e: a page of the app's own docs opens with no card** in `web_fetch`: exactly a page address the docs tool links
    to, taken from the docs the server carries (`docs-help/data.ts isDocsPage`: every language's page addresses, which
    carry the docs base, ax.trina.app/docs), https, no query, no user name or password; a `#fragment` and a last `/`
    do not matter. It is checked first, so it holds also while the exit address is unknown and in a run nobody watches.
  - **Everything else keeps its card as before:** other pages of the site (pricing, the home page, a made-up path under
    /docs), other trina.app hosts (qa.trina.app, trina.app), http, a query, a user name; save_url and the in-app
    browser (they do not pass `docs`); a confidential chat (no web reads at all there).
- **Why it is safe:** the card exists because a GET can carry data out in its address. A page from a fixed, known list
  of our own public pages carries nothing the AI chose: no query, no path of its own making. A server without the docs
  file has an empty list.
- **Left out:** trusting the whole host or all of trina.app (the owner's ask was the docs page only); adding the
  docs tool's links to the chat's learned links (they would still spend the link budget and could still ask).
- **Tests:** tests/unit/docs-web-fetch.test.ts.
- **Version impact:** patch (a fix to how an existing tool answers; no new setting or API).
