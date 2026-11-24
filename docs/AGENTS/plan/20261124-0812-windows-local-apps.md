# Apps on this computer work on Windows

- Date (UTC): 2026-11-24 08:12
- Branch: `fix/windows-local-apps`
- Status: done
- Where: shared/src/api/local-apps.ts, desktop/src/common/local-apps.ts, desktop/src/main, server/src/integrations/connections, web. Why: the command parser, the program lookup and the start of a program assumed macOS (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix of an existing feature on one more system; no new API a client must speak (one optional field)

## Goal

A real Windows 11 test of desktop 0.15.0 (2026-11-24) found that "An app on your computer" does not work on Windows:

1. `splitCommand` reads `\` as an escape: `C:\TrinaQA\bin\fake-mcp.exe` became `C:TrinaQAbinfake-mcp.exe`, an unquoted
   path with spaces split, and the confirm showed the mangled path.
2. `.cmd` and `.bat` programs (npm's shims: `npx`, an npm-installed `aside`) fail with `spawn EINVAL`: Node refuses
   them without a shell since the CVE-2024-27980 fix. The person sees only "could not start".
3. `resolveProgram` ignores PATHEXT (tries .exe, .cmd, then a bare name, which picks npm's sh script).
4. Connecting never checks that the program exists: Aside showed "Connected" on a PC without Aside; the failure only
   came with the first AI call, and the chat spun for 90 s+ while the native confirm waited unseen.
5. ego lite's opener is Mac-only; the words never say how to get the Windows build.

After this a person on Windows can paste a Windows path, run npm-installed programs, sees "needs attention" with the
cause and a download link when the program is not installed, and the chat says when the computer is asking.

## Scope

In:
- A Windows mode for `splitCommand` (backslashes are literal, `"` groups, `'` is literal, an unquoted drive path with
  spaces up to `.exe/.cmd/.bat/.com` is one program) and Windows quoting for the command as shown.
- `resolveProgram` with PATH + PATHEXT (never a bare extensionless name on Windows), testable on any OS.
- Starting `.cmd`/`.bat`: an npm shim is read and its node target started directly (no shell); any other batch file
  runs through `cmd.exe /d /s /v:off /c` only with arguments cmd cannot read as anything else (refused otherwise).
- The program is looked up before the one-time confirm: missing means no confirm, a `start_failed` with
  `cause: 'not_found'`, the connection "needs attention" with plain words and, for Aside and ego lite, the download page.
- Windows: the process tree ends with `taskkill /T /F` by the PID we started; ego lite is opened from its Start Menu
  shortcut (no shell).
- While the desktop app's confirm waits, the page says so (a toast in the window), and the window flashes/restores.
- docs/CONNECTIONS.md, a decision file, changes/ note, the six languages.

Out: Linux opener for ego lite; PowerShell `.ps1` programs (refused with words); a Windows e2e in CI.

## Steps

1. Parser + display quoting (shared) with unit tests (Windows cases run on every OS).
2. Resolver + shim reader + cmd fallback (desktop/common) with unit tests on fake files.
3. Existence check before confirm; `LocalResult.cause`; server reason `local_missing` and words (six languages).
4. Bridge `onAsking`; page toast; window flash.
5. ego lite opener per OS; taskkill on Windows.
6. Docs; typecheck incl. desktop; affected tests; check:prepush; Windows PC check if safe.

## Decisions

`docs/decisions/20261124-windows-local-apps.md`: why npm shims are resolved to node and other batch files go through
cmd.exe only with refused (never escaped) metacharacters. Changes nothing in
[20261118-local-app-connectors](../decisions/20261118-local-app-connectors.md)'s rules (the person adds the command,
no shell for arbitrary text, personal only, one-time confirm).

## Risks

- cmd.exe is a shell: arguments are refused, not escaped, when they hold `" % ! ^` or line breaks (BatBadBut).
- An older server gets `cause` and drops it (zod strips unknown keys): words stay the generic "could not start".
- No migration.

## Tests

`bun run typecheck` (incl. desktop), `tests/unit/e-local-apps*.test.ts`, `tests/unit/c-local-apps*.test.ts`,
`bun run check:i18n`, `bun run check:docs`, `bun run check:prepush` on Bun 1.3.12.

## Result

Built as planned (decision: `docs/decisions/20261124-windows-local-apps.md`). Differences: the "missing" check also
covers a declared CLI (ego lite answered initialize itself, so it read Connected with nothing installed); a file with an
ending PATHEXT does not list (`tool.ps1`) is found as it is and refused as "unsupported", not "not found". The confirm is
not shown at all for a program that is not there (nothing to confirm); the download link is on the app's page and in
the AI's words. Tests: `tests/unit/e-local-apps-windows.test.ts` (24), `web/test/unit/local-relay.test.ts`. Real
Windows 11 run (owner's PC, SSH session only, no desktop app started): 15/15 checks of the manager with real files,
cmd.exe, an npm-style shim and taskkill; PC state unchanged afterwards (data folder, HKCU Run and trina-ax class,
Start Menu shortcut), test folder removed.
