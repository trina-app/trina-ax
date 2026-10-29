# Troubleshooting by symptom

[Support](../SUPPORT.md) · [FAQ](FAQ.md) · [한국어 FAQ](FAQ.ko.md)

Use fictional data when reporting a problem. Never paste credentials, setup/invite links, databases or unredacted logs.

| Symptom | Check | Next action |
|---|---|---|
| Files open, AI does not answer | Admin → AI engines: executable missing, login missing, unsupported version, or network/sandbox error? | These are distinct failures. Fix the reported prerequisite; do not disable isolation. `bun run demo` intentionally disables AI |
| Managed AI connection unavailable | Owner → Admin → AI connections; permitted kind, enabled state, assignment and consent | Reconnect privately over HTTPS. A new team allowing subscription sharing does not authorize provider use |
| Development AI unavailable | Local supported CLI installed and logged in as the server OS user? | Use a separate dev environment; managed-connection setup is not the local-login flow |
| Linux says systemd is required | Is PID 1 systemd? Does cgroup v2 exist? | Use a supported VM/host. A plain Docker container does not satisfy this installer |
| Address already in use | The demo or installer prints the occupied port | Stop only your own identified process or choose a free port. Never kill all Bun/Node processes |
| Existing demo directory refused | `--data` points to an existing folder | Pick a new directory. Do not erase a real team or seed over it |
| Socket path too long / sandbox denies temp | Data-directory diagnostics | Use a short dedicated home-folder path; avoid macOS `/tmp` for model sandbox work |
| Sign-in loops or origin rejected | Browser hostname, scheme and port vs configured origins | Use one address consistently. `localhost` and `127.0.0.1` have different cookie origins |
| Public office address returns 502 | `teamax public-address status`, app port and tunnel target | Point the connector at the same loopback app port |
| Office server stops on logout | LaunchAgent runs in logged-in session | Keep the dedicated user logged in; role-account Mac/Linux differ |
| File preview unavailable | File type, converter availability, permissions | Try a permitted Markdown file first. HWP text extraction does not imply shipped visual preview |
| A skill is missing | Team skills loader warning, `SKILL.md`, folder/name match, source permissions | Use [valid examples](../examples/README.md); the parser rejects malformed manifests |
| Update rollback happened | Current version, diagnostics, signed feed and startup logs | Preserve the failed-update evidence; read release notes. App rollback does not restore data |

## Safe local status checks

Linux: `sudo mycel-ctl status`, `systemctl status mycel-server mycel-launcher`, then locally inspect `journalctl -u mycel-server -n 100`. Office Mac: `~/TeamAX/teamax status`, `~/TeamAX/teamax update status`, `~/TeamAX/teamax logs`. Expected: running services, intended version and reachable configured address; the exact output varies by release. Do not paste raw output into public issues.

Local demo: use the URL and supervisor PID printed by `bun run demo`; Ctrl-C stops that run. For a production restore problem, preserve current data and use the [recovery guide](BACKUP-RESTORE.md).
