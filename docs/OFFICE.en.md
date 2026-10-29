# One dedicated office Mac

[한국어](OFFICE.md) · [IT checklist](for-admins.md)

The Mac runs Trina AX; colleagues use a browser. Office mode runs as the **signed-in Mac user**, not the separate OS accounts of role-account Mac/Linux installation. It stops when that user logs out. Use a dedicated machine. Internet is required for cloud AI; local file browsing is not an offline AI promise. Office mode does not provide Codex.

## Requirements and download

macOS 13+, Apple Silicon or Intel; a dedicated signed-in account, FileVault, internet (wired preferred), and a permitted Claude connection. No measured Mac capacity guarantee is available. The published ZIP includes runtime tools; Git, Go and Bun installation are not required for recipients. Claude Code must be installed separately if using local login. Confirm the account's plan permits the intended use; do not treat a personal subscription as an automatic team entitlement.

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
