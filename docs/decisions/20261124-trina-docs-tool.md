# The AI answers questions about the app from its own docs, shipped with the server (trina_docs)

- Date: 2026-11-24
- Status: accepted
- Supersedes: none. Revisits "No help tool" in [The AI gets a short map of the app's screens](20261116-ai-app-map.md)
  and [the five places](20261117-ai-app-map-five-places.md) for a different job (below); the map stays as it is.
- Branch: feat/trina-docs-tool (the owner, 2026-11-24: step 1 of the setup helper plan, before anything else; the
  external knowledge base / `howto` is postponed)

Plan: [docs/AGENTS/plan/20261124-1203-trina-docs-tool.md](../AGENTS/plan/20261124-1203-trina-docs-tool.md).

- **Ask:** asked how to use, set up or fix the app ("how do I connect Slack?", "can a guest use the AI?", "the AI
  account says Needs reconnecting"), the AI should answer from the app's own docs and give the link to the page, in
  the person's language. The installed version and its docs must match, hosted or self-hosted, and nothing may be
  fetched from the internet at answer time.
- **Rule:**
  - **The docs ship with the server.** The docs build (scripts/docs/build.ts `plainSite`: the same rendering as the
    site) gives every page of every language as plain text cut at its h2 and h3 headings, with its public address
    (ax.trina.app/docs, scripts/docs/help-index.ts `PUBLIC_DOCS`). Every server bundle carries it at
    `resources/docs/help-index.json` in the version folder (`stageDocsHelp`: the macOS and Linux bundles of
    scripts/build-bundle.ts, so the Linux kit, Docker and hosted servers too, and the office zip of
    scripts/build-office.ts; both bundle file lists name it, so a release without it stops). It is inside the signed
    version folder like the plugin catalog. A source checkout builds the same data from docs/site on first use (about
    0.5 s). Left out: the generated HTTP API reference (a list of endpoints, 130 KB, a third of English).
  - **Each language holds every page of its navigation.** A page it has not translated is an entry of that language's
    tab and group names with the English page's address, so a Korean "설치" finds the English install page.
  - **`trina_docs(query)`** (server/src/docs-help/): a local search, up to 3 pages, each with its title, the best short
    passage (at most 300 characters, from the best-matching section) and the page's public address: in the person's
    language when the page is translated, else English, said so. Order of languages: the query's own script (Hangul,
    kana, Han), the person's language, English. The search is BM25 over sections, with a bonus for query words in a
    page's title and description; Latin words lower-cased with short endings cut; Hangul, Han and kana as character
    pairs; a Korean word read as the app's other searches read it (shared search-text.ts `searchTerm`: without its
    particle, a verb by its stem); question words left out; names and a few loanwords
    written in Hangul, katakana or Han (슬랙, 구글 드라이브, 로그인, スラック) as the English words the pages use. A
    search in another language says some pages are only in English, so the AI may search once more in English. The
    audit line names the pages found, never the question.
  - **Offered where the AI's other local tools are:** the person's own chat, a shared chat (`SHARED_TOOLS`: public
    pages, nothing about anyone), a confidential chat (`LOCAL_TOOLS`: nothing leaves the server), sub-agents and the
    read-only Explore helper (`READ_ONLY_TOOLS`), a scheduled run, the free-roam demo (`FREE_ROAM_TOOLS`). It changes
    nothing and brings no one's words in (`ROOMS_SEEN_READ_ONLY_TOOLS`, `OWN_WORDS_TOOLS`, `NO_OUTSIDE_TOOLS`: the
    docs are part of the signed release, like the app's own instructions). Not to a guest (the team's screens are not
    theirs, as with the app map), not in the drafts and judges that have no tools, and not on a server without the
    file (a build from before this).
  - **One line in the instructions**, only where the tool is offered: "Questions about using, setting up or fixing
    <app>: search with trina_docs first, answer from what it finds and end with the page's link. Prices and plans:
    link https://ax.trina.app/pricing." The app map stays the answer to "where is …".
- **Why a help tool now, when the app map decisions turned `where_is` down:**
  - That tool would have looked up places that fit in the map (20 lines, about 1,200 tokens), and the failing
    answers were hedges where the AI did not know there was anything to look up. This one answers what the map can
    never hold: the step-by-step setup and the Problems tables of about 48 pages in six languages (1.6 MB of text).
    The map still says where; the docs say how, with a link the person can follow.
  - The cost is small and measured: with Claude Code 2.1.312 and Sonnet (`claude -p` usage, 2026-11-24), the tool's
    definition next to other tools adds **160 input tokens** to a request, the line **66**: about 226 tokens of a turn
    that offers it (a sixth of the map's 1,200). Both sit in the request's cached prefix (the tool list and the
    instructions), so later rounds of an answer read them from the provider's cache. A call's result is about 300–500
    tokens, paid only when the AI searches. tests/unit/docs-help.test.ts holds the definition under about 120 and the
    line under about 60 by the size test's count (3.6 characters a token).
  - The rule line is what makes the AI look: "search … first" for how-to, setup and troubleshooting questions.
- **Bundle size:** 1,562,693 bytes of JSON in the version folder (all six languages): about 360 KB more in the update
  archive (`.tar.zst`, level 19) and 453 KB in a gzipped kit. The server reads it once, on the first turn that offers
  the tool (about 20 ms), and builds a language's index on its first search (about 120 ms for Korean and English
  together; a later search takes a few ms to about 30).
- **Evaluation:** 20 frequent questions (docs/FAQ.md, the Problems sections, docs/INTEGRATIONS.md and the setup steps:
  Slack, Google Drive, inviting people, guests, scheduled tasks, the AI connection, usage limits, a Linux server,
  folder and chat sharing, skills, MCP apps, API keys, work files, room apps, Claude Desktop, Google sign-in, what
  admins see, notifications, a blocked Google app), each in Korean and English with the page that answers it. All
  40 find their page among the first 3 (34 first, 5 second, 1 third; mean reciprocal rank 0.92); tests/unit/docs-help.test.ts fails when one
  stops. A docs change that breaks one rewords the page or the question, never tunes the search for one question.
- **Left out:** the external knowledge base and `howto` (postponed by the owner); the remote MCP connector (no chat
  turn); links to a section's anchor; the developer pages are searched too but rarely win a user's question. The line
  is in a fresh session's instructions only (as the app map): a session started before this update has the tool at
  once and gets the line at its next fresh start.
- **Version impact:** minor (a new AI tool and a new file in the server bundle; no API, data or setting change).
