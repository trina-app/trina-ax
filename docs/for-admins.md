# IT handoff: deploy and operate Trina AX

[한국어](for-admins.ko.md)

Decide data sensitivity, server ownership, authorized provider connections, client needs, outbound network policy and who restores backups. Selected context leaves for the provider; hosted operators can access stored data. [Security boundaries](security-and-permissions.md).

Two more outbound flows to allow for: the server asks `https://updates.trina.app/ip` for its own public address at start and every 30 minutes (`MYCEL_EXIT_ADDRESS_CHECK=off` opts out; then every web address the AI opens asks a person and scheduled tasks open none; Admin > System > Diagnostics shows whether the server knows its address), and each Codex web search sends the conversation so far to OpenAI's search service.

When the AI reads a photo, screenshot or scanned PDF page, it sees the image, and the image goes to the provider like any other file content. Admins can turn this off in Team settings ("Send images and PDF pages to the AI", on by default); the switch also covers HWP page images and the in-app browser's screenshots. Linux servers run no OCR: scanned documents and photos are not text-searchable there.

| Mode | Guide | Operational boundary |
|---|---|---|
| Linux server / VM | [Install](INSTALL-LINUX.en.md) | systemd and cgroup v2, dedicated accounts and OS isolation. Plain Docker is not the production installer target |
| Office Mac | [Install](OFFICE.en.md) | Runs as signed-in user, stops on logout. Claude path, no Codex |
| Role-account Mac | [Detailed installation](INSTALL.md) | Separate accounts and LaunchDaemons; operator-maintained source bundle, not a released desktop DMG |
| Fictional local evaluation | [Quick try](QUICKSTART.md) | AI disabled, loopback only, not a production isolation test |

After owner creation: **permissions → AI connection → invite the team → first skill → first backup**. Managed connections prefer eligible personal credentials. Subscription sharing is on for fresh teams; existing choices and connection-level consent remain. Provider authorization is separate.

Pilot acceptance: demonstrate two users' different file access, review a skill result against its sources, inspect usage and perform an encrypted off-host backup/restore drill. [Starter examples](../examples/README.md) · [Backup and restore](BACKUP-RESTORE.md).

Before updating, read the [latest release](https://github.com/trina-app/trina-ax/releases/latest), including default changes, and back up. Linux and office Mac use the Trina feed. App rollback is not database/file rollback. [Configuration](CONFIGURATION.md) · [Troubleshooting](TROUBLESHOOTING.md).

Browser/mobile web and a Windows installer are available. The Mac server ZIP is not a desktop DMG. This source includes EN/KO/ID/JA/ES. HWP visual preview is the optional HWP Preview plugin (Admin > Plugins); it is unavailable on Debian 12 and default bundles omit its runtime. Check release notes before installing published artifacts. [Support](../SUPPORT.md).

Plugins (HWP Preview and others), their permission prompt and how official packages are verified: [Plugins (Korean)](PLUGINS.md).
