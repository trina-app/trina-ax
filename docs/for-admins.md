# IT handoff: deploy and operate Trina AX

[한국어](for-admins.ko.md)

Decide data sensitivity, server ownership, authorized provider connections, client needs, outbound network policy and who restores backups. Selected context leaves for the provider; hosted operators can access stored data. [Security boundaries](security-and-permissions.md).

| Mode | Guide | Operational boundary |
|---|---|---|
| Linux server / VM | [Install](INSTALL-LINUX.en.md) | systemd and cgroup v2, dedicated accounts and OS isolation. Plain Docker is not the production installer target |
| Office Mac | [Install](OFFICE.en.md) | Runs as signed-in user, stops on logout. Claude path, no Codex |
| Role-account Mac | [Detailed installation](INSTALL.md) | Separate accounts and LaunchDaemons; operator-maintained source bundle, not a released desktop DMG |
| Fictional local evaluation | [Quick try](QUICKSTART.md) | AI disabled, loopback only, not a production isolation test |

After owner creation: **permissions → AI connection → invite the team → first skill → first backup**. Managed connections prefer eligible personal credentials. Subscription sharing is on for fresh teams; existing choices and connection-level consent remain. Provider authorization is separate.

Pilot acceptance: demonstrate two users' different file access, review a skill result against its sources, inspect usage and perform an encrypted off-host backup/restore drill. [Starter examples](../examples/README.md) · [Backup and restore](BACKUP-RESTORE.md).

Before updating, read the [latest release](https://github.com/trina-app/trina-ax/releases/latest), including default changes, and back up. Linux and office Mac use the Trina feed. App rollback is not database/file rollback. [Configuration](CONFIGURATION.md) · [Troubleshooting](TROUBLESHOOTING.md).

Browser/mobile web and a Windows installer are available. The Mac server ZIP is not a desktop DMG. This source includes EN/KO/ID/JA/ES. HWP visual preview is experimental, off by default and unavailable on Debian 12; default bundles omit its runtime. Check release notes before installing published artifacts. [Support](../SUPPORT.md).
