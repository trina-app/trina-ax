# Notice manifest: no build version to signed-out callers on the internet

- Date (UTC): 2026-11-11 18:40
- Branch: `fix/licenses-version-signed-out`
- Status: in progress
- Where: `server/src/routes/web.ts`, `server/src/routes/web-static.ts`. Why: the team server's static route is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix (a leak closed); no API, setting or file format changes

## Goal

QA TC-160 (11-12, local relay): after #369, signed-out `GET /api/health` through the relay / the office internet address
answers only ok and time. But `GET /licenses/manifest.json` (the notice manifest of scripts/release-notices.ts, copied
into the web root) still gives the same callers `release.version`, every package with its exact version and hashes,
and the bun.lock hash: the build fingerprint #369 hides.

## Scope

In: the server answers 404 for the notice manifest to a signed-out caller that came through the relay or the office
internet address (same rule as /api/health). Signed-in people, this server and the office LAN keep it. Matched on the
file served (any URL spelling). The manifest is never stored by a cache (`private, no-store`), so a shared cache cannot
hand a signed-in copy to a signed-out visitor.
Out: the file itself is unchanged (the verifier checks the web copy byte for byte against the canonical manifest; a
bundle's own `licenses/manifest.json` is not served). LICENSE, NOTICE, licenses/README.txt and the package notice files
stay public; the source-code offer (sign-in page, Settings › About) is unchanged.

## Steps

1. `isNoticeManifest(dist, path)` in web-static.ts (resolved file, case-insensitive) and the check in web.ts.
2. Unit tests in tests/unit/d-web.test.ts (relay / tunnel / LAN / local, signed in and out, path spellings, public texts).
3. docs/RELEASE-NOTICES.md: who gets the manifest.
4. Live check through a local relay (QA's TC-160 steps).

## Risks

AGPL: the source offer is the sign-in page's "Request source code" link (works signed out, from /api/health's
version-less answer, as since #369) and the licence texts stay reachable. The notice files' own paths carry the
package version and a hash, so they are not a guessable version oracle without the manifest. No migration, no UI text.
