# Serve a real assetlinks.json: add the Android upload key's fingerprint

- Date (UTC): 2026-11-08 16:45
- Branch: `fix/assetlinks-upload-key`
- Status: in progress
- Where: trina-ax `shared/src/app-links.ts` and its test. Why: team servers answer `/.well-known/assetlinks.json` with 404 because no fingerprint is set (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a public file that was 404 now answers 200

## Goal

Android can verify app links for `app.trina.ax` against the certificate that signs the APK published at updates.trina.app (the upload key, CN=Trina AX upload).

## Scope

In: the upload key's SHA-256 in `APP_LINKS.androidCertSha256` (a list), a comment that the Google Play app signing key's fingerprint must be added once Play signs the app, the unit test, CHANGELOG, the docs that say the fingerprint is missing.
Out: the Play signing fingerprint (the app is not public on Play yet), files on trina.app itself.

## Steps

1. Add the fingerprint and the comment.
2. Test: the fingerprint, the JSON shape, status 200 and content type.
3. CHANGELOG and docs.

## Risks

None for data or permissions; the file is public and identical for everyone. Play installs need the second fingerprint later.

## Tests

`bun run typecheck`, `bun run check:docs`, app-links and server-app unit tests.

## Result

Filled in at the end.
