# One dedicated office Mac

[한국어](OFFICE.md) · [IT checklist](for-admins.md)

The Mac runs Trina AX; colleagues use a browser. Office mode runs as the **signed-in Mac user**, not the separate OS accounts of role-account Mac/Linux installation. It stops when that user logs out. Use a dedicated machine. Internet is required for cloud AI; local file browsing is not an offline AI promise. Office mode does not provide Codex.

## Requirements and download

macOS 13+, Apple Silicon or Intel; a dedicated signed-in account, FileVault, internet (wired preferred), and a permitted Claude connection. No measured Mac capacity guarantee is available. The published ZIP includes runtime tools; Git, Go and Bun installation are not required for recipients. Install Claude Code separately before running the installer; the ZIP does not include it. Follow [the official installation guide](https://code.claude.com/docs/en/setup), using the tested `claude-code` version in the downloaded ZIP’s `app/versions.json`. For the default local-login path, run `claude` as the dedicated Mac user, sign in with an authorized account, and confirm `claude auth status` reports a signed-in account. Alternatively, the installer accepts `--claude-token-file /path/to/token-file` containing a permitted `claude setup-token` output; protect this secret file. Confirm the account's plan permits the intended use; do not treat a personal subscription as an automatic team entitlement.

Download `TrinaAX-office-<version>-mac.zip` and its `SHA256SUMS` from the [latest release](https://github.com/trina-app/trina-ax/releases/latest). Use the exact downloaded filename, not the newest file in a wildcard. The ZIP contains `TrinaAX-office-<version>/office-install.sh` and `app/docs/OFFICE.md`. PDFs are optional build outputs and are **not guaranteed in the ZIP**. Read the bundled Markdown guide or the online guides.

```sh
# Select the exact ZIP downloaded from the latest release; replace VERSION.
OFFICE_ZIP="$HOME/Downloads/TrinaAX-office-VERSION-mac.zip"
shasum -a 256 "$OFFICE_ZIP"
# Compare with the matching SHA256SUMS from that release before unpacking.
ditto -x -k "$OFFICE_ZIP" "$HOME/Downloads"
OFFICE_DIR="${OFFICE_ZIP%-mac.zip}"
bash "$OFFICE_DIR/office-install.sh" --check-only
bash "$OFFICE_DIR/office-install.sh"
```

The checksum is an integrity check, not independent authentication. Review the release/source. `--check-only` checks requirements without installing. No sudo is needed; the default installation is `~/TeamAX`. Check the installer output for the local setup link; keep its token private. Initial setup is refused over the public internet.

## Address and first run

Without tunnel options, use the installer-provided local address to create the owner. LAN clients use `https://<Mac-IP>:8443` after verifying/installing the office CA; `~/TeamAX/teamax card` shows its fingerprint. Downloading a certificate is not enough: compare its fingerprint out of band before trusting it. Test one client first. A local HTTP helper on 8442 distributes the certificate; do not submit credentials there.

An optional HTTPS internet address requires a domain and a separately provisioned Cloudflare Tunnel. With the prepared hostname/token file, add `--public-host team.example.com --tunnel-token-file /path/to/token-file` to the installer. Provisioning is an operator task, not automatic hosting signup. Protect the file and remove the transfer copy after installation. Later use `~/TeamAX/teamax public-address status`; changing the app port also requires updating the tunnel target. Do not use cache rules that cache authenticated downloads.

After owner setup: **permissions → AI connection → invite the team → first skill → first backup**. Test two accounts' folder access, confirm the permitted Claude connection on this Mac, invite a small pilot, copy a [starter skill](../examples/README.md), and perform a [backup/restore drill](BACKUP-RESTORE.md). Local-login office mode uses this Mac's CLI connection; do not assume the managed Linux connection selector is active. Fresh team subscription-sharing settings are on, saved choices persist, and connection-level consent applies where managed connections are used. Software capability is not provider permission.

## Operate, upgrade and rollback

```sh
~/TeamAX/teamax status
~/TeamAX/teamax logs
~/TeamAX/teamax backup
~/TeamAX/teamax update status
~/TeamAX/teamax update now
```

Before updating, read release notes, create an encrypted off-host archive and verify it. Office updates use `https://updates.trina.app/office/stable.json` and run nightly while the user is logged in. The updater verifies its feed/bundle; do not bypass signature checks. `update pause` / `update resume` control it. For manual installation, verify a new ZIP and rerun its installer against the same home. Startup rollback restores the app, not database or team-file state. Use a compatible release and pre-update backup for data recovery.

## Backup, restore and uninstall

`~/TeamAX/teamax archive /Volumes/Backup/trina.tar.zst.age` prompts privately for an archive password. Keep that password separately. `~/TeamAX/teamax restore-archive /path/to/trina.tar.zst.age --replace` is a full replacement operation: make a current backup first and follow [BACKUP-RESTORE.md](BACKUP-RESTORE.md). Sessions end and connections may need reauthentication; verify CA/client trust and login/file access afterward.

Run `bash "$OFFICE_DIR/office-uninstall.sh"` from the extracted kit to remove the app/services while keeping data. `--delete-data` removes data too; only use it after checking an off-host recovery copy. Do not delete `~/TeamAX` as if it were a disposable demo.

## Troubleshooting and clients

- Port busy: the check prints the conflict. Choose installer port options and update tunnel targets consistently.
- Logout or sleep: keep the dedicated account logged in and review energy settings.
- 502 at public address: confirm the tunnel points to the configured loopback app port.
- CA warning: verify the fingerprint and correct hostname/IP; do not bypass browser warnings.
- Missing AI: distinguish missing Claude executable, missing login, version mismatch and provider/network failure. Do not paste credentials into logs or Issues.

Use desktop/mobile browsers or the published `Trina-AX-Setup-<version>-win-x64.exe`. A Mac desktop DMG is not published; the office ZIP is the server. [Troubleshooting](TROUBLESHOOTING.md) · [FAQ](FAQ.md) · [Configuration and legacy paths](CONFIGURATION.md).

## Detailed offline procedures

The following steps travel in the ZIP. The links above provide additional context; a repository checkout is not required on the office Mac. An operator preparing a public address needs the source on a separate administration machine, as described below. Keep that distinction when handing over a kit.

### Prepare the dedicated Mac and kit

Keep FileVault enabled. Use a dedicated signed-in macOS account, not a personal workstation. The server, tunnel and update LaunchAgents stop at logout; locking the screen is fine. After a restart or power failure someone must unlock FileVault and sign in.

If Claude Code is missing, the source's tested installation command is:

```sh
curl -fsSL https://claude.ai/install.sh | bash -s 2.1.305
```

Use the `claude-code` pin in the received kit's `app/versions.json` if it differs. Reopen Terminal, run `claude`, sign in using an account permitted for this use, and check `claude auth status`. The alternative setup-token path stores the real token for the server and gives the engine a temporary per-turn token; actual token lifetime is determined by the provider. Do not assume a personal subscription grants team-use rights.

For a prearranged public address, obtain its protected tunnel-token file from the operator. After the exact ZIP checksum and `--check-only` steps above, install with:

```sh
bash "$OFFICE_DIR/office-install.sh" \
  --public-host team.example.com \
  --tunnel-token-file "$HOME/Downloads/team.example.com.tunnel-token"
```

For the authorized subscription-token alternative, add `--claude-token-file "$HOME/Downloads/claude-token.txt"`. The operator creates that file privately with `claude setup-token`; never put the token in command arguments or a support ticket. The installer copies secrets into restricted files under `~/TeamAX/config`. Remove only the transfer copies after successful installation. Without a prepared tunnel, omit both public-address options and use the LAN path.

Expected output includes `installed`, the local first-setup link, public/LAN addresses and certificate fingerprint. Use `~/TeamAX/teamax status` to check the service. If changing `--app-port`, the operator must also point the tunnel to that port; the default office application port is 47830. Other installer options include `--lan-port`, `--helper-port` and `--proxy-port` for conflicts. Do not stop an unrelated process to free a port.

If appropriate for this dedicated machine, prevent sleep and allow restart after power failure:

```sh
sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1
pmset -g
```

This optional energy-setting command needs the Mac administrator password; the office installer itself does not use sudo. Allow the installed Bun server through the macOS application firewall. Reserve the Mac's LAN IP in the router if desks will use it. Print `~/TeamAX/teamax card` from the Mac and distribute the address and complete certificate fingerprint through a trusted channel.

### Owner setup and the five-step first week

Run `~/TeamAX/teamax setup-link` on the office Mac if the setup page did not open. Keep the one-time link private. Create the team name, language and owner account. The public internet endpoint refuses first-owner setup. Confirm the intended timezone and language; the source supports English, Korean, Indonesian, Japanese and Spanish.

1. **Permissions:** create groups and folder rules in administration. Test with two fictional member accounts; each should see only its allowed folders. Keep real sensitive data out of the pilot.
2. **AI connection:** confirm the authorized Claude connection and ask about a fictional file. Office local-login uses the signed-in Mac user's CLI, not the managed Linux connection selector. Fresh subscription sharing is ON, saved choices persist, and managed connections require their own acknowledgment. Provider permission remains a separate requirement.
3. **Invite:** Admin → Members → Invite link, choose role/group and expiry, then privately send a separate link per member. No invitation email is sent by the app. Create invites for the address members will use. Direct account creation instead gives a temporary password, which must be changed at first login and expires after seven days. Use member reset links for forgotten passwords; the owner can run `~/TeamAX/teamax reset-link` on the Mac.
4. **First skill:** as owner, create `skills/meeting-summary/SKILL.md` in Files using the following content. Review any team-skill confirmation, save, and select it from `/` in a new chat. Use fictional input and verify the output against its cited source.
5. **First backup:** run the backup and archive procedures below, then practice recovery before relying on the machine.

```md
---
name: meeting-summary
description: Summarize decisions and actions from an accessible meeting note.
---
Read only meeting notes the requesting user can access.
List decisions, action owners and due dates. Mark missing information for review.
Cite the source file. Save a draft in the requesting user's own folder.
Ask for human review before wider sharing; do not invent commitments.
```

A skill is reusable task instructions. Changing folder access does not erase content already included in past answers. An app administrator and an operating-system/storage administrator are different roles: the latter can access stored data. AI prompts, history and relevant file/tool context go to the configured model provider; LAN access is not offline inference.

### Windows desks and LAN certificate trust

For a public HTTPS address, open `https://team.example.com` in Edge, verify the expected address without certificate warnings, open the invitation and create the account. Edge → ⋯ → Apps → Install this site as an app adds a separate window and shortcut. Home and mobile browsers use the same public address. Sign in again if the browser/app uses a different origin.

For LAN fallback, configure each Windows user's trust once:

1. Open the card's certificate helper address, such as `http://192.168.1.20:8442`, or receive `~/TeamAX/tls/ca.cer` by trusted USB transfer. This HTTP endpoint distributes a certificate only; do not enter credentials there.
2. Open the certificate, select Details → Thumbprint, and compare the **entire** fingerprint with the card printed on the Mac through a separate trusted channel. Stop if any part differs.
3. General → Install Certificate → Current User → Place all certificates in the following store → Trusted Root Certification Authorities. Finish and confirm only after the fingerprint check. Repeat for other Windows users; a machine-wide installation is an administrator task.
4. Close every Edge window, reopen the card's HTTPS LAN address (for example `https://192.168.1.20:8443`) and verify that the warning is gone. Install that address as an Edge app and sign in. It is a different app/login from the public address.

Test one physical desk before repeating across the office. A changed IP/hostname or replacement CA needs a new card and trust checks; do not blindly click through warnings. The LAN path can serve local files during an internet outage, but cloud AI still needs internet.

The optional published Windows desktop installer is `Trina-AX-Setup-<version>-win-x64.exe`. Verify its origin/checksum and the team's deployment policy before running it. An unsigned installer can trigger SmartScreen; if organizational policy blocks it, use the browser. The desktop client needs a publicly trusted HTTPS team address for remote access. A locally built Mac DMG is a separate, unpublished client, not the office server ZIP.

To offer verified installers in Settings → Apps:

```sh
~/TeamAX/teamax desktop add "$HOME/Downloads/Trina-AX-Setup-VERSION-win-x64.exe"
~/TeamAX/teamax desktop list
# To withdraw an installer, use its exact listed filename:
~/TeamAX/teamax desktop remove Trina-AX-Setup-VERSION-win-x64.exe
```

Replace VERSION first. With a custom kit, put its installers beside the ZIP before installation. A `desktop.sha256` manifest restricts automatic staging to the listed filenames and hashes. The office builder's custom kit can rename a Windows file to `Trina-AX-Setup-<version>-x64.exe`; use the actual manifest name for that kit. Published GitHub Windows releases retain `-win-x64.exe`. Downloads are authenticated; never apply Cloudflare “Cache Everything” or an overriding Edge Cache TTL rule to `/downloads/*`.

### Backups, recovery and rollback

Nightly local backups live in `~/TeamAX/data/backups/` and `~/TeamAX/team/.system/backups/`, normally retained for 14 days. They are on the same disk and cannot recover a lost Mac. Keep every part of a full/incremental chain. Use the application or CLI to take a consistent database snapshot; do not simply copy a running SQLite file.

```sh
~/TeamAX/teamax backup
~/TeamAX/teamax archive /Volumes/Backup/trina.tar.zst.age
```

The archive command privately prompts for a password of at least eight characters. Check that the result says it is encrypted, copy it to protected off-host storage, and compare SHA-256 on both copies. Store the password separately. Encrypted Time Machine backup of the complete `~/TeamAX` directory is an additional option; verify its coverage and recovery rather than assuming an archive contains every deployment setting.

Before replacing data, pause team use and make a current backup. On an installed compatible office server:

```sh
~/TeamAX/teamax restore-archive /Volumes/Backup/trina.tar.zst.age --replace
```

The wrapper stops the server, swaps in the recovered database/team, preserves the current data beside it as `*.before-restore-*`, and restarts. Omit `--replace` on a fresh installation; it refuses to overwrite an existing configured team without that option. Database replacement ends sessions and invalidates unused invite/reset links. Everyone signs in again and the owner issues new links.

An archive contains the database and team tree, not OS accounts, services, deployment configuration, CA keys or provider sealing keys. On a new Mac install a compatible verified kit first, reapply the tunnel/settings, reconnect providers and verify/trust the new CA on clients. Confirm database integrity, representative files and history, two users' access, skills and diagnostics; create a new backup afterward. Local extraction/file recovery has been checked, but a complete physical replacement-Mac or role-account migration remains an operator drill, not a verified one-command disaster recovery claim.

For file-only recovery without replacing the live team, use the installed administration CLI with the office configuration:

```sh
trina_admin() (
  cd / && env MYCEL_MODE=dev MYCEL_CONFIG="$HOME/TeamAX/config/server.json" \
    "$HOME/TeamAX/app/bin/bun" "$HOME/TeamAX/app/server/src/admin.js" "$@"
)
trina_admin list-backups
trina_admin restore-team --backup BACKUP_ID --to "$HOME/TeamAX/recovered-team-new"
```

Use a real backup ID and a new destination. Compare the recovered files, then upload only the required files with appropriate permissions. For an archive extraction drill, the same CLI accepts `restore-archive --in FILE --to NEW_FOLDER --password-stdin`; use a private input channel, never a password argument. Extraction alone does not stop the live server or terminate its sessions. Admin → System → Backups → Restore restores the database at the next server start and leaves current team files unchanged.

Before updates, inspect release/admin notes and verify the off-host archive. The signed office feed is `https://updates.trina.app/office/stable.json`; signature/hash checks must not be bypassed. The updater waits for active answers, takes a database backup, stages the new app and checks health. Startup failure can restore the previous **app**, but does not roll back the database or files. Use a compatible version and pre-update backup for data recovery.

```sh
~/TeamAX/teamax update status
~/TeamAX/teamax update check
~/TeamAX/teamax update now
~/TeamAX/teamax update pause
~/TeamAX/teamax update resume
~/TeamAX/teamax update channel stable
~/TeamAX/teamax update time 02:30
```

For a manual update, download the exact new ZIP, repeat checksum/preflight checks and rerun its installer against the same office home. Review `~/TeamAX/logs/update.log` if it fails. The update agent runs while the account is signed in. Do not assume every prior binary can read a newer database.

### Public address preparation and changes (operator)

These commands run on the separate operator Mac with Git, Bun and Cloudflare access. The office recipient only needs the prepared hostname/token file. Use an authorized domain; the examples are fictional.

```sh
git clone https://github.com/trina-app/trina-ax.git
cd trina-ax
bun install --frozen-lockfile
brew install cloudflared
cloudflared tunnel login
# Select example.com in the browser. Preserve any existing cert before login.
mv "$HOME/.cloudflared/cert.pem" "$HOME/.cloudflared/cert-example.pem"
bun scripts/office/public-address.ts set team.example.com \
  --cert "$HOME/.cloudflared/cert-example.pem"
```

The command creates the tunnel route to `http://127.0.0.1:47830` and writes a mode-600 connector token under `~/.config/teamax-office/`; it does not print the token. Transfer that file privately to the office Mac. If its app port differs, repeat `set` with `--port <actual-port>`. A protected `--api-token-file` with Zone DNS Edit and Account Cloudflare Tunnel Edit permissions is an alternative to the login certificate. Do not overwrite an existing certificate or unrelated DNS record.

For a new hostname, prepare its route/token on the operator Mac, then on the office Mac:

```sh
~/TeamAX/teamax public-address set new.example.com "$HOME/Downloads/new.example.com.tunnel-token"
~/TeamAX/teamax public-address status
~/TeamAX/teamax card
```

After success remove the transfer copy, print a new card, have desks install/open the new address and sign in, and issue new unused invitation/reset links. Files/chats remain on the same server. Remove the old hostname on the operator Mac:

```sh
bun scripts/office/public-address.ts remove team.example.com \
  --cert "$HOME/.cloudflared/cert-example.pem"
```

Removal can rotate a retained shared tunnel's secret; distribute any newly required token to its remaining connector. For suspected exposure use the operator command `rotate <hostname>` with the appropriate certificate and replace the office token. To disable public access, run `~/TeamAX/teamax public-address off` on the office Mac, then the removal command it prints on the operator Mac. The LAN path remains.

### Troubleshooting reference and removal

| Symptom | Local action |
|---|---|
| Cloudflare 530 / 1033 | Confirm the Mac is powered, signed in and online. Run `~/TeamAX/teamax public-address status` and `~/TeamAX/teamax logs`; inspect the tunnel status/token association. |
| Cloudflare 502 | Check the server with `teamax status`; ensure the operator's tunnel target matches the actual app port. Restart this office service with `~/TeamAX/teamax restart` if needed. |
| Public first-setup refused | Expected. Use `~/TeamAX/teamax setup-link` privately on the Mac. |
| LAN certificate warning | Verify the entire fingerprint, trusted-root store, exact card hostname/IP, and restart Edge. Do not bypass the warning. |
| 403 office network | Connect from the allowed office subnet; VPN/guest networks can be excluded. |
| 421 Misdirected request | Use an address listed by `~/TeamAX/teamax info`. |
| Missing/refused AI | Check Claude installation, its pinned version and `claude auth status`; inspect logs locally. For a revoked token replace it with `teamax configure --claude-token-file <protected-file>` and restart. |
| Owner password forgotten | Run `~/TeamAX/teamax reset-link`; send member reset links through Admin → Members. Keep all links private. |
| Router/subnet changed | Stop this service, preserve `~/TeamAX/tls` under a new backup name, then start. Print the new card and recheck trust on every affected client. |
| Update paused/failed | `teamax update status`, then `update resume` if paused; review `logs/update.log`, network and feed errors before retrying. |
| Port conflict | Rerun preflight with appropriate port options and match the tunnel target; leave unrelated processes running. |

Configuration is `~/TeamAX/config/office.env`; restart after editing. `config/server.json` is regenerated on startup. `TEAMAX_PUBLIC_COUNTRIES` and `TEAMAX_PUBLIC_ALLOW_FROM` can restrict public access; they are separate from subscription sharing. Keep the Mac dedicated and do not treat forwarded IP data as trustworthy against other software running on that Mac. Public access passes through Cloudflare, and AI context goes to Anthropic; sensitive data policy must account for both.

Uninstall using the received kit's `bash "$OFFICE_DIR/office-uninstall.sh"`. This removes the app/services and retains data. `--delete-data` also removes data; use it only after checking a separate recovery copy. Do not delete a real office home as if it were a disposable demo.

### Building a kit with printed guides (maintainer)

Build PDFs **before** packaging, so they are available for staging:

```sh
bun install --frozen-lockfile
bun docs/install/build-pdf.ts --office
bun docs/install/build-pdf.ts --windows
bun run build:office
```

The output is `dist/office/TrinaAX-office-<version>-mac.zip`. Its runbooks are `app/docs/OFFICE.md` and `app/docs/OFFICE.en.md`. PDF names are `Trina-AX-사무실모드-설치가이드.pdf` and `Trina-AX-윈도우-데스크-가이드.pdf`. PDFs are optional build outputs, so check the ZIP's contents; when absent, this runbook contains installation and troubleshooting steps.

For fictional customer copies without editing the neutral HTML:

```sh
bun docs/install/build-pdf.ts --office --team-host team.example.com --team-name 'Example Team' \
  --title 'Office installation' --out out/example-office.pdf
bun docs/install/build-pdf.ts --windows --team-host team.example.com --out out/example-desks.pdf
bun scripts/build-office.ts --guide out/example-office.pdf --desk-guide out/example-desks.pdf \
  --team-host team.example.com --out out
```

`--place`, `--boss`, `--sensitive`, `--set key=value`, `--version` and `--img-dir` customize marked words, versions and pictures. Keep real customer values and outputs outside the public repository. Native/web build prerequisites still apply. Desktop installers are separate files beside the ZIP, optionally selected by `--with-desktop` / `--desktop-prebuilt`; they are not required for browser desks.
