# Apps on your computer on Windows: paths, npm shims, batch files, a missing program

- Date: 2026-11-24
- Status: accepted
- Supersedes: none
- Branch: fix/windows-local-apps (a real Windows 11 test of desktop 0.15.0; QA TC-8410, 8411, 8413-8416, 8806, 8807;
  plan [20261124-0812-windows-local-apps](../AGENTS/plan/20261124-0812-windows-local-apps.md))

- **Ask:** the owner: fix "apps on this computer" on Windows at the root, without asking. Found on Windows 11: a pasted
  `C:\TrinaQA\bin\fake-mcp.exe` became `C:TrinaQAbinfake-mcp.exe`; npm-installed programs (`npx`, `aside.cmd`) failed
  with `spawn EINVAL`; PATHEXT was ignored; Aside showed "Connected" on a PC without Aside, and the chat spun 90 s+ while
  the desktop app's confirm waited behind other windows.
- **Rule: the command line a person types is read as their computer reads one.** On Windows (the desktop app says it
  is win32) `splitCommand(line, 'windows')`: a backslash is part of a path, `"…"` groups (`""` inside is one `"`), `'`
  is an ordinary character (`C:\Users\O'Brien`), `( )` are ordinary (`Program Files (x86)`), and an unquoted program
  path with spaces that starts with a drive or a share runs to its first `.exe/.cmd/.bat/.com`. Still refused: what cmd
  would read outside quotes (`| & ; < > ^`, a `%NAME%`). The confirm and Settings write the command Windows' way.
- **Rule: a bare name is found with PATH and PATHEXT** in their order, never as a file without an ending (npm puts a sh
  script beside its `.cmd`), never in the current folder. Full paths must have a drive or a share.
- **Rule: .cmd and .bat.** Node refuses them without a shell since CVE-2024-27980. Two ways, picked per file:
  1. **An npm shim** (cmd-shim's, and npm's own `npx.cmd`/`npm.cmd`) is read: its last line must be only the program
     (node.exe beside it or in PATH, or an .exe beside it), paths beside it that exist, plain flags and `%*`. That node
     and script are started directly, with no shell, so every argument (the AI's too) reaches the program as it is.
     This covers what people install with npm, which is nearly every .cmd an MCP server comes as.
  2. **Any other batch file** runs through `%SystemRoot%\System32\cmd.exe /d /s /v:off /c ""<file>" <args>"` (no
     AutoRun, no `!…!` values, the line as it is: `windowsVerbatimArguments`). An argument is passed bare when it is
     only letters, digits and `_-.:/\@+~`, else in `"…"`. **An argument or path with `" % ! ^` or a line break is
     refused, never escaped:** cmd expands `%…%` even inside quotes and its caret and quote rules have no escaping that
     is safe for every input (BatBadBut, 2024; Rust and Node chose refusal or a shell-free path too). For a CLI tool the
     refusal is that call's error ("pass that value another way"); the connection stays.
  - Not picked: always cmd.exe with escaping (unsafe for the AI's values); `shell: true` (Node's own quoting, the same
    problem); refusing every .cmd (npm's programs would not work).
- **Rule: a program that is not there is said before anything is asked.** The desktop app looks the program up first:
  missing gives `start_failed` with `cause: 'not_found'` (LocalResult, optional; an older server drops it and keeps the
  old words), and no confirm opens for something that cannot run. The server stores `local_missing`: the connection
  "needs attention" with "<name> isn't installed on this computer. Install it, then press Check again.", Aside's and ego
  lite's pages show their download pages (aside.com/download, lite.ego.app/download: both have Mac and Windows builds),
  and the AI gets the same with the link. A declared CLI (ego lite) is checked the same way: its initialize used to be
  answered without the program, so it read "Connected" with nothing installed. `.ps1`, `.js` and the like:
  `cause: 'unsupported'`.
- **Rule: the confirm is seen.** When "Connect a program" opens, the window is restored if minimized and flashes in the
  taskbar (the Dock on a Mac), and the page shows a notice until it is answered (`DesktopBridge.localApps.onAsking`).
- **Rule: ending a program on Windows** is `System32\taskkill.exe /pid <the PID it started> /T /F` (its tree: cmd's
  batch, npx's server), never by a name.
- **ego lite on Windows:** opened from its Start Menu shortcut (`ego lite.lnk`, the person's Start Menu first, then
  everyone's) with `explorer.exe <shortcut>`, no shell; then a fixed 6 s and the call once more. No shortcut: the words
  "ego lite isn't open. Open ego lite, then ask again." Linux: the words only.
- **Security review of #515 (2026-11-24), three fixes:** a program or PATH folder on a network share or a device path
  (`\\server\share`, `\\?\…`, `\\.\…`, `//server`) is refused with words before any file check, because even a check
  sends this computer's sign-in (NTLM hash) to that server; cmd.exe launches get `NoDefaultCurrentDirectoryInExePath=1`
  (a batch file's commands are never looked for in its current folder first); the AI's "not installed" words name only
  the program's file, never the folder it was saved with. Attack tests: `tests/unit/e-local-apps-windows-review.test.ts`.
- **Unchanged:** the person adds the command (never the AI or an admin), personal only, the one-time confirm of the
  exact command, no shell for arbitrary text ([20261118-local-app-connectors](20261118-local-app-connectors.md)).
- **Tests:** `tests/unit/e-local-apps-windows.test.ts` (Windows cases on any computer: a fake host and fake processes),
  `web/test/unit/local-relay.test.ts` (the notice).
- **Version impact:** patch (a fix of an existing feature on one more system).
