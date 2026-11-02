# Frequently asked questions

[한국어](FAQ.ko.md) · [Support](../SUPPORT.md)

## Is Trina for developers?

It is a company AI workspace for teams. People use a browser; IT operates self-hosted servers. Shared files, reusable task instructions and per-person folder permissions are the difference from a separate personal chat. [Team guide](for-teams.md).

## What does it cost?

Self-hosted software is free; infrastructure, operations and AI usage are separate. Hosting in AWS Seoul, checked 2026-11-02: a free plan for up to 3 people (limited spots), Starter $39/month up to 5 people, Team $69 up to 15, Business $129 up to 40, and a quote above 40; USD before tax and AI charges. [Current pricing](https://ax.trina.app/#pricing).

## Can we try it without an AI account?

Yes. [The local demo](QUICKSTART.md) starts with fictional files and AI disabled. It is not a production install or a test of model output.

## How do AI connections work?

Managed installations can use permitted Claude subscription/Anthropic API and ChatGPT/OpenAI API connections, subject to operator settings and provider terms. Eligible personal → person-assigned → group-assigned → whole-team is the selection order. Another person's private connection is not selected for you.

On fresh Trina teams, one company connection can serve the whole team by default, and people can also connect their own. Existing saved choices persist. Connection-level consent still applies, including to new connections when the setting was already on. This is a software capability, not permission under Anthropic's or OpenAI's plans or terms. Use only authorized accounts/plans; do not assume one personal subscription covers a company. Provider limits and charges remain separate.

Development and office local-login modes use the server OS user's CLI login; they do not use the managed selector in the same way. The one-command demo disables engines entirely. Office mode is Claude-only; choose Linux managed installation when you need its connection capabilities.

## Can administrators read everything?

App admins do not have a browser for everyone's private chats. Server/storage operators can read stored files and chats; hosted operators are included. Selected context goes to AI providers. Permissions do not retract earlier answers. [Security and permissions](security-and-permissions.md).

## Which files and clients work?

Text/Markdown and supported Office/PDF extraction and generation depend on installed converters. HWP/HWPX text extraction is available. Visual previews are the optional HWP Preview plugin (Admin > Plugins, installed from the official list); its runtime is not in default release bundles. Debian 12 does not support visual previews (glibc 2.36; the pinned renderer needs 2.39). Original downloads and text extraction remain available. See [runtime limits](../resources/hwp/README.md). Complex layout fidelity is not guaranteed.

Desktop and phone browsers work; a Windows installer is published. Mac office ZIP is a server bundle, not a released desktop DMG. Native mobile source is not an app-store release. This source supports EN/KO/ID/JA/ES throughout the app; check published builds’ release notes for availability.

## How do we get large media into a project?

Upload it in the web app. Open the project folder in Files, then use "Upload folder" or drop the folder on the page. Subfolders stay. Three files go up at a time, up to 20 GB per file. A large file goes on from the chunks that the server has after a dropped connection. No SSH is necessary. Open the app in a computer browser for this: phones cannot pick a folder.

Keep the page open until the row shows that the upload is done. If a file fails, the others go on, and "Try again" sends the failed ones. If the storage or the server disk has no room, the upload stops and says so. Free space, then use "Try again". A web page cannot tell a link from a file, so the picker can send the content of a linked file. Remove links first if that is a problem. Files with the same name get a new name, so a second upload of the same folder makes copies.

Connected folders and Google Drive do not fill a project folder. A connected folder is a read-only copy of a server folder at `connected/<name>`, with a limit of 100 MB per file. Google Drive gives the AI read access to a person's Drive. It does not put files in a project folder.

## Do updates and backups exist?

[Latest release](https://github.com/trina-app/trina-ax/releases/latest) is the version source of truth. The Trina update feed serves signed Linux and office updates at `https://updates.trina.app`. Review release notes and back up first. App rollback is not data rollback. [Backup/restore](BACKUP-RESTORE.md).

## Docker, offline use, and support?

No official production Docker image is promised. Linux installation requires systemd/cgroup v2. Self-hosting does not make cloud model inference offline. [Troubleshooting](TROUBLESHOOTING.md) · [Support and community](../SUPPORT.md).
