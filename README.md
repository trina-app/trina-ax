<div align="center">

<img src="web/public/favicon.svg" width="64" alt="Trina AX logo">

<h1>The AI your whole team shares.</h1>

Trina AX puts your team's files, skills and tools on one server. Everyone's AI starts from them,<br>and every file it opens is checked as the person who asked.

<a href="https://apps.apple.com/app/trina-ax/id6829192435"><img src="docs/images/readme/v3/badge-app-store.svg" height="40" alt="Download on the App Store"></a>&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=app.trina.ax"><img src="docs/images/readme/v3/badge-google-play.png" height="40" alt="Get it on Google Play"></a>

[Website](https://ax.trina.app) · [Download for Mac and Windows](https://ax.trina.app/download) · [Docs](docs/README.md) · [Discord](https://discord.gg/zUVfSR8MVk)

English · [한국어](README.ko.md) · [日本語](README.ja.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md)

<br>

<a href="https://ax.trina.app/#watch"><img src="docs/images/readme/v3/film.png" width="100%" alt="Watch the 97-second story. Same Claude, same request, different result: Alex, a team lead, gets a 7-page deck; Mina, on her first day with an empty folder, gets 'Trina Logistics? Who are they?'. With Trina, Mina's AI starts from the team's files and skills."></a>

</div>

## What your team gets

**Ask beside any room, send in one click.** A side chat only you see; one click sends Trina's answer into the room.

<img src="docs/images/readme/v3/room.gif" width="100%" alt="In the Expo booth crew room, Mina asks Trina in a side chat only she sees when move-in is on Nov 17, clicks Send to room, and the answer lands in the room.">

**Each person sees only what they may open.** Mina can't open Finance, so neither can her AI. [How permissions work](docs/PERMISSIONS.md)

<img src="docs/images/readme/v3/access-band.png" width="100%" alt="Folders with the faces of who can open them; Mina can't open shared/Finance.">

- 🤝 **Pick up a teammate's AI chat.** Continue their project chat; your turns run with your access.
- 📋 **Team skills.** Write down how your team works once; everyone's AI follows it.
- 🔌 **Your tools.** Any MCP server, Google Drive, Slack and your company API, checked per person.
- 🕘 **Every change is kept.** By a person or their AI; bring back any version.
- 📱 **Every device.** Mac, iPhone, Android, Windows and any browser.

## Get started

- **Trina hosting:** no server to run. 14-day free trial, then a monthly plan. [Pricing](https://ax.trina.app/pricing)
- **Apps:** [Mac, iPhone, Android and Windows](https://ax.trina.app/download), or any browser.
- **Self-host:** your own Linux server, Docker or an office Mac. Free. [Linux](docs/INSTALL-LINUX.en.md) · [Docker](docs/INSTALL-DOCKER.md) · [Office Mac](docs/OFFICE.en.md)

<details>
<summary><b>Try it on your computer in 10 minutes</b> (fictional team, AI off)</summary>

<br>

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile && bun run demo   # → http://127.0.0.1:19760 · alice / teamax-demo-1
```

Needs Bun 1.3.12 and Go 1.27+. Not a production install. [Walkthrough](docs/QUICKSTART.md)

</details>

Trina provides the workspace, not the AI: connect Claude or OpenAI accounts and plans authorized for your use. AI usage is billed by the account you connect.

<details>
<summary><b>Data, limits and what we don't promise</b></summary>

### What we don't promise

- Self-hosting is not offline: the context a request needs goes to the AI provider you connect, and configured integrations receive their requests. Each Codex web search sends the conversation so far to OpenAI's search service. With OpenRouter for speech, allowed by an admin, the sound of video and audio files goes to OpenRouter. The server asks `updates.trina.app` for its own public address every 30 minutes (`MYCEL_EXIT_ADDRESS_CHECK=off` turns that off). [Details](docs/security-and-permissions.md)
- Server operators can read stored files and chats, including Trina operators for hosting. App admins don't get a browser for everyone's private conversations.
- Removing folder access does not erase earlier answers. The wider-sharing check is not universal data-loss prevention.
- No security certification, perfect answers, guaranteed savings or automatic legal, financial or HR decisions. Review outputs and deployment boundaries.
- Linux servers run no OCR: the AI sees photos and scanned pages as images, but they are not text-searchable. Office Macs cannot read video yet.
- HWP/HWPX text works for every team; [previews and making Hangul documents](resources/hwp/README.md) need the optional HWP Preview plugin (macOS, or Linux with glibc 2.39+; not Debian 12).
- Connections: a person's own eligible connection comes first, then one assigned to the person, a group, then the whole team. On fresh Trina teams, one company connection can serve the whole team by default; existing saved choices persist. **This software setting does not grant permission under Anthropic's or OpenAI's terms.** [Connection details](docs/FAQ.md)
- Linux self-hosting needs Debian 12/13 or Ubuntu 24.04, systemd with cgroup v2, amd64 or arm64, 4 GB RAM and 20 GB disk. Your IT team installs, updates and restores backups.

</details>

## Community

[Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax) · [Releases](https://github.com/trina-app/trina-ax/releases/latest) · [Changes](CHANGELOG.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Development](docs/DEVELOPMENT.md) · [Configuration](docs/CONFIGURATION.md) · [llms.txt](llms.txt)

The app speaks English, Korean, Indonesian, Japanese and Spanish. Fictional company and people in every picture.

## License

Free to use, including commercially, under [AGPL-3.0-only](LICENSE). If you offer a modified version over a network, offer its source to those users. The cloud protocol is MIT ([license](shared/src/cloud-protocol/LICENSE)). [Notices](NOTICE) · [Third-party notices](docs/THIRD-PARTY-NOTICES.md)

Claude Code and Codex have their own terms; this project is not endorsed by Anthropic or OpenAI. Claude is a trademark of Anthropic.
