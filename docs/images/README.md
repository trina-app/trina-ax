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

`github-social-preview.png` is a separate 1280×640 original typographic card, rendered in Playwright from text and simple shapes. It is not an application screenshot and has not been uploaded to GitHub. The older `demo-workspace.png` is retained as an existing historical capture; it is not used in the new README.
