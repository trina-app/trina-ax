# Installing Team AX

Team AX runs on one Mac, the **server Mac**. That Mac runs the team server and the AI engines: Claude Code on the
owner's Claude subscription, and optionally the Codex CLI on a ChatGPT login. Team members use the web app, the
Mac or Windows desktop app, or a phone browser.

Checked on 2026-10-21 against commit `8edf5d2` on macOS 26.3.1 (Apple Silicon). A Korean, illustrated version for
the person who installs it is in [docs/install/Team-AX-설치가이드.pdf](install/Team-AX-설치가이드.pdf) (source
`docs/install/guide.html`, rebuild with `bun docs/install/build-pdf.ts`).

## Status: what works today

| | Status |
|---|---|
| Dev mode on one Mac, chats included (Part 1) | Works |
| Teams, invite links, folder permissions, backups | Works |
| Production installer (`scripts/install-macos.sh`): role accounts, LaunchDaemons, sandbox, pf | Runs. Claude chats work once the owner stored a `claude setup-token` token (2.4); not yet verified on a real install (see below) |
| Public team address `<team>.treesoop.com` | Not available: the production relay is not running |
| Signed and notarized apps (Mac, menubar, Windows) | Not available: apps are unsigned, so the OS warns on first launch |
| Reaching a dev-mode server from another computer or phone | Not possible: the server listens on 127.0.0.1 only |

**Production chats (subscription mode).** The installer writes `engine.authMode: "subscription"`. Claude Code runs
as the hidden engine account `_axagent` under the sandbox and pf; the only address it can reach is the server's
model proxy on `127.0.0.1:47821`. The proxy adds the owner's `claude setup-token` token (2.4), which only the server
account can read; the engine only ever gets a per-turn token. This path is tested as the current user
(`tests/unit/g-subscription.test.ts`, also with the real `claude` binary against a fake model service) and in the
role-account install test, which needs `sudo` and has not been run on this Mac yet. Codex is not connected in
production yet (2.5).

There is **no email** anywhere, by design. Invites and password resets are links an admin copies and sends.

## What you need

- A Mac that stays on and plugged in. Apple Silicon is recommended; Intel needs one extra build step.
- macOS: checked on 26.3.1. The menubar app needs macOS 13+.
- A **Claude Pro or Max** subscription. All of the team's AI use comes out of it. A ChatGPT subscription for Codex
  is optional.
- An admin password for the production install (`sudo`). Dev mode does not need one.
- Read access to the repository (private for now).

## 1. Quick try: dev mode on one Mac

The engines run as **you**, with your own Claude Code and Codex logins. There is no OS isolation, usage comes out of
your subscriptions, and Claude Code puts your account email into every turn's context.

### 1.1 Tools

```sh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# run the "Next steps" lines Homebrew prints, then open a new terminal
brew install go node ripgrep pandoc poppler typst ffmpeg whisper-cpp
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.12"
curl -fsSL https://claude.ai/install.sh | bash
claude            # sign in with a Claude Pro/Max account, then quit
```

| Tool | Version | Needed for |
|---|---|---|
| Bun | **1.3.12** (pinned) | everything |
| Go | 1.27.3 | native helpers (`mycel-gate`, `mycel-bridge`, `mycel-launcher`, `mycel-bootstrap`) |
| Node | **25+** | the relay only. Without it `bun run dev` prints "relay skipped" and the direct address still works |
| ripgrep, pandoc, poppler, typst | | file search, Office/PDF text, PDF output |
| ffmpeg, whisper-cpp | | voice input (downloads a ~490 MB model on first use) |
| Claude Code | **2.1.305** (pinned; the lockdown tests run against it) | the Claude engine |
| Codex CLI (optional) | 0.163.0 | the Codex engine: install it, then `codex login` |

Check: `bun --version` prints `1.3.12` and `node --version` prints v25 or later.

### 1.2 Clone and build

```sh
cd ~
git clone git@github.com:potenlab/team-ax.git
cd team-ax
bun install          # "1579 packages installed"
bun run build        # native/bin/<platform> and web/dist, ~10 s
```

On an Intel Mac, also run `ARCHS=amd64 bun run build:native`. `native/build.sh` builds arm64 only by default, and
without this step every chat ends with "engine unavailable".

### 1.3 Run

```sh
bun run dev
```

```
[dev] data: /Users/<you>/.team-ax-dev
[dev] direct: http://localhost:19100
[dev] relay:  http://demo.localhost:19161  (the team registers itself a few seconds after start)
[dev] engines run as <you> with your own Claude Code / Codex logins (local-login). Ctrl-C stops everything.
[server] … first-run setup: … (or open http://127.0.0.1:19100/setup?token=<T>)
```

- Ports 19100 and 19161 are fixed in `scripts/dev.ts`, so **only one dev instance can run per Mac**. If the dev
  service is running, stop it first with `bun run dev:service stop`.
- The log line "relay: team address registered; the recovery code was saved once…" can be ignored in dev.
- Flags: `--vite` (Vite on 19140), `--no-relay`, `--team <name>`, `--rebuild-web`, `--no-web-build`.
- `TEAM_AX_DEV_DIR` moves the data folder. Keep it short and **not under /tmp**. The engine sandbox denies `/tmp`,
  and `<data>/data/run/tools.sock` must fit in a Unix socket path (104 bytes). Otherwise every chat ends with "The
  AI engine stopped unexpectedly" and the log shows `bind: invalid argument` / `gate did not start: exit 1`.

### 1.4 Create the team

**Your own team.** Open the `http://127.0.0.1:19100/setup?token=…` link from the log. The setup token field is
hidden when the token is in the URL. "Create your team" asks for:
- Team name.
- **Team language**: English (default), 한국어 or Bahasa Indonesia. Picking one also switches the screen.
- The owner's name, username (letters, digits and `. _ @ -`, 2–64 characters) and password (at least 10
  characters).

Click **Create team and start**. `127.0.0.1` and `localhost` are separate cookie origins, so stay on the one you
used.

**Or the demo team.** In a second terminal, run:

```sh
bun run demo:seed      # --base http://localhost:19100 --data ~/.team-ax-dev/data
```

This creates the Korean "데모 팀" with the accounts `dion`, `admin1`, `alice` and `bob`. The password for all of
them is `teamax-demo-1`. Running it again only fills in what is missing. It stops if the team was already set up
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

## 2. Production install (role-account mode): rehearsal only for now

This mode runs the server as `_axserver` and the engines as `_axagent`, inside `sandbox-exec` and a pf anchor.
LaunchDaemons start it at boot, without anyone logging in. First do 1.1 and 1.2 (tools and clone).

### 2.1 Prepare

```sh
bun run dev:service uninstall      # if you installed the dev service
```

Give Terminal **Full Disk Access** (System Settings → Privacy & Security). Without it, the cron/at deny entries and
Time Machine exclusions only produce warnings.

### 2.2 Build the bundle

```sh
bun run build:bundle      # = bun run build && bun scripts/build-bundle.ts [--version X] [--out DIR] [--arch amd64]
```

This writes `dist/release/` with `VERSION`, `0.1.0.tar.zst` (~22 MB), `app/0.1.0/` and `root/`. It takes about 40
seconds. There is no `manifest.sig` because no release key exists yet, so the installer needs `--allow-unsigned`.

### 2.3 Run the installer (from the repo root)

```sh
sudo scripts/install-macos.sh --from dist/release --allow-unsigned \
     --engine claude="$(readlink -f ~/.local/bin/claude)" \
     --engine codex="$(readlink -f ~/.local/bin/codex)"
```

Expected output: `install: installed mycel 0.1.0 (server _axserver, engine _axagent)`. The installer waits up to
60 s for `/api/health`. Check it with `curl -s http://127.0.0.1:47820/api/health`. If the server never answers,
read `/Library/Logs/mycel/crash/server.log`.

- **Put `--engine claude=` first.** The first engine becomes the server's `claudeBin`, and the names are not
  checked.
- `--from dist/release` is relative, so run the command from the repo root.

| Flag | Default | Meaning |
|---|---|---|
| `--id` | `mycel` | folder and label name |
| `--server-user` / `--agent-user` | `_axserver` / `_axagent` | role accounts |
| `--port` | 47820 | HTTP on 127.0.0.1 |
| `--tls-port` | 8443 | office network (self-signed); 0 = off |
| `--proxy-port` | 47821 | local model proxy, the only address the engine account may reach |
| `--engine NAME=FILE` | | repeatable; `codex=FILE` is the Codex CLI (`engine.codexBin`, file must be named `codex`) |
| `--codex-models FILE` | `~$SUDO_USER/.codex/models_cache.json` | Codex model list, locked into `app/engines/codex/<sha>/model_catalog.json` |
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
  - `root/` (bootstrap, launcher, `engine.sb`, `pf-load`).
- **pf anchor** `com.apple/250.mycel`.
- **Self-signed TLS certificate** (ECDSA P-256, 10 years). It covers `<LocalHostName>.local`, `127.0.0.1` and the
  `en0` IP only.
- **LaunchDaemons** `app.treesoop.mycel.{server,launcher,pf}`.
- **Logs** in `/Library/Logs/mycel/`.
- `_axagent` is added to `cron.deny` and `at.deny`.
- **Power:** `pmset -a sleep 0 autorestart 1 womp 1`.

Running the installer again repairs the install. It keeps a valid existing certificate, so after the LAN IP changes,
delete `secrets/lan-tls.*` before re-running it.

### 2.4 Claude long-lived token (owner, once a year)

```sh
claude setup-token        # approve in the browser with the Claude subscription (Pro/Max); prints sk-ant-oat01-… once; copy it
pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"
pbcopy < /dev/null        # empty the clipboard
```

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
sudo -u _axserver env MYCEL_MODE=prod HOME="$B/data" "$B/app/current/bin/bun" "$B/app/current/server/src/admin.js" codex-login
```

It prints a link (`https://auth.openai.com/codex/device`) and a one-time code. Open the link in any browser, sign in,
enter the code (it expires after 15 minutes). The command waits and ends with "Codex is signed in for the engine
account."

- The server must be running: the login goes through its model proxy. `_axagent` can reach nothing else (pf).
- The launcher runs `codex login --device-auth` as `_axagent`, under the engine sandbox. The login is stored in
  `agent/codex-auth/auth.json` (`_axagent` 600). The server account cannot read it.
- `codex-status` shows whether it is signed in (no token is printed); `codex-logout` removes the login.
- For each Codex turn the launcher copies the login into the chat folder. If Codex refreshes the token, the launcher
  writes it back, but only a plain file for the same ChatGPT account. One Codex turn runs at a time.
- **Codex is beta in production.** Only the owner can use it, plus anyone whose user id is in the setting
  `codexUsers` (a list of user ids; there is no screen for it yet). It cannot be the team default.
  - Verified so far: the login and the HTTPS path go through the proxy with the sandbox on.
  - Not yet verified with a real login: Codex WebSockets, token refresh and web search with pf on.

### 2.6 First-run setup

```sh
sudo cat "/Library/Application Support/mycel/setup/code"     # _axserver:admin 640
```

Open `http://127.0.0.1:47820/setup?token=<code>` on the server Mac. The setup flow also works over the office TLS
port, `https://<host>.local:8443/setup?token=…`. The screen is the same as in 1.4. After setup the server deletes
`data/setup-token`; `setup/code` stays, which is harmless.

### 2.7 What you see right after install

| Where | What it shows |
|---|---|
| Admin → AI engines | Claude Code: "Engine account sign-in"; not signed in until the token is stored (2.4). Codex (beta): "The engine account has no Codex sign-in yet" until 2.5, then "Connected". |
| Admin → System → Diagnostics | Claude Code: "Signed in (setup-token)" once the token is stored, or why not (missing, expired, refused). Model proxy: listening on 127.0.0.1:47821. Codex: a warning until 2.5 (the launcher reports the engine account's login), then "Signed in". pf, sandbox, launcher, cron.deny and Time Machine: real checks. Release signature: a warning (unsigned). |
| A chat | Without the token: "The team's Claude subscription is not connected yet." With it: Claude answers. |

**Known crash.** If the launcher socket is missing (the launcher daemon is down), opening Diagnostics kills the
production server with `connect ENOENT …/launcher.sock` (`server/src/system/ops.ts`). If Diagnostics stops
responding, check `/Library/Logs/mycel/crash/{server,launcher}.log`.

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
`setup/code`.

With FileVault on, the Mac waits at the unlock screen after a power cut (not tested).

## 3. Connecting members

| Install | Address | Who can reach it |
|---|---|---|
| Dev mode | `http://localhost:19100`, `http://demo.localhost:19161` | The server Mac only |
| Production, office network | `https://<LocalHostName>.local:8443` or `https://<LAN-IP>:8443` | Browsers and phones on the same network. The certificate is self-signed, so each person clicks through the warning once. Chats don't work yet (Part 2). |
| Team AX relay | `https://<team>.treesoop.com` | Not available: `wss://relay.treesoop.com/connect` is not running. The mode can be selected in Admin → System but never connects. |
| Your own relay | your domain | Advanced and not tested end to end; see below. The "Cloudflare tunnel" and "Tailscale" modes are rejected with "not available in this version". |

Find the host name with `scutil --get LocalHostName`. If the macOS application firewall blocks the server, allow the
bun the bootstrap actually runs:

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "/Library/Application Support/mycel/app/versions/0.1.0/bin/bun"
```

Run it again after each update. Not tested; the bundled bun is signed by Oven, so the default "allow signed
software" setting may already cover it.

**Invite links.**
1. Go to Admin → **Members & invites** → **Invite link**.
2. Pick the role, the groups and how long the link lasts (1–30 days, default 7).
3. Click **Create link**, then **Copy link** (or **QR code**). Each link works once.
4. The member opens it ("Join {team}"), picks a username, name and password, and clicks **Create account and
   join**.

**The link uses the address you are on.** Create invites while signed in at the address members will use, not at
`127.0.0.1:47820`.

Alternatives:
- **Add directly**: set a temporary password, which the member must change at first sign-in.
- **Reset password**: sends a reset link.

**Mac app.**
1. Build it:
   ```sh
   cd desktop && bun run dist:mac
   ```
   This writes `desktop/release/Team-AX-0.1.0-mac-arm64.dmg` (~128 MB, unsigned, arm64 only).
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

So today the app works only on the server Mac in dev mode. It cannot use the self-signed office address, because the
server has no `/api/connect-info` for certificate pinning. There is no auto-update.

**Windows.** Build the installer with:

```sh
cd desktop && bun run dist:win
```

This writes `desktop/release/Team-AX-Setup-0.1.0-win-x64.exe`; it builds on a Mac. It is unsigned, so SmartScreen
warns: click **More info → Run anyway**. The same address rules apply.

**Offer the apps in the product.** Put the installers and an `index.json` in `<data>/downloads/`. Members then see
them under **Settings → Apps → Desktop app**. `index.json` looks like this:

```json
{"items":[{"platform":"mac","file":"Team-AX-0.1.0-mac-arm64.dmg","version":"0.1.0","size":123,"signed":false}]}
```

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
3. **There is no team-name field.** Set `relay.teamName` in `config/server.json` by hand (as root), then run:
   ```sh
   sudo launchctl kickstart -k system/app.treesoop.mycel.server
   ```
4. The recovery code is written once to `data/relay/recovery-code.txt`. Print it, then delete the file.
5. To free a name later, run `node relay/src/main.ts release <team> --domain <d> --data <dir>`. The name stays held
   for a year.

## 4. Update, backup, uninstall

**Update (dev):**

```sh
git pull && bun install && bun run build && bun run dev:service restart
```

**Update (production).** The in-app update needs a release feed (`update.feedUrl` is null). Use one of these
instead:
- **Same version string:** run `bun run build:bundle`, then the same installer command. It replaces
  `app/versions/0.1.0`.
- **New version:** re-running the installer does **not** switch `app/current`. Stage the update and switch to it as
  `_axserver`. The bundle must be readable by `_axserver`, and your home folder is not, so copy it to `/Users/Shared`
  first:

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
- Restoring a backup restores the database only and asks for your password.
- Export writes chats, memory and the team folder to the owner's `exports` folder.

These backups are on the same disk. For an off-machine copy:
- **Production:** make an encrypted archive. `--password-stdin` takes at least 8 characters; end the input with
  Ctrl-D.
  ```sh
  eval "$ADMIN archive --out /Users/Shared/teamax.tar.zst.age --password-stdin"
  ```
  The other `admin.js` commands are `backup [--scope db|full]`, `list-backups`, `restore-archive --in F --to NEWDIR`,
  `restore-team --backup ID --to NEWDIR` and `stage-restore --backup ID`.
- **Dev:** stop the service and copy `~/.team-ax-dev`.

Production has no account CLI (`reset-link`, `create-owner`), so a locked-out owner cannot be recovered there yet.

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
| "The AI engine stopped unexpectedly" (dev) + `bind: invalid argument` / `gate did not start: exit 1` | The data folder path is too long or under /tmp; use the default `~/.team-ax-dev`. Diagnostics still show the engines as OK |
| "The AI engine is not available right now…" | Dev: no `native/bin/<platform>`; install Go and run `bun run build:native` (Intel: `ARCHS=amd64`). Production: expected today |
| "Company API key mode cannot be turned on…" | Production: expected today |
| Engine "not logged in" (dev) | Run `claude` or `codex login` as the same macOS user, then refresh in Admin → AI engines |
| "relay skipped: it needs Node 25+" | Install Node 25+; the direct address still works |
| Port in use | `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Dev: 19100, 19161, 19140. Production: 47820, 8443, 47821 |
| Production server stops when Diagnostics opens | Known crash when the launcher socket is missing (2.7) |
| Relay "Not registered" | `relay.teamName` missing in `server.json`, or the name is taken or reserved |
| Owner password forgotten | Dev: `bun run dev admin reset-link`. Production: no tool yet |
| Claude token expiry (1 year) | Repeat 2.4; diagnostics warn 14 days before (counted from when the token was stored) |
| "The team's Claude subscription is not connected yet" | Production: store the token (2.4) |
| "The AI connection has a problem" + admin notice "token was refused" | Production: the token was revoked or expired; make a new one and store it (2.4) |
| Diagnostics "Model proxy port in use" | Another program holds 127.0.0.1:47821 (`lsof -nP -iTCP:47821 -sTCP:LISTEN`); the server retries every 10 s |
| `curl` against the API returns `{"error":{"code":"csrf"}}` | Send the header `x-mycel-csrf: 1` |

## Known gaps

1. **Production chats are not verified on a real install yet.** Subscription mode works as the current user with the
   real `claude` binary (against a fake model service) and is covered by `sudo bun tests/install/g-macos-install.ts`,
   which has not been run on this Mac. A real answer also needs the owner's `claude setup-token` token.
2. **Codex in production is beta.** It works through the model proxy: `engine.codexBin`, the locked catalog,
   `agent/codex-auth` and `admin.js codex-login` (2.5). Only the owner (plus `codexUsers`) can use it, and it cannot
   be the default. The open checks with a real ChatGPT login and pf on are WebSockets, token refresh and web search.
3. **Engine names are not checked.** `--engine` is not validated, and the first engine becomes `claudeBin`.
4. **Diagnostics can crash the production server** when `launcher.sock` is missing (`system/ops.ts`).
5. **No team-name field for your own relay.** Admin → System has none, so the server stays `team_name_missing`
   until `server.json` is edited. "Team AX relay" can be selected although that relay does not exist.
6. **The desktop app cannot use the office address.** It cannot connect to a self-signed office-only server, and
   `GET /api/connect-info` is not implemented.
7. **Re-installing a new version does not switch `app/current`.** The in-app update has no feed.
8. **No account CLI in production.** `auth/cli.ts` is not in the bundle.
9. **Dev data-folder paths are fragile.** A path that is too long or under /tmp only gives a generic engine error,
   and Diagnostics does not check socket path length.
10. **Small doc and code mismatches:**
    - The comment at `install-macos.sh:308` says the menubar app reads `setup/code`; it doesn't.
    - `uninstall-macos.sh --help` prints `set -uo pipefail`.
    - The dev Diagnostics sandbox text is out of date.
11. **The TLS certificate covers the `en0` IP only.**
12. **Intel Macs and the DMG are arm64-first.** `native/build.sh` builds arm64 by default, and the DMG is
    arm64 only.
13. **Dev ports are fixed (19100/19161)**, with no check for ports already in use.
14. **Owner-blocked items.** Apple and Windows signing, the production relay and CI billing are waiting on the
    owner; see [OWNER-TODO.md](OWNER-TODO.md). Run `bun run typecheck && bun run test` locally.
