# Frequently asked questions

[한국어](FAQ.ko.md) · [Support](../SUPPORT.md)

## Is Trina for developers?

It is a company AI workspace for teams. People use a browser; IT operates self-hosted servers. Shared files, reusable task instructions and per-person folder permissions are the difference from a separate personal chat. [Team guide](for-teams.md).

## What does it cost?

Self-hosted software is free; infrastructure, operations and AI usage are separate. Free 14-day trial on Trina hosting (AWS Seoul), then a monthly plan; AI usage is billed separately by the account you connect. [Current prices](https://ax.trina.app/#pricing).

## Can we try it without an AI account?

Yes. [The local demo](QUICKSTART.md) starts with fictional files and AI disabled. It is not a production install or a test of model output.

## How do AI connections work?

Managed installations can use permitted Claude subscription/Anthropic API and ChatGPT/OpenAI API connections, subject to operator settings and provider terms. Eligible personal → person-assigned → group-assigned → whole-team is the selection order. Another person's private connection is not selected for you.

On fresh Trina teams, one company connection can serve the whole team by default, and people can also connect their own. Existing saved choices persist. Connection-level consent still applies, including to new connections when the setting was already on. This is a software capability, not permission under Anthropic's or OpenAI's plans or terms. Use only authorized accounts/plans; do not assume one personal subscription covers a company. Provider limits and charges remain separate.

Development and office local-login modes use the server OS user's CLI login; they do not use the managed selector in the same way. The one-command demo disables engines entirely. Office mode is Claude-only; choose Linux managed installation when you need its connection capabilities.

## Can administrators read everything?

Your chats with Trina are visible only to you. A room is visible to its members; admins can't open rooms they aren't in. App admins do not have a browser for everyone's private chats. Server/storage operators can read stored files and chats; hosted operators are included. Selected context goes to AI providers. Permissions do not retract earlier answers. [Security and permissions](security-and-permissions.md).

## Which files and clients work?

Text/Markdown and supported Office/PDF extraction and generation depend on installed converters. HWP/HWPX text extraction, search and original downloads are available to every team. With the optional HWP Preview plugin installed and turned on (Admin > Plugins), the AI can also make new .hwpx documents (headings as outline levels, paragraphs, bold, italic, lists, simple tables, page breaks; a team template from skills/) and fill in an existing .hwp or .hwpx (edit_hwp: placeholders, exact text, empty table cells, table rows copied from a row), changing only those parts and saving a new version or a new file in the same format. Without the plugin the AI is not offered either. Writing does not use the preview renderer, so it works while the plugin is on even where previews cannot run. It cannot make a new .hwp, and it adds no new styles, pictures or tables. Distribution-only, password-protected or signed documents, and documents with macros (scripts) or OLE objects, are not changed. Visual previews come with the same plugin (installed from the official list); its runtime is not in default release bundles. The plugin cannot be installed on Debian 12 (glibc 2.36; the pinned renderer needs 2.39), so Debian 12 has neither visual previews nor Hangul writing and filling. Original downloads and text extraction remain available. See [runtime limits](../resources/hwp/README.md). Complex layout fidelity is not guaranteed.

Desktop and phone browsers work; a Windows installer is published. Mac office ZIP is a server bundle, not a released desktop DMG. The iPhone app is on the [App Store](https://apps.apple.com/app/id6829192435); it opens your team's server, so it has what that server's version has. The Android app is in review. This source supports EN/KO/ID/JA/ES throughout the app; check published builds’ release notes for availability.

## How do we get large media into a project?

Upload it in the web app. Open the project folder in Files, then use "Upload folder" or drop the folder on the page. Subfolders stay. Three files go up at a time, up to 20 GB per file. A large file goes on from the chunks that the server has after a dropped connection. No SSH is necessary. Open the app in a computer browser for this: phones cannot pick a folder.

Keep the page open until the row shows that the upload is done. If a file fails, the others go on, and "Try again" sends the failed ones. If the storage or the server disk has no room, the upload stops and says so. Free space, then use "Try again". A web page cannot tell a link from a file, so the picker can send the content of a linked file. Remove links first if that is a problem. Files with the same name get a new name, so a second upload of the same folder makes copies.

Connected folders and Google Drive do not fill a project folder. A connected folder is a read-only copy of a server folder at `connected/<name>`, with a limit of 100 MB per file. Google Drive gives the AI read access to a person's Drive. It does not put files in a project folder.

## Do updates and backups exist?

[Latest release](https://github.com/trina-app/trina-ax/releases/latest) is the version source of truth. The Trina update feed serves signed Linux and office updates at `https://updates.trina.app`. Review release notes and back up first. App rollback is not data rollback. [Backup/restore](BACKUP-RESTORE.md).

## Docker, offline use, and support?

No official production Docker image is promised. Linux installation requires systemd/cgroup v2. Self-hosting does not make cloud model inference offline. [Troubleshooting](TROUBLESHOOTING.md) · [Support and community](../SUPPORT.md).
