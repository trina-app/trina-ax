# A "Build a plugin" guide and a community section on Admin › Plugins

- Date (UTC): 2026-11-13 05:20
- Branch: `feat/plugins-community-guide`
- Status: in progress
- Where: docs/site (public docs) and web/src/pages/admin/Plugins.tsx. Why: the only plugin page is filed under "For
  AI agents", and the admin page does not say that anyone can build a plugin (QA sheet TC-195 / TC-745, TC-194 / TC-744).
- Version impact: patch. New docs and words on an existing page; no API, format or behaviour change.

## Goal

A community developer finds a "Build a plugin" guide where developers look (Developer guide), copies a minimal skill
pack that really installs, and learns how it is checked and where to share it. An admin on Admin › Plugins sees that
plugins can come from Trina or the community, how they are checked, and two links: "Build a plugin" and "Share your
plugin".

## Scope

In:
- `docs/site/develop/plugins.md` ("Build a plugin"), a new "Plugins" group in the Developer guide tab: what can be
  built today (skill packs; native drivers only from the list core knows, today only the official HWP build), a
  minimal example (`trina-plugin.json` + one `SKILL.md`), packing it, testing with Install from file on a
  development server, how it is checked (written from server/src/plugins/*.ts, not invented), how to share it.
- Sharing points only to places that exist: the Discord link in README.md and issues / pull requests on
  github.com/trina-app/trina-ax. No listing process exists: an open question for the owner.
- `docs/site/agents/plugins.md` stays at its URL and links to the new guide.
- Admin › Plugins: the intro says plugins come from Trina or the community and how they are checked; under Discover,
  a "Community plugins" line (no box, no count) with a "Build a plugin" button and a "Share your plugin" link, both
  opening the public docs in a new tab. Five languages.

Out: a community catalog, fetching lists, new install paths, signing keys for the community, a plugin template repo.

## Steps

1. Read the install code (package.ts, trust.ts, archive.ts, manager.ts, drivers.ts, platform.ts) and write the guide.
2. Build the example in a temp dir and install it through the plugin manager in a unit test (and by hand on a
   development server with `MYCEL_PLUGINS_ALLOW_UNSIGNED=1`).
3. Admin page section and strings; update the e2e spec.
4. Changelog fragment, screenshots.

## Plain-words check

UI: "Community plugins", "Build a plugin", "Share your plugin", "checked", "signed": no package, manifest, digest or
key words on the page. The guide is for developers, so it may name the manifest, SHA-256 and Ed25519.

## Risks

Overclaiming: today a real company server accepts only official packages (no community signing key exists), so the
page and the guide must say a community plugin can be tried only on a development or test server for now. No
migration, no permission change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit/docs-site.test.ts, tests/unit/*plugin*,
`bun run test:web` for touched files, the plugins e2e spec.

## Result

(filled in at the end)
