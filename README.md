<div align="center">

<img src="web/public/favicon.svg" width="72" alt="Trina AX logo">

# Trina AX

**The AI your whole team shares.**

Your team's files, skills and tools on one server. Everyone's AI starts from them.

[Website](https://ax.trina.app) · [Download](https://ax.trina.app/download) · [Docs](docs/README.md) · [Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax)

<a href="https://apps.apple.com/app/trina-ax/id6829192435"><img src="docs/images/readme/v3/badge-app-store.svg" height="40" alt="Download on the App Store"></a>&nbsp;<a href="https://play.google.com/store/apps/details?id=app.trina.ax"><img src="docs/images/readme/v3/badge-google-play.png" height="58" alt="Get it on Google Play" align="top"></a>

English · [한국어](README.ko.md) · [日本語](README.ja.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md)

</div>

<br>

<a href="https://ax.trina.app/#watch"><img src="docs/images/readme/v3/film.png" width="100%" alt="Watch the 97-second story: Alex, a team lead, gets a 7-page proposal from one line; Mina, on her first day, asks the same and her AI answers 'Trina Logistics? Who are they?'"></a>

<p align="center"><sub>A new hire's AI starts in an empty folder. Trina gives it the team's.</sub></p>

## How it works

<img src="docs/images/readme/v3/how.png" width="100%" alt="1 Add your files and skills: a Files window with who can open each folder and the Customer quote skill's four steps. 2 Connect your tools: Higgsfield, Notion, Linear, GitHub and your company API go through your Trina server, checked per person; a deck made with Higgsfield photos. 3 Invite your team: Mina, Alex and Sam ask from their own devices, all to one Trina server with their own access.">

## What your team gets

<img src="docs/images/readme/v3/room.png" width="100%" alt="Ask beside any room, send in one click: in the Expo booth crew room, Mina asks Trina in a side chat only she sees, then sends the answer into the room.">

<p>
<img src="docs/images/readme/v3/access.png" width="49%" alt="Each person sees only what they may open: folders with the faces of who can open them; Mina can't open shared/Finance.">
<img src="docs/images/readme/v3/handoff.png" width="49%" alt="Pick up a teammate's AI chat: Sam continues Mina's project chat, with his own access.">
</p>

<p>
<img src="docs/images/readme/v3/skills.png" width="32%" alt="Write down how your team works: the team lead's Customer quote skill, used by Mina, Sam and Jordan.">
<img src="docs/images/readme/v3/tools.png" width="32%" alt="Connect the tools you use: any MCP server, Google Drive, Slack, your company API.">
<img src="docs/images/readme/v3/versions.png" width="32%" alt="Every change is kept: Price sheet.xlsx versions by Alex, Mina and Sam, including one saved during an AI answer, with Restore.">
</p>

<img src="docs/images/readme/v3/access-answers.png" width="100%" alt="Alex and Mina ask 'What was our revenue last quarter?'. Alex can open Finance and gets $498,000; Mina can't, so her AI says it couldn't find revenue figures in the files she can open.">

Every file the AI opens is checked as the person who asked. [How permissions work](docs/PERMISSIONS.md)

## Get started

- **Trina hosting:** no server to run. 14-day free trial, then a monthly plan. [Plans](https://ax.trina.app/#pricing)
- **Apps:** Mac, iPhone, Android and Windows, or any browser. [Download](https://ax.trina.app/download)
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
