# Installing Team AX

Team AX runs on one Mac, the **server Mac**. That Mac runs the team server and the AI engines: Claude Code on the
owner's Claude subscription, and optionally the Codex CLI on a ChatGPT login. Team members use the web app, the
Mac or Windows desktop app, or a phone browser.

Updated on 2026-10-21 for commit `19d3002` (the production-path integration) on macOS 26.3.1 (Apple Silicon). A Korean, illustrated version for
the person who installs it is in [docs/install/Team-AX-설치가이드.pdf](install/Team-AX-설치가이드.pdf) (source
`docs/install/guide.html`, rebuild with `bun docs/install/build-pdf.ts`).

## Status: what works today

| | Status |
|---|---|
| Dev mode on one Mac, chats included (Part 1) | Works |
| Teams, invite links, folder permissions, backups | Works |
| Production install (`scripts/install-macos.sh`): role accounts, LaunchDaemons, sandbox, pf, Claude chats on the owner's `claude setup-token` token | **Not verified on a real install.** Done in code and tests (as the current user), but never run as the real role accounts and no Anthropic answer through the proxy has been seen; run the role-account test first (2.0) |
| Codex in production | Beta (owner only); not yet tried with a real ChatGPT login with pf on (2.5) |
| Public team address `<team>.treesoop.com` | Not available: the production relay is not running |
| Signed and notarized apps (Mac, menubar, Windows) | Not available: apps are unsigned, so the OS warns on first launch |
| Reaching a dev-mode server from another computer or phone | Not possible: the server listens on 127.0.0.1 only. Use **office mode** instead |
| Desktop apps (Mac, Windows) on other computers | Not possible yet: they need the public team address; today they connect only on the server Mac itself |
| Phones | Production office address only; not tested |
| Office mode: one Mac, desks on the office network over https, chats included ([OFFICE.md](OFFICE.md), clinic PDF [office/Team-AX-치과-설치가이드.pdf](office/Team-AX-치과-설치가이드.pdf)) | Works (tested from the zip on one Mac over its LAN address; Windows desks not tested here) |

**Production chats (subscription mode).** The installer writes `engine.authMode: "subscription"`. Claude Code runs
as the hidden engine account `_axagent` under the sandbox and pf; the only address it can reach is the server's
model proxy on `127.0.0.1:47821`. The proxy adds the owner's `claude setup-token` token (2.4), which only the server
account can read; the engine only ever gets a per-turn token. This path is tested as the current user
(`tests/unit/g-subscription.test.ts`, also with the real `claude` binary against a fake model service) and in the
role-account install test (2.0), which needs `sudo` and has not been run on this Mac yet. Codex runs through the same
proxy, as beta (2.5).

There is **no email** anywhere, by design. Invites and password resets are links an admin copies and sends.

## What you need

- A Mac that stays on and plugged in. Apple Silicon is recommended; Intel needs one extra build step.
- macOS: checked on 26.3.1. The menubar app needs macOS 13+.
- A **Claude Pro or Max** subscription. All of the team's AI use comes out of it, so **everyone shares that one
  subscription's usage limits**; when they are reached, nobody gets AI answers until they reset. A ChatGPT
  subscription for Codex is optional.
- A Mac admin account. Dev mode asks for its password once, in the Homebrew installer; the production install asks on
  every `sudo`.
- A GitHub account with read access to the repository (private for now).

## 1. Quick try: dev mode on one Mac

The engines run as **you**, with your own Claude Code and Codex logins. There is no OS isolation, usage comes out of
your subscriptions, and Claude Code puts your account email into every turn's context.

### 1.1 Tools

```sh
xcode-select --install          # a dialog opens: click Install and wait (10–20 min)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# asks for the admin password; run the indented "Next steps" lines it prints, then open a new terminal
brew install go node gh ripgrep pandoc poppler typst ffmpeg whisper-cpp     # 10–30 min
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.12"
curl -fsSL https://claude.ai/install.sh | bash -s 2.1.305     # the pinned version
claude            # sign in with a Claude Pro/Max account, then quit
brew install --cask codex && codex login                      # optional: Codex
```

Allow 30–60 minutes for the tools on a fresh Mac.

| Tool | Version | Needed for |
|---|---|---|
| Bun | **1.3.12** (pinned) | everything |
| Go | 1.27.3 | native helpers (`mycel-gate`, `mycel-bridge`, `mycel-launcher`, `mycel-bootstrap`) |
| Node | **25+** | the relay only. Without it `bun run dev` prints "relay skipped" and the direct address still works |
| ripgrep, pandoc, poppler, typst | | file search, Office/PDF text, PDF output |
| ffmpeg, whisper-cpp | | voice input (downloads a ~490 MB model on first use) |
| Claude Code | **2.1.305** (pinned; the lockdown tests run against it) | the Claude engine |
| Codex CLI (optional) | 0.163.0 | the Codex engine. Use Homebrew (`brew install --cask codex`) or OpenAI's standalone installer; the npm package's `codex.js` wrapper is refused by the production installer |
| gh | | sign in to GitHub and clone (1.2) |

Check: `bun --version` prints `1.3.12`, `node --version` prints v25 or later, `claude --version` prints
`2.1.305 (Claude Code)`.

Claude Code updates itself. Once it has moved past the pin, Admin → AI engines shows "Unsupported version"
(`version_unsupported`); dev chats still work. Reinstall the pin with `curl -fsSL https://claude.ai/install.sh | bash -s 2.1.305`
before a production install, because the installer copies whatever version it is given and does not warn.

### 1.2 Clone and build

```sh
gh auth login        # GitHub.com → HTTPS → Y → Login with a web browser
cd ~
gh repo clone potenlab/team-ax
cd team-ax
bun install          # "1579 packages installed"
bun run build        # native/bin/<platform> and web/dist, ~10 s
```

With an SSH key on GitHub, `git clone git@github.com:potenlab/team-ax.git` works too; a Mac with several GitHub
accounts uses its `~/.ssh/config` alias (`git@<alias>:potenlab/team-ax.git`). Without an SSH key, the plain `git@`
form fails with "Please make sure you have the correct access rights".

On an Intel Mac, also run `ARCHS=amd64 bun run build:native` (`ARCHS="arm64 amd64"` builds both plus a universal
copy). `native/build.sh` builds arm64 only by default, and without this step every chat ends with "engine
unavailable".

### 1.3 Run

```sh
bun run dev
```

```
[dev] data: /Users/<you>/.team-ax-dev
[dev] direct: http://localhost:19100
[dev] relay:  http://demo.localhost:19161  (the team registers itself a few seconds after start)
[dev] engines run as <you> with your own Claude Code / Codex logins (local-login). Ctrl-C stops everything.
[server] {"t":"…","level":"info","msg":"first-run setup: POST /api/setup with setupToken <T> (or open http://127.0.0.1:19100/setup?token=<T>)"}
```

The setup link sits inside that JSON log line, before the closing `)`. Debug lines follow, so search the terminal for
`setup?token` if it scrolled away.

- Ports 19100 and 19161 are fixed in `scripts/dev.ts`, so **only one dev instance can run per Mac**. Before it starts
  anything, `bun run dev` checks 19100, 19161 (and 19140 with `--vite`) and stops with the process that holds a port
  (`cannot start: port 19100 (team server) is in use by pid …`). If that is the dev service, stop it with
  `bun run dev:service stop`.
- The log line "relay: team address registered; the recovery code was saved once…" can be ignored in dev.
- Flags: `--vite` (Vite on 19140), `--no-relay`, `--team <name>`, `--rebuild-web`, `--no-web-build`.
- `TEAM_AX_DEV_DIR` moves the data folder. Keep it short: every socket under `<data>/data/run/` must fit in a Unix
  socket path (at most 103 bytes on macOS). `bun run dev` refuses a data folder whose socket paths are too long and
  names them (`cannot start: socket path too long: …`). The server says the same at start, in Admin → System →
  Diagnostics ("AI engine socket paths") and in the log when a chat tries to start the engine. Avoid `/tmp` as well,
  because macOS cleans it. `bun run dev` warns that chats can fail there; in review, two real Claude turns (one
  writing a file) worked with the data in `/private/tmp`, so that warning overstates it (known gap 14).

### 1.4 Create the team

**Your own team.** Open the `http://127.0.0.1:19100/setup?token=…` link from the log. The setup token field is
hidden when the token is in the URL. "Create your team" asks for:
- Team name.
- **Team language**: English (default), 한국어 or Bahasa Indonesia. Picking one also switches the screen.
- The owner's name, username (letters, digits and `. _ @ -`, 2–64 characters), password (at least 8
  characters) and **Confirm password**.

Click **Create team and start**. `127.0.0.1` and `localhost` are separate cookie origins, so keep using
`http://127.0.0.1:19100` (the setup link's origin); `localhost:19100` asks you to sign in again.

**Or the demo team.** In a second terminal, run:

```sh
bun run demo:seed      # --base http://localhost:19100 --data ~/.team-ax-dev/data
```

This creates the Korean "데모 팀" with the accounts `dion`, `admin1`, `alice` and `bob`. The password for all of
them is `teamax-demo-1`; sign in at `http://localhost:19100`. Running it again only fills in what is missing. It stops if the team was already set up
with a different owner.

**Check.** The home screen shows the yellow "Development mode: no OS isolation…" banner and a **Before you start**
list: Check the AI connection, Invite your team, Set folder permissions, Make the first backup. In **Admin → AI
engines**, Claude Code shows "Connected" with the owner's subscription login. Send "hello" in a new chat.

**Language.**
- Each person: their name at the bottom left → **Settings → Profile → Language**.
- Team default: **Admin → Team settings**.
- The sign-in, invite and reset screens have their own switcher.

The only browser console error before sign-in is a 401 on `/api/me`, which is expected.

### 1.5 Keep it running

```sh
bun run dev:service install | status | logs [n] | restart | stop | start | uninstall
```

`status` prints:

```
running (pid 63261)
  http://localhost:19100        answers
  http://demo.localhost:19161   answers
  log: /Users/<you>/Library/Logs/team-ax-dev/dev.log
```

- This installs a LaunchAgent, `~/Library/LaunchAgents/app.team-ax.dev.plist`, that runs **this checkout**. Its log
  is `~/Library/Logs/team-ax-dev/dev.log`. It restarts on crash and at login.
- The label is fixed, so running `install` from a second clone replaces the first one.
- `stop` only boots the agent out. The plist stays, so it can come back at the next login; use `uninstall` to remove
  it for good.

A forgotten owner password in dev, with the server running:

```sh
bun run dev admin reset-link [--username U]
```

It prints a one-time reset link.

## 2. Production install (role-account mode)

This mode runs the server as `_axserver` and the engines as `_axagent`, inside `sandbox-exec` and a pf anchor.
LaunchDaemons start it at boot, without anyone logging in. The engine account can reach only the server's model proxy
on `127.0.0.1:47821`, which adds the owner's Claude token, so the engine never sees it. First do 1.1 and 1.2 (tools,
Claude Code, clone); the `claude` sign-in itself is not needed for production.

The owner's steps, in order:

| Step | Command | Check |
|---|---|---|
| 2.0 Role-account test (do this first) | `bun run build:native && sudo bun tests/install/g-macos-install.ts` | last line `N/N checks passed (B blocked on the owner)`; report in `/private/tmp/mycel-test-install-report.json` |
| 2.1 Prepare | Full Disk Access for Terminal; `bun run dev:service uninstall` (optional) | |
| 2.2 Bundle | `bun run build:bundle` | `dist/release/root/` has `set-claude-token` and `mycel-account` |
| 2.3 Check, then install | `scripts/install-macos.sh --check …`, then the same with `sudo` and without `--check` | `install: installed mycel 0.1.0 …`; `curl -s http://127.0.0.1:47820/api/health` |
| 2.4 Claude token | `claude setup-token`, then `pbpaste \| tr -d '[:space:]' \| sudo …/root/set-claude-token`, `pbcopy < /dev/null` | `set-claude-token: stored for _axserver …`; `sudo ls -l …/secrets/claude-oauth-token` |
| 2.5 Codex login (optional, beta) | `cd / && sudo -u _axserver … admin.js codex-login` | `Codex is signed in for the engine account.` |
| 2.6 First owner | `open "http://127.0.0.1:47820/setup?token=$(sudo cat …/setup/code)"` or `root/mycel-account create-owner` | sign in at `http://127.0.0.1:47820` |
| 2.7 Verify | Admin → System → Diagnostics, then a chat | Claude Code "Signed in (setup-token)", model proxy "Listening on 127.0.0.1:47821", Claude answers |

The token tool is installed by the installer, so the token is stored after 2.3. The Korean PDF numbers these steps
differently (2.0 = 2-2, 2.2 = 2-3, 2.3 = 2-4/2-5, 2.4 = 2-6, 2.5 = 2-7, 2.6 = 2-8); server messages cite the numbers
used here.

### 2.0 Role-account test first (recommended, ~10 minutes)

```sh
bun run build:native
sudo bun tests/install/g-macos-install.ts      # MYCEL_TEST_CLAUDE=<path> picks another claude binary
```

It installs a separate test copy (id `mycel-test`, accounts `_axtsrv`/`_axtagt`, ports 19174–19178), runs the whole
path including the token tool, the model proxy and one real Claude Code turn as the engine account against a fake
model service (nothing goes to Anthropic), a fake Codex, update and roll-back, backup and uninstall, and removes
itself. It ends with `N/N checks passed (B blocked on the owner)` and writes
`/private/tmp/mycel-test-install-report.json`. "Blocked on the owner" counts checks this terminal session could not
make (no Full Disk Access, macOS waiting for the admin to approve deleting an account, no `claude` binary); each is a
`BLOCKED …` line with the reason, and none is a failure. macOS asks the logged-in admin to approve deleting the test
accounts. If any line says `FAIL`, do not go on to the real install; keep using dev mode and send the report file.
This script has not been run yet on this Mac in its combined form.

### 2.1 Prepare

```sh
bun run dev:service uninstall      # if you installed the dev service
```

Give Terminal **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access; add Terminal with **+**
if it is not listed), then **quit Terminal (⌘Q) and open it again**. Check: `ls ~/Library/Mail` no longer says
"Operation not permitted". Without it, the cron/at deny entries and Time Machine exclusions only produce warnings;
those warnings say "the setup package has it", but there is no setup package yet: grant the access and run the
installer again.

### 2.2 Build the bundle

```sh
bun run build:bundle             # this Mac's CPU: bun run build && bun scripts/build-bundle.ts [--version X] [--out DIR]
bun run build:bundle:universal   # Apple silicon + Intel in one bundle (--arch universal; ~2x the size)
```

This writes `dist/release/` with `VERSION`, `0.1.0.tar.zst` (~22 MB), `app/0.1.0/` and `root/`. It takes about 40
seconds. There is no `manifest.sig` because no release key exists yet, so the installer needs `--allow-unsigned`.
`--arch amd64` / `universal` needs the Intel helpers (`ARCHS="arm64 amd64" bun run build:native`, which the
universal script runs) and downloads the same Bun version for Intel once (checked against Bun's SHASUMS256.txt,
cached in `dist/.cache/`). The installer refuses a bundle built for another CPU type.

### 2.3 Run the installer (from the repo root)

Check first without root (it changes nothing):

```sh
# Claude only
scripts/install-macos.sh --check --from dist/release --allow-unsigned \
     --engine claude="$(readlink -f ~/.local/bin/claude)"

# or Claude and Codex (run one of the two)
scripts/install-macos.sh --check --from dist/release --allow-unsigned \
     --engine claude="$(readlink -f ~/.local/bin/claude)" \
     --engine codex="$(readlink -f "$(whence -p codex)")"
```

```
install: check passed: bundle 0.1.0 (arm64) from dist/release
install: engine claude: …/claude/versions/2.1.305 -> /Library/Application Support/mycel/app/engines/claude/<sha12>/claude (engine.claudeBin)
install: engine codex: …/bin/codex -> /Library/Application Support/mycel/app/engines/codex/<sha12>/codex (engine.codexBin)
install: version: no install found at /Library/Application Support/mycel (or not readable without root): fresh install of 0.1.0
install: ports: http 127.0.0.1:47820, office TLS 0.0.0.0:8443, model proxy 127.0.0.1:47821; accounts _axserver / _axagent; id mycel
```

Check that the `engine claude` line names 2.1.305; if Claude Code updated itself, reinstall the pin first (1.1).

Then install with the same choice:

```sh
# Claude only
sudo scripts/install-macos.sh --from dist/release --allow-unsigned \
     --engine claude="$(readlink -f ~/.local/bin/claude)"

# or Claude and Codex
sudo scripts/install-macos.sh --from dist/release --allow-unsigned \
     --engine claude="$(readlink -f ~/.local/bin/claude)" \
     --engine codex="$(readlink -f "$(whence -p codex)")"
```

Give two separate commands rather than deleting the `codex` line: removing it leaves the previous line ending in `\`,
and the shell waits at a `>` prompt.

Expected output ends with `install: installed mycel 0.1.0 (server _axserver, engine _axagent)`, the first-run setup
hint and the owner-recovery command. The installer waits up to
60 s for `/api/health`. Check it with `curl -s http://127.0.0.1:47820/api/health`. If the server never answers,
read `/Library/Logs/mycel/crash/server.log`.

- `--engine` takes `claude=FILE` (Claude Code) and/or `codex=FILE` (Codex CLI), each once; any other name is
  refused. FILE must be the real Mac executable (hence `readlink -f`; the npm `codex.js` wrapper is refused). It is
  installed as `app/engines/<name>/<sha12>/<name>` and set as `engine.claudeBin` / `engine.codexBin`. A later
  repair run without `--engine` keeps the engines already installed.
- `whence -p codex` prints the executable's path even when `codex` is also a zsh alias (do not use `$(which codex)`,
  which can print the alias). `~/.local/bin/codex` exists only with OpenAI's standalone installer. When Codex is not
  installed, `readlink -f` prints nothing and the installer says `engine codex:  not found` with an empty path.
  An npm install gives a `codex.js` wrapper, which the installer refuses ("is not a Mac program"); its hint still
  suggests `$(readlink -f $(which codex))` (known gap 14).
- Only the `codex` executable is copied, not helper files next to it (such as `codex-code-mode-host`), so some Codex
  features may not work in production.

| Flag | Default | Meaning |
|---|---|---|
| `--id` | `mycel` | folder and label name |
| `--server-user` / `--agent-user` | `_axserver` / `_axagent` | role accounts |
| `--port` | 47820 | HTTP on 127.0.0.1 |
| `--tls-port` | 8443 | office network (self-signed); 0 = off |
| `--proxy-port` | 47821 | local model proxy, the only address the engine account may reach |
| `--engine NAME=FILE` | | `claude=` and/or `codex=`, each once (`codex=FILE` is the Codex CLI, `engine.codexBin`) |
| `--codex-models FILE` | `~$SUDO_USER/.codex/models_cache.json` | Codex model list, locked into `app/engines/codex/<sha>/model_catalog.json` |
| `--check` | | check only, no root needed, changes nothing |
| `--allow-unsigned` | | accept an unsigned bundle |
| `--no-power` | | skip `pmset` (laptops) |
| `--skip-tmutil` | | skip Time Machine exclusions |

What it creates:
- **Role accounts.** Made with `dscl`: UID 450–499, hidden, shell `/usr/bin/false`, no password.
- **`/Library/Application Support/mycel/`.** It holds:
  - `app/` (`versions/<v>`, `current`, `engines/<name>/<sha12>/<file>`);
  - `data/`, `team/`;
  - `config/server.json`;
  - `secrets/lan-tls.*`;
  - `setup/code`;
  - `status/`, `agent/` (`_axagent` 700), `agent/home` (root 555), `agent/codex-auth` (`_axagent` 700, the engine
    account's Codex login);
  - `root/` (bootstrap, launcher, `engine.sb`, `pf-load`, the account tool `mycel-account`, `set-claude-token`).
- **pf anchor** `com.apple/250.mycel`.
- **Self-signed TLS certificate** (ECDSA P-256, 825 days, serverAuth). It names `<LocalHostName>.local`,
  `localhost`, `127.0.0.1`, `::1` and every LAN IPv4/IPv6 address of the Mac (not IPv6 link-local or temporary
  privacy addresses). The server checks it every minute and makes a new one when an address is not covered (new
  Wi-Fi, new DHCP lease, another network port), the Mac was renamed, or it expires within 30 days; it then rewrites
  `setup/lan-cert.sha256` and restarts the TLS listener. A renewal for a new address keeps the addresses the old
  certificate named (up to 24), so moving back to an earlier network needs no new certificate. A new certificate
  means a new fingerprint: browsers show the warning once more.
- **LaunchDaemons** `app.treesoop.mycel.{server,launcher,pf}`.
- **Logs** in `/Library/Logs/mycel/`.
- `_axagent` is added to `cron.deny` and `at.deny`.
- **Power:** `pmset -a sleep 0 autorestart 1 womp 1`.

Running the installer again with the **same** bundle repairs the install. With a **newer** bundle it switches
`app/current` to it, like an in-app update: the running version stays in `app/versions` as the roll-back version
(Admin → System → Update → Roll back), and if the new version does not answer within 120 s or crashes 3 times the
bootstrap goes back to the old one by itself; the installer then exits 1 and says so. An **older** bundle is only
staged (warning); the running version stays. The root programs (bootstrap, launcher, `engine.sb`, `pf-load`, account
tool) only move forward: `root/VERSION` names the bundle they came from, and an older bundle leaves newer ones in place
(warning), so an old setup package run again cannot take back launcher or sandbox fixes; to really go back, uninstall
(the data is kept) and install the older package. The installer needs no developer tools (it reads CPU types with
`file`, not `lipo`), and it runs the bundle's bun from its root-only staging folder with no `BUN_*`/`NODE_*`
settings, so a `bunfig.toml` or `.env` in the folder it was started from is never read as root. Data kept by an earlier `uninstall-macos.sh` (without
`--delete-data`) is given back to the server account, so the team is there again after a reinstall.

### 2.4 Claude long-lived token (owner, once a year)

```sh
claude setup-token        # approve in the browser with the Claude subscription (Pro/Max); prints sk-ant-oat01-… once; copy all of it
T="/Library/Application Support/mycel/root/set-claude-token"
pbpaste | tr -d '[:space:]' | sudo "$T"
sudo ls -l "/Library/Application Support/mycel/secrets/claude-oauth-token"     # -rw------- 1 _axserver …
pbcopy < /dev/null        # empty the clipboard
```

`tr -d '[:space:]'` matters: `set-claude-token` keeps only the **first line** of its input and accepts
`sk-ant-oat01-` plus 20 or more characters, so a token that `claude setup-token` wrapped over two lines would
otherwise be stored half, reported as stored for a year, and refused on the first chat (known gap 14).

- `set-claude-token` (root-owned, installed by the installer) reads the token from standard input, never from the
  command line, checks that it looks like a setup-token, and stores it as
  `secrets/claude-oauth-token` (`_axserver`, mode 600). The engine account cannot read it.
- No restart: the server reads the file on every model request.
- Diagnostics then show Claude Code as "Signed in (setup-token)". They also say when the token is older than a year
  (expired), expires within 14 days, or was refused by Claude (revoked or pasted wrong; admins also get a notice).
- The token expires after a year; replace it with the same commands. `--remove` forgets it.

### 2.5 Codex login for the engine account (owner, once)

Codex runs as `_axagent` with its own ChatGPT login. Use a ChatGPT account meant for the team's AI, not your
personal one: the engine can read the login it is given for a turn (design tab 2, "Codex 네트워크").

```sh
B="/Library/Application Support/mycel"
cd / && sudo -u _axserver env MYCEL_MODE=prod HOME="$B/data" "$B/app/current/bin/bun" "$B/app/current/server/src/admin.js" codex-login
```

It prints a link (`https://auth.openai.com/codex/device`) and a one-time code. Open the link in any browser, sign in,
enter the code (it expires after 15 minutes). The command waits and ends with "Codex is signed in for the engine
account."

- The server must be running: the login goes through its model proxy. `_axagent` can reach nothing else (pf).
- The launcher runs `codex login --device-auth` as `_axagent`, under the engine sandbox. The login is stored in
  `agent/codex-auth/auth.json` (`_axagent` 600). The server account cannot read it.
- Start the command with `cd / &&` as shown. `_axserver` cannot enter your home folder (`drwxr-x---`), and bun
  started from a folder it cannot enter exits 1 with `error: An unknown error occurred (Unexpected)`. The same goes
  for every `admin.js` command in this document.
- Status and logout, the same way:
  ```sh
  cd / && sudo -u _axserver env MYCEL_MODE=prod HOME="$B/data" "$B/app/current/bin/bun" "$B/app/current/server/src/admin.js" codex-status   # {"loggedIn":true,…}; no token printed
  cd / && sudo -u _axserver env MYCEL_MODE=prod HOME="$B/data" "$B/app/current/bin/bun" "$B/app/current/server/src/admin.js" codex-logout
  ```
- For each Codex turn the launcher copies the login into the chat folder. If Codex refreshes the token, the launcher
  writes it back, but only a plain file for the same ChatGPT account. One Codex turn runs at a time.
- **Codex is beta in production.** Only the owner can use it, plus anyone whose user id is in the setting
  `codexUsers` (a list of user ids; there is no screen for it yet). It cannot be the team default.
  - Verified so far: the login and the HTTPS path go through the proxy with the sandbox on.
  - Not yet verified with a real login: Codex WebSockets, token refresh and web search with pf on.

### 2.6 First-run setup

```sh
C=$(sudo cat "/Library/Application Support/mycel/setup/code")     # _axserver:admin 640
open "http://127.0.0.1:47820/setup?token=$C"
```

This opens the setup page on the server Mac (the installer prints the link with a literal `<code>`). The setup flow also works over the office TLS
port, `https://<host>.local:8443/setup?token=…`. The screen is the same as in 1.4. After setup the server deletes
`data/setup-token`; `setup/code` stays, which is harmless.

Or create the owner from the terminal (asks for the password twice):

```sh
sudo "/Library/Application Support/mycel/root/mycel-account" create-owner --username kim --name "Kim" --team "Acme" [--locale en|ko|id]
```

Replace `kim`, `Kim` and `Acme` with your own username, name and team name.

### 2.6a Owner password recovery (production, no email)

Whoever can administer the server Mac can recover the owner; the Mac admin password `sudo` asks for is the proof.

```sh
A="/Library/Application Support/mycel/root/mycel-account"
sudo "$A" list-owners                  # who the owner is
sudo "$A" reset-link [--username U]    # one-time link, 24 h; a new link cancels the previous one
sudo "$A" status
```

Open the printed `http://localhost:47820/reset-password/…` link on the server Mac and set a new password; the
owner's other sessions are signed out. The tool runs the bundled account CLI as `_axserver` (never as root).

### 2.7 What you see right after install

| Where | What it shows |
|---|---|
| Admin → AI engines | Claude Code: "Engine account sign-in"; not signed in until the token is stored (2.4). Codex (beta): "The engine account has no Codex sign-in yet" until 2.5, then "Connected". |
| Admin → System → Diagnostics | Claude Code: "Signed in (setup-token)" once the token is stored, or why not (missing, expired, refused). Model proxy: listening on 127.0.0.1:47821. Codex: a warning until 2.5 (the launcher reports the engine account's login), then "Signed in". pf, sandbox, launcher, cron.deny and Time Machine: real checks. Release signature: a warning (unsigned). |
| A chat | Without the token: "The team's Claude subscription is not connected yet." With it: Claude answers. |

**Launcher daemon down.** Diagnostics shows "AI engine launcher: The AI launcher is not running" with the command that
starts it again (`sudo launchctl kickstart -k system/app.treesoop.mycel.launcher`, or, when launchd says the service
could not be found, `sudo launchctl bootstrap system /Library/LaunchDaemons/app.treesoop.mycel.launcher.plist`) and the log to read if it stops
again (`/Library/Logs/mycel/crash/launcher.log`). Until 2026-10-21 opening Diagnostics (or sending a chat) while the
launcher was down ended the server with `connect ENOENT …/launcher.sock`; that is fixed.

**Diagnostics that name menubar actions.** The pf lines (`firewallMissing`, `firewallStale`, `firewallOff`), the
sandbox line (`sandboxMissing`), the cron.deny line (`cronDenyMissing`) and the launcher line (`launcherDown`) still
say to run "Repair firewall" or "Reinstall" in the menubar app. The menubar app has neither (known gap 3). Instead,
run the installer again with the bundle you last installed; it repairs pf, the sandbox profile, cron.deny and the
LaunchDaemons and keeps the data, the token and the engines:

```sh
cd ~/team-ax && sudo scripts/install-macos.sh --from dist/release --allow-unsigned
```

For the launcher alone, `sudo launchctl kickstart -k system/app.treesoop.mycel.launcher` is enough.

### 2.8 Menubar app (optional)

```sh
menubar/build.sh            # menubar/build/Team AX.app, ad-hoc signed; --test runs the model tests
```

1. Copy the app to `/Applications` and open it.
2. To start it at login, add it yourself: System Settings → General → Login Items → Open at Login → **+**.
3. The menu shows server and relay status, plus:
   - **Open logs folder** (`/Library/Logs/mycel`) and **Refresh**;
   - **Open web screen**, only when `status.json` gives a web address;
   - **Open Login Items settings**, only when the server's background item is switched off.

It does not have the setup assistant, the subscription connection or uninstall yet, and it does not read
`setup/code` (use `sudo cat` as in 2.6).

With FileVault on (`fdesetup status`), the Mac waits at the unlock screen after a power cut or restart, and the
server does not start until someone unlocks it at the Mac (not tested). Decide who does that; for a planned restart,
`sudo fdesetup authrestart` skips the unlock once.

## 3. Connecting members

| Install | Address | Who can reach it |
|---|---|---|
| Dev mode | `http://localhost:19100`, `http://demo.localhost:19161` | The server Mac only |
| Office mode ([OFFICE.md](OFFICE.md)) | `https://<LAN-IP>:8443`, `https://<LocalHostName>.local:8443` | Desks and phones on the Mac's office subnet after installing the office CA once (page on `http://<LAN-IP>:8442`, thumbprint compared with the desk card from `teamax card`). Chats work. |
| Production, office network | `https://<LocalHostName>.local:8443` or `https://<LAN-IP>:8443` | Browsers and phones on the same network (not tested on a real install). The certificate is self-signed, so each person clicks through the warning once (again after it is renewed for a new address): Chrome/Edge **Advanced → Proceed to … (unsafe)**; Safari on the Mac **Show Details → visit this website → Visit Website** (asks for the Mac password); Safari on iPhone **Show Details → visit this website → Visit Website**. |
| Team AX relay | `https://<team>.treesoop.com` | Not available: `wss://relay.treesoop.com/connect` is not running. Admin → System does not offer it until `relay.officialAvailable` is `true` in `config/server.json`. |
| Your own relay | your domain | Advanced and not tested end to end; see below. The "Cloudflare tunnel" and "Tailscale" modes are rejected with "not available in this version". |

Find the host name with `scutil --get LocalHostName`. If the macOS application firewall blocks the server, allow the
bun the bootstrap actually runs:

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add \
     "$(sudo readlink -f "/Library/Application Support/mycel/app/current")/bin/bun"
```

`app/current` points at `versions/<version>`, so this names the running version. Run it again after each update. Not tested; the bundled bun is signed by Oven, so the default "allow signed
software" setting may already cover it.

**Invite links.**
1. Go to Admin → **Members & invites** → **Invite link**.
2. Pick the role, the groups and how long the link lasts (1–30 days, default 7).
3. Click **Create link**, then **Copy link** (or **QR code**). Each link works once.
4. The member opens it ("Join {team}"), picks a username, name and password, and clicks **Create account and
   join**.

**The link uses the address you are on.** Create invites while signed in at the address members will use, not at
`127.0.0.1:47820`. In production that means opening `https://<LocalHostName>.local:8443` (on the server Mac or
another office computer), clicking through the certificate warning, and signing in as the owner again: it is a
different origin from `127.0.0.1:47820`. Check: the member shows up in Admin → Members & invites once they join.

Alternatives:
- **Add directly**: the temporary password field comes pre-filled with an easy one (a word and digits, e.g. `tiger4271`); keep it or type your own (8+ characters). At first sign-in the member only chooses a new password (the temporary one is not asked again); a temporary password stops working after 7 days.
- **Reset password** (key icon): a new temporary password (pre-filled, editable) the member must change at their next sign-in.
- **Reset link** (person-with-key icon): a one-time link, valid for 24 hours, that you copy and hand over (no email).
  The member opens it and picks a new password, which signs them out everywhere else. A new link cancels the old
  one. The owner's own password is reset only on the server Mac (`bun run dev admin reset-link` in dev).

**Mac app.** Today the desktop apps connect only on the server Mac itself (`http://127.0.0.1:47820`, or
`http://127.0.0.1:19100` in dev): any other address needs a publicly trusted HTTPS certificate, which only the team
address will give. Members use the browser for now.
1. Build it:
   ```sh
   bun run dist:mac            # = cd desktop && bun run dist:mac
   ```
   This writes `desktop/release/Team-AX-0.1.0-mac-universal.dmg` (~230 MB, unsigned, Apple silicon and Intel).
   `bun run --cwd desktop dist:mac:arm64` / `dist:mac:x64` build a smaller single-CPU DMG.
2. Drag the app to Applications, then right-click → Open. On macOS 15+, use System Settings → Privacy & Security →
   **Open Anyway**.
3. If the file was copied from another Mac, run:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/Team AX.app"
   ```

Addresses the app accepts:
- plain `http` only for `localhost`, `*.localhost` and 127.x;
- a bare name becomes `https://<name>.treesoop.com`;
- any other address needs a publicly trusted HTTPS certificate.

The office address is not typed in. Signed in at the team address, the app asks `GET /api/connect-info` for the
office address (`<LocalHostName>.local` and the Mac's private IPv4 addresses), the port and the SHA-256 of the office
certificate, and on the office network it uses that address with only that certificate (pinned, never trust on first
use). When the office address does not answer while the server Mac's `.local` name does, or shows another
certificate, the app reports it (`POST /api/connect-info/lan-failure`) and Diagnostics shows "Office direct
connection" with the count. A server with no team address (office network only) still cannot be added in the app
(adding by QR code / fingerprint is not built). There is no auto-update.

**Windows.** Build the installer with:

```sh
cd desktop && bun run dist:win
```

This writes `desktop/release/Team-AX-Setup-0.1.0-win-x64.exe`; it builds on a Mac. It is unsigned, so SmartScreen
warns: click **More info → Run anyway**. The same address rules apply.

**Offer the apps in the product.** Put the installers and an `index.json` in `<data>/downloads/`. Members then see
them under **Settings → Apps → Desktop app** (signed-in people only: `/downloads/*` needs a session, with Range for
resumed downloads). In office mode `~/TeamAX/teamax desktop add <installer>` does all of this (docs/OFFICE.md).
Only the files `index.json` lists are served (plain files, not links). Set `"signed": true` only for a signature you
verified (it hides the SmartScreen / Gatekeeper steps). `index.json` looks like this (`size` in bytes: `stat -f %z <file>`):

```json
{"items":[{"platform":"mac","file":"Team-AX-0.1.0-mac-universal.dmg","version":"0.1.0","size":123,"signed":false}]}
```

In dev `<data>` is `~/.team-ax-dev/data`. In production it is `/Library/Application Support/mycel/data`, which belongs
to `_axserver`, so copy with `sudo` and give the folder back to the server account:

```sh
D="/Library/Application Support/mycel/data/downloads"
sudo mkdir -p "$D"
sudo cp desktop/release/Team-AX-0.1.0-mac-universal.dmg index.json "$D/"
sudo chown -R _axserver "$D"
```

Until desktop apps can connect from other computers, this has little use.

**Phone.**
- iPhone: Safari → Share → **Add to Home Screen**.
- Android: Chrome menu → **Install app**.

Then sign in once more in the installed app. Today the only address a phone can reach is the production office
address. With a self-signed certificate it may only work as a bookmark (not tested).

### Your own relay (advanced, not tested end to end)

The relay code works locally. A team server pointed at `ws://127.0.0.1:<port>/connect` with `relay.teamName` set
registered itself, and `/api/health` answered through the relay.

The full setup:
1. Run the relay on Node 25 on a Linux host behind Cloudflare, with a proxied wildcard `*.yourdomain` DNS record
   plus `relay.yourdomain`:
   ```sh
   node relay/src/main.ts --domain yourdomain --port 8080 --data /var/lib/mycel-relay [--trusted-proxies 127.0.0.1,::1]
   ```
   Use `--trusted-proxies` when `cloudflared` runs on the relay host.
2. On the team server, open Admin → System → **Change connection** → "Your own relay server", enter
   `wss://relay.yourdomain/connect`, and enter your password again.
3. In the same dialog, enter the **team name at the relay** (lowercase letters, digits and hyphens; the team address
   becomes `<name>.yourdomain`). The server saves `relay.url` and `relay.teamName` in `config/server.json` and
   restarts.
4. The recovery code is written once to `data/relay/recovery-code.txt`. Print it, then delete the file.
5. To free a name later, run `node relay/src/main.ts release <team> --domain <d> --data <dir>`. The name stays held
   for a year.

## 4. Update, backup, uninstall

**Update (dev):**

```sh
git pull && bun install && bun run build && bun run dev:service restart
```

**Update (production).** There is no release feed yet (`update.feedUrl` is null), so Admin → System → Update says
"This server does not look for new versions online" and offers only Roll back. To update:
- **New version (normal way):** read the running version with `curl -s http://127.0.0.1:47820/api/health`
  (`"version":"0.1.0"`), then build a **higher** one (raise the last number each time: 0.1.1, 0.1.2, …) and run the
  same installer command:
  ```sh
  git pull && bun install && bun run build
  bun scripts/build-bundle.ts --version 0.1.1
  sudo scripts/install-macos.sh --from dist/release --allow-unsigned
  ```
  It switches to 0.1.1, keeps 0.1.0 for Roll back, and goes back by itself if 0.1.1 does not start (2.3; not tested
  on a real install). Building the same number again replaces that version in place and leaves nothing to roll back
  to.
- **Same version string (repair only):** run `bun run build:bundle`, then the same installer command. It replaces
  `app/versions/0.1.0`.
- **By hand as `_axserver`** (what the in-app update does). The bundle must be readable by `_axserver`, and your
  home folder is not, so copy it to `/Users/Shared` first:

  ```sh
  bun scripts/build-bundle.ts --version 0.1.1
  cp dist/release/0.1.1.tar.zst /Users/Shared/
  ADMIN='cd / && sudo -u _axserver env MYCEL_MODE=prod "/Library/Application Support/mycel/app/current/bin/bun" "/Library/Application Support/mycel/app/current/server/src/admin.js"'
  eval "$ADMIN stage-update /Users/Shared/0.1.1.tar.zst"
  eval "$ADMIN switch 0.1.1 --restart"      # roll back: eval "$ADMIN rollback --restart"
  ```

  The bootstrap rolls back by itself if the new version does not answer within 120 s or crashes 3 times (not tested
  on a real install).

**Backups.**
- Nightly after 03:00, kept 14 days: a full backup every 7 days, incremental in between.
- **Back up now** is in Admin → System → Backups.
- Backups hold the database and the team folder. Restoring one in Admin → System → Backups restores the
  **database only** (accounts, chats, settings) and asks for your password; the team files stay as they are. To get
  team files back as they were at a backup, `restore-team --backup ID --to NEWDIR` writes them to a new folder to copy
  from; single files have their own version history in the file panel.
- Export writes chats, memory and the team folder to the owner's `exports` folder.

These backups are on the same disk. For an off-machine copy:
- **Production:** make an encrypted archive. `--password-stdin` takes at least 8 characters; end the input with
  Ctrl-D.
  ```sh
  eval "$ADMIN archive --out /Users/Shared/teamax.tar.zst.age --password-stdin"
  ```
  It prints `{"file":"/Users/Shared/teamax.tar.zst.age","size":…,"sha256":"…","encrypted":true,"files":N}`. The file
  belongs to `_axserver` (mode 600), so copy it to the external disk with `sudo cp`. Keep the password somewhere safe.
  `restore-archive --in F --to NEWDIR` decrypts and unpacks it into a new folder (`db/app.sqlite` and `team/`), for
  taking files out after a disk failure. There is no command yet to run a server from that folder.
  The other `admin.js` commands are `backup [--scope db|full]`, `list-backups`, `restore-archive --in F --to NEWDIR`,
  `restore-team --backup ID --to NEWDIR` and `stage-restore --backup ID`.
- **Dev:** stop the service and copy `~/.team-ax-dev`.

A locked-out owner is recovered with the account tool (2.6a).

**Uninstall (production):**

```sh
sudo scripts/uninstall-macos.sh [--delete-data] [--keep-accounts] [--id mycel]
```

- It removes:
  - the daemons and the pf anchor;
  - the accounts, `app/`, `root/`, `config/`, `secrets/`, `agent/`, `setup/` and `status/`;
  - the logs, the newsyslog file, the cron/at deny entries and the Time Machine exclusions.
- Without `--delete-data` it keeps `data/` and `team/`, re-owned to root.
- It prints anything left over and exits 1 if there is any; errors exit 2. There is no dry run.
- macOS 26 asks the logged-in admin to approve deleting the accounts. If nobody approves, they stay locked.
- Output: `uninstall: kept the team folder and data in …` (without `--delete-data`), then `uninstall: removed mycel`,
  or `uninstall: left over:` and a list.

**Uninstall (dev):** run `bun run dev:service uninstall`, then delete or move `~/.team-ax-dev`.

**Dev → production.** Run `bun run dev:service uninstall`, then 2.2 and 2.3. The dev and demo data is **not moved**;
set up a new team.

**Production → dev:**

```sh
sudo scripts/uninstall-macos.sh ; bun run dev:service install
```

Use `;`, not `&&`: the uninstaller exits 1 when something is left over.

## 5. Troubleshooting

Start with **Admin → System → Diagnostics** (owner only). It checks the server, relay, disk space, engine logins,
queue, pf, sandbox, launcher, cron.deny, Time Machine, backups, update and release signature.

| Symptom | What to do |
|---|---|
| Logs | Dev: the terminal, `bun run dev:service logs`, `~/Library/Logs/team-ax-dev/dev.log`. Production: `/Library/Logs/mycel/server/` (JSON) and `/Library/Logs/mycel/crash/{server,launcher,pf}.log` (daemon stdout/stderr, start failures) |
| `cannot start: socket path too long` (dev) or Diagnostics "AI engine socket paths" fails | The data folder path is too long; use the default `~/.team-ax-dev` |
| "The AI engine is not available right now…" | Dev: no `native/bin/<platform>`; install Go and run `bun run build:native` (Intel: `ARCHS=amd64`). Production: Diagnostics shows why (launcher, engine file); an engine "Not installed" needs the installer again with `--engine claude=…` |
| "The AI connection (model proxy) is not ready" | Production: see "Model proxy" in Diagnostics; the server retries binding every 10 s |
| Engine "not logged in" (dev) | Run `claude` or `codex login` as the same macOS user, then refresh in Admin → AI engines |
| "relay skipped: it needs Node 25+" | Install Node 25+; the direct address still works |
| Admin → AI engines: "Unsupported version" | Claude Code is not 2.1.305 (it updated itself). Dev chats still work; for production reinstall the pin (1.1) and run the installer again with `--engine claude=…` |
| An `admin.js` command ends with `error: An unknown error occurred (Unexpected)` | It was started from a folder `_axserver` cannot enter; start it with `cd / &&` (2.5) |
| Diagnostics say to run "Repair firewall" / "Reinstall" in the menubar app | Those menubar actions do not exist yet; run the installer again (2.7) |
| Port in use | `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Dev: 19100, 19161, 19140 (with `--vite`). Production: 47820, 8443, 47821 |
| Diagnostics: "The AI launcher is not running" | Run the command it shows; if it stops again read `/Library/Logs/mycel/crash/launcher.log` (2.7) |
| Relay "Not registered" | `relay.teamName` missing in `server.json`, or the name is taken or reserved |
| Owner password forgotten | Dev: `bun run dev admin reset-link`. Production: `sudo "/Library/Application Support/mycel/root/mycel-account" reset-link` (2.6a) |
| Claude token expiry (1 year) | Repeat 2.4; diagnostics warn 14 days before (counted from when the token was stored) |
| "The team's Claude subscription is not connected yet" | Production: store the token (2.4) |
| "The AI connection has a problem" + admin notice "token was refused" | Production: the token was revoked, expired or stored incomplete; make a new one and store it (2.4, with `tr -d '[:space:]'`) |
| Diagnostics "Model proxy port in use" | Another program holds 127.0.0.1:47821 (`lsof -nP -iTCP:47821 -sTCP:LISTEN`); the server retries every 10 s |
| `curl` against the API returns `{"error":{"code":"csrf"}}` | Send the header `x-mycel-csrf: 1` |

## Known gaps

1. **Production chats are not verified on a real install yet.** Subscription mode works as the current user with the
   real `claude` binary (2.1.306, against a fake model service) and is covered by
   `sudo bun tests/install/g-macos-install.ts` (2.0), which has not been run on this Mac. A real answer also needs the
   owner's `claude setup-token` token; no answer from Anthropic through the proxy has been seen yet.
2. **Codex in production is beta.** It works through the model proxy: `engine.codexBin`, the locked catalog,
   `agent/codex-auth` and `admin.js codex-login` (2.5). Only the owner (plus `codexUsers`, no screen) can use it, and
   it cannot be the default. The open checks with a real ChatGPT login and pf on are WebSockets, token refresh and web
   search. Only the single `codex` executable is installed, not its helper files.
3. **The menubar app has no token step, setup assistant, "Repair firewall", "Reinstall" or uninstall.** The token is
   stored with `set-claude-token` in Terminal (2.4); repairs are an installer re-run (2.7).
4. **The model proxy's caller check compares only the session id** (ancestor chain and start time are follow-ups).
5. *(fixed 2026-10-21)* Diagnostics no longer ends the server when `launcher.sock` is missing.
6. *(fixed 2026-10-21)* Admin → System asks for the relay team name and hides "Team AX relay" while it is not running.
7. **An office-only server cannot be added in the desktop app.** The app uses the office address once it knows the
   team address (`GET /api/connect-info`, pinned certificate); adding a server by QR code / fingerprint is not built.
8. **No release feed.** The in-app update only offers Roll back; new versions come from re-running the installer.
9. *(fixed 2026-10-21)* Socket paths that are too long are named by `bun run dev`, at server start and in Diagnostics.
10. **Small doc and code mismatch:** the dev Diagnostics sandbox text is out of date.
11. **Intel Macs:** `bun run build` and dev mode build arm64 helpers by default (`ARCHS=amd64`); the universal
    bundle and DMG cover both CPU types but have only been run under Rosetta, not on an Intel Mac.
12. **Dev ports are fixed (19100/19161).** `bun run dev` now names the process holding one before it starts. A second
    instance needs a copy of `scripts/dev.ts` with other ports; a port flag or env var would fix it.
13. **Owner-blocked items.** Apple and Windows signing, the production relay and CI billing are waiting on the
    owner; see [OWNER-TODO.md](OWNER-TODO.md). Run `bun run typecheck && bun run test` locally.
14. **Code follow-ups from the install-guide review (2026-10-21).** The docs work around each of these; the code
    still needs the change:
    - `set-claude-token` keeps only the first line of its input and needs only 20 characters after `sk-ant-oat01-`:
      it should strip all whitespace from the whole paste, require the full token length, and have a unit test with
      a wrapped token.
    - `server/src/system/messages.ts`: `firewallMissing`, `firewallStale`, `firewallOff`, `sandboxMissing`,
      `cronDenyMissing` and `launcherDown` point to menubar actions that do not exist; they should give the installer
      re-run and the `launchctl kickstart` command. The token and Codex messages cite "INSTALL.md 2.4 / 2.5" only;
      the Korean PDF calls those steps 2-6 / 2-7.
    - `install-macos.sh`: `--check` should warn when an engine's version differs from `versions.json` (the bundle has
      no `versions.json`, so any Claude version is copied silently); name the empty-path case of `--engine codex=`;
      the "is not a Mac program" hint should suggest `whence -p` instead of `which`; the Full Disk Access warnings
      mention a "setup package" that does not exist.
    - `tests/install/g-macos-install.ts` runs `admin.js` with cwd `/`, so the documented `cd / &&` is never tested
      against the failing form; add a `codex-status` run from the repository folder (needs a sudo run).
    - `scripts/dev.ts` / `dev-checks.ts` overstate the `/tmp` data-folder warning; the `scripts/dev-service.ts` header
      says `stop` lasts across a reboot, but the plist keeps `RunAtLoad`; the demo-seed refusal names
      `~/.team-ax-dev` even when `TEAM_AX_DEV_DIR` is set.
    - Move the Claude Code pin to the version the lockdown test passes on (the subscription test already ran on
      2.1.306).
