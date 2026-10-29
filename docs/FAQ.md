# Frequently asked questions

[한국어](FAQ.ko.md) · [Support](../SUPPORT.md)

## Is Trina for developers?

It is a company AI workspace for teams. People use a browser; IT operates self-hosted servers. Shared files, reusable task instructions and per-person folder permissions are the difference from a separate personal chat. [Team guide](for-teams.md).

## What does it cost?

Self-hosted software is free; infrastructure, operations and AI usage are separate. Hosting in AWS Seoul, checked 2026-10-30: Starter $39/month up to 5 people, Team $69 up to 15, Business $129 up to 40, USD before tax and AI charges. [Current pricing/contact](https://ax.trina.app/#pricing). Hosting is contact-led; no hosted free trial is promised.

## Can we try it without an AI account?

Yes. [The local demo](QUICKSTART.md) starts with fictional files and AI disabled. It is not a production install or a test of model output.

## How do AI connections work?

Managed installations can use permitted Claude subscription/Anthropic API and ChatGPT/OpenAI API connections, subject to operator settings and provider terms. Eligible personal → person-assigned → group-assigned → whole-team is the selection order. Another person's private connection is not selected for you.

Fresh Trina teams allow shared subscriptions by default. Existing saved choices persist. Connection-level consent still applies, including to new connections when the setting was already on. This is a software capability, not permission under Anthropic's or OpenAI's plans or terms. Use only authorized accounts/plans; do not assume one personal subscription covers a company. Provider limits and charges remain separate.

Development and office local-login modes use the server OS user's CLI login; they do not use the managed selector in the same way. The one-command demo disables engines entirely. Office mode is Claude-only; choose Linux managed installation when you need its connection capabilities.

## Can administrators read everything?

App admins do not have a browser for everyone's private chats. Server/storage operators can read stored files and chats; hosted operators are included. Selected context goes to AI providers. Permissions do not retract earlier answers. [Security and permissions](security-and-permissions.md).

## Which files and clients work?

Text/Markdown and supported Office/PDF extraction and generation depend on installed converters. HWP/HWPX text extraction is available. Experimental visual previews are in this source but off by default, and their runtime is excluded from default release bundles. Debian 12 does not support visual previews (glibc 2.36; the pinned renderer needs 2.39). Original downloads and text extraction remain available. See [runtime limits and release gate](../resources/hwp/README.md). Complex layout fidelity is not guaranteed.

Desktop and phone browsers work; a Windows installer is published. Mac office ZIP is a server bundle, not a released desktop DMG. Native mobile source is not an app-store release. This source supports EN/KO/ID/JA/ES throughout the app; check published builds’ release notes for availability.

## Do updates and backups exist?

[Latest release](https://github.com/trina-app/trina-ax/releases/latest) is the version source of truth. The Trina update feed serves signed Linux and office updates at `https://updates.trina.app`. Review release notes and back up first. App rollback is not data rollback. [Backup/restore](BACKUP-RESTORE.md).

## Docker, offline use, and support?

No official production Docker image is promised. Linux installation requires systemd/cgroup v2. Self-hosting does not make cloud model inference offline. [Troubleshooting](TROUBLESHOOTING.md) · [Support and community](../SUPPORT.md).
