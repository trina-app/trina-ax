# Real-app image provenance

Captured 2026-10-30 (Asia/Jakarta) from the local `docs/team-first` worktree based on `cdfa54f1b7dc75acd9be948ca46d94f39f2dcb08`, app version from `server/package.json`. The handoff report records the final documentation commit. EN/KO application copy changes in this branch were built before the final captures.

- App: Bun development server at loopback port 19760, temporary dedicated data directory, no relay, both AI engines explicitly disabled. **No model provider/account was used.** The development banner is retained.
- Browser: Playwright MCP Chromium. Desktop viewport 1280×800; mobile web viewport 390×844. PNG captures, no substituted UI or translated image text.
- Data: `scripts/demo/seed.ts` plus [fictional starter files](../../examples/data/README.md) and [skills](../../examples/README.md), uploaded using the normal API. Alice/Bob/Dion are synthetic seed accounts, not customer identities. English and Korean UI were selected through each account's profile.
- No chat answer was generated or fabricated. `example-result.md` is visibly labeled a human-prepared illustrative fixture. No estimated spend was injected into the database.

| Files (EN and KO) | Evidence and limits |
|---|---|
| `files-en.png`, `files-ko.png` | File panel with a real Markdown glossary preview |
| `permissions-alice-en.png`, `permissions-alice-ko.png` | Marketing demo member sees the marketing group folder |
| `permissions-bob-en.png`, `permissions-bob-ko.png` | Finance demo member sees the finance group folder; same groups listing, different access |
| `team-skills-en.png`, `team-skills-ko.png` | Actual chat skill picker for the six loaded starter skills; zero loader warnings in the running app. Selecting/inspecting a skill does not imply a model call |
| `result-file-en.png`, `result-file-ko.png` | Prepared illustrative result file in the actual file viewer; not live AI output |
| `usage-en.png`, `usage-ko.png` | Owner usage view with no AI calls; no claim of demonstrated spend or savings |
| `mobile-web-en.png`, `mobile-web-ko.png` | Phone-width file list with app header and the same fictional examples; not a native mobile app |

The audit's live meeting-summary chat and HR-vs-sales answer pair need a permitted test-provider connection. This set substitutes clearly labeled marketing/finance file-access evidence, not fabricated answers. Live AI result and populated-usage captures remain pending.

`github-social-preview.png` is the repository's 1280×640 social preview card (2026-11-01), rendered in Playwright from text, the logo and `readme/after-trina-deck.png` (a real output, fictional company; labeled in the card). The older `demo-workspace.png` is retained as an existing historical capture; it is not used in the new README.

## README hero and comparison images (`readme/`, 2026-10-31)

Captured 2026-10-31 (Asia/Seoul) from a hosted Trina AX team (`potenlab.trina.app`, app version 0.2.14 era) emptied for this purpose and filled with a fictional company, Dawnroute, and its fictional client, Trina Logistics. Two synthetic accounts were used: an admin shown as "Alex (CEO)" and a Sales member, "Mina". A real Claude subscription connection answered; nothing in the answers was edited or substituted.

| File | Evidence and limits |
|---|---|
| `readme/hero-day-one.gif` | Mina's chat: one typed request, the live steps (reading the `proposal` skill and the sales files), the "1 file saved" result and the generated 7-page deck opening in the file preview. Generation took 81.4 s; the clip is cut and sped up (8× during the steps, 1.5× on the deck pages, both labeled in the frame). 880 px, 9 fps, 19 s |
| `readme/before-empty-claude.png` | The same request sent with `claude -p` in an empty folder on a developer Mac (2026-10-31). An excerpt in large type so it reads in the README table: the opening sentences and the six question headings, word for word, with `…` where text was cut. Replayed in a terminal-styled page; the red underline, red box and the "Six questions back. No proposal." label are annotations |
| `readme/after-trina-deck.png` | A real deck from 2026-11-01: Mina's one-line request on the demo server, with the photos made through the team's Higgsfield connection. The cover with two later pages (2 and 5) behind it, the request as a chat bubble, and the "A 7-page deck, with photos." label added as annotations |
| `readme/permission-answer.png` | Mina (Sales) asking for last quarter's revenue; the file sits in `shared/Finance`, which she cannot read. The full live answer from the 2026-11-01 demo take, with annotations: a red underline on "any file you have access to", a red box on "Financial reports may be in folders you don't have access to", and a side panel (who asked, her folder access, one-line explanation) |

The deck template and skill are fictional sample material, not shipped examples. The video these frames come from is kept outside the repository.

## README team conversation images (`readme/`, 2026-11-07)

Captured 2026-11-07 from a local Bun development server built from `origin/dev` at `6418737c` (version 0.4 era), listening on loopback only, with a temporary dedicated data directory. Unlike the 2026-10-30 captures above, AI was on: **the answers are real AI answers**, run through the capturing developer Mac's own Claude Code sign-in. Nothing in the answers was edited or substituted.

- Browser: English UI, light theme, London time zone (the times shown in the frames). Desktop viewport 1440×900, captured at 2×. Lossless PNG.
- Data: the fictional company Dawnroute, made through the app's normal UI and API: synthetic accounts Alex (owner), Mina and Sam (Sales); the group and room Sales; the all-company room Everyone; a made-up price sheet in `shared/Sales/`, a revenue note in a Finance folder readable only by Alex, and a fictional team skill `skills/quote/SKILL.md`. Northwind Foods, Harbor Market and every number are made up.
- Cropped: the browser chrome and the development server's warning bar above the app (it shows only on a development server). Nothing inside the app was altered.

| File | Evidence and limits |
|---|---|
| `readme/room-quote.png` | Mina's screen in the Sales room (shown with a `#` icon), 2880×1800: Sam's note, Mina's `@Trina /quote Northwind Foods: 200 insulated boxes, delivery Nov 20`, the live answer posted in the room ("Asked by Mina", the quote summary, a link to the saved `Northwind Foods quote.xlsx`, "1 file referenced") and Alex's reply. Before the file was saved, Mina pressed Allow on the server's safety check; that card is not in this frame |
| `readme/share-check.png` | The Everyone room at the same moment on two screens, 2320×1792: Alex's screen with the live answer marked "Only you can see this · Post" and its reason line "It read folders that some people in this room cannot open (Team folder, Finance).", and Mina's screen showing only "Answered to Alex only". Two crops of the room column (no sidebar) stacked; the two labels ("Alex's screen (can open Finance)", "Mina's screen, same moment (can't open Finance)") and the divider are annotations. Nobody pressed Post |
