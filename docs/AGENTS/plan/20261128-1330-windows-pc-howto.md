# A plain how-to page: host Trina AX on a Windows PC

- Date (UTC): 2026-11-28 13:30
- Branch: `docs/windows-pc-howto`
- Status: in progress
- Where: `docs/site/operate/` (the docs site, ax.trina.app/docs) and `docs/INSTALL-WINDOWS*.md`. Why: how-tos for
  running the server live in the docs site's "Run and operate" tab; the full guide stays in `docs/`
  (see docs/REPOSITORY-RULES.md)
- Version impact: none, docs only (no code, no release)

## Goal

The owner wants "how to host Trina AX on a Windows PC" on the website and a how-to in the docs, easy enough for a
non-developer (a small office with one PC that stays on). Today the only text is the full guide
`docs/INSTALL-WINDOWS.md` (0.20.4), written for someone who knows WSL, PowerShell and tunnels.

## Scope

In:
- New docs site page `operate/windows-pc.md`, "Host Trina AX on a Windows PC": who it is for, what you need, four
  steps ("only this PC" as the zero-setup end), a plain "Connect your own domain with Cloudflare Tunnel" section, honest limits (PC stays on and signed in; other devices need an https address), where the data is, how to
  remove it, a link to the full guide. Listed in every language's nav under Run and operate › Set up.
- `operate/install.md`: a Windows PC column in the comparison table and a short tab that links the new page.
- `docs/INSTALL-WINDOWS.md` and `.ko.md`: plain-word fixes only where a non-developer would stop (the install time
  the test measured, a plain first paragraph, what "https address" means and a link to the tunnel steps). Script
  steps and commands unchanged.
- `changes/windows-pc-howto.md`.

Out: any change to `scripts/windows/install-wsl-server.ps1`; translations of the operate pages (they are English in
every language, as today); the website card (separate PR in trina-app/trina-ax-website).

## Steps

1. This plan (first commit).
2. The page, nav entries, install.md tab.
3. INSTALL-WINDOWS plain-word fixes (en + ko).
4. `bun run check:docs`, `bun test tests/unit/docs-site.test.ts`, `bun run check:prepush`.
5. Open the PR into dev; do not queue until the parallel Windows QA on 0.20.4 has finished (it may change steps).

## Decisions

None new. Owner, 2026-11-28: self-hosted servers bring their own https address (own domain + tunnel), like other
open-source self-hosted software; the official relay is not offered for them, so these pages do not mention it.

## Risks

Steps may change after the running Windows QA: the PR waits for it. Docs only; no migration, permissions or app UI.

## Tests

`bun run check:docs`, `bun test tests/unit/docs-site.test.ts tests/unit/docs-in-app-links.test.ts`,
`bun run check:prepush`.

## Result

Filled in at the end.
