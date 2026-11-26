# Windows installer signing with SSL.com eSigner

- Date (UTC): 2026-11-26 02:50
- Branch: `ci/windows-sslcom-signing`
- Status: in progress
- Where: `.github/workflows/release.yml` (build-windows), `desktop/scripts/win-sign.ts`, docs/RELEASE-CI.md 11장.
  Why: the company's OV code signing certificate was issued by SSL.com (eSigner cloud signing) on 2026-11-26, and the
  owner cancelled Microsoft Artifact Signing the same day
- Version impact: none (release CI only; no shipped code changes, and signing stays off until a repository variable is
  set)

## Goal

A release signs the Windows installer, the app exe and the uninstaller with the company's SSL.com certificate, checks
each signature, and fails instead of shipping unsigned when signing is switched on but does not work.

## Scope

In: the electron-builder signing hook (SSL.com CodeSignTool, pinned and sha256-checked), release.yml build-windows, the
unit test, RELEASE-CI 11장 (SSL.com only; Azure tried and cancelled), a changes/ note.
Out: the macOS and Linux builds, `publisherName` for electron-updater (unchanged), buying a signing plan.

## Steps

1. Replace the Azure branch in `desktop/scripts/win-sign.ts` with SSL.com: one switch (`WINDOWS_SIGNING_PROVIDER` =
   `sslcom`), four secrets in the `release` environment, CodeSignTool `sign -override` per file, then a signature check
   (Valid + timestamp) with three tries.
2. release.yml: pinned Java (setup-java by commit) and CodeSignTool v1.3.2 (sha256 checked) only when switched on; no
   `id-token: write` any more; the final `signtool verify /pa /tw` and signer log stay.
3. Update the unit test, RELEASE-CI 11장 (and the job table in 3장), INSTALL.md's line, changes/.
4. One test signing of a harmless exe with the same credentials; no release run.

## Decisions

- Call `java -jar code_sign_tool-<v>.jar` directly, not `CodeSignTool.bat`: cmd.exe would mangle a password with
  special characters, and the bundled-JDK zip is 200 MB.
- CodeSignTool can print an error and still exit 0, so every signature is checked with `Get-AuthenticodeSignature`
  right after it is made.
- The switch is a repository variable, the credentials are environment secrets: setting the secrets alone signs nothing.

## Result

(filled in at the end)
