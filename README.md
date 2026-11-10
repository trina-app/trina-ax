<div align="center">

<img src="web/public/favicon.svg" width="72" alt="Trina AX logo">

# Trina AX

**The AI your whole team shares.**

Claude Code and Codex, working for your whole team. They know your company's files, follow the way your team works, and see only what each person may open. Write your quote process once, and everyone's AI makes quotes the same way, from your own price sheet.

[Website](https://ax.trina.app) · [Try it in 10 minutes](#try-it-in-10-minutes) · [Self-host](docs/for-admins.md) · [Docs](docs/README.md) · [Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax)

English · [한국어](README.ko.md) · [日本語](README.ja.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md)

</div>

## What your team gets

| | What changes for your team |
|---|---|
| **One way of working, for everyone** | Write down once how your team makes a quote. From then on everyone's AI makes it that way, from your own price sheet, even on someone's first day. |
| **Company files, each person's access** | The company's files sit in one place, and each person's AI sees only what that person may open. Sales never sees Finance's numbers. |
| **Team rooms** | Talk as a team in rooms, an Everyone room and direct messages, with files and photos. Threads and group chats are new in 0.5. |
| **A private AI beside every room** <sub>new in 0.5</sub> | Ask Trina next to the room: "catch me up", "summarize this", or about one message. Only you see it. A good answer goes to the room or its thread in one click, with a check first if some people there can't open what it used. |
| **Pick up a teammate's AI chat** <sub>new in 0.5</sub> | Mina starts a quote; Sam carries on in the same chat. Each message runs with the access and the AI account of the person who sent it. |
| **The tools you already use** | Google Drive, Slack, Notion, Linear, Higgsfield, any MCP server or your company's own API. Say "connect Higgsfield" in a chat and finish on one card. Before the AI writes or sends anything there, it asks you, unless you allow it. |
| **Work that runs by itself** | "Every Monday at 9:00, summarize last week's sales notes." It runs on time, with the access of the person who set it up. |
| **Nothing gets lost** | Bring back an earlier version of a file; deleted files wait in the team trash. |
| **Real business documents** | Reads PDF, Word, Excel, PowerPoint and Korean Hangul (HWP) files, and makes Word, Excel, PowerPoint and PDF files. With an optional plugin it also writes and fills in Hangul documents. |
| **On every device** | The browser on computer and phone, the [iPhone](https://apps.apple.com/app/id6829192435) and [Mac](https://apps.apple.com/app/trina-ax/id6829192435) apps on the App Store, a Windows app and an [Android app](https://github.com/trina-app/trina-ax/releases/tag/android-v1.0.2) (in review on Google Play). |
| **Your own AI account** | Runs on the Claude or ChatGPT subscription, or the API key, that you connect: one for the whole team or each person's own, with usage and limits per person. Trina doesn't provide the AI. |
| **Your server or ours** | Install it on your own server or an office Mac, or let Trina host it in AWS Seoul. The software is free and open source. |

<sub><b>New in 0.5</b>: in the 0.5 beta releases or coming in the next one. On the current stable release (0.4), people call @Trina inside the room instead.</sub>

## A day at Dawnroute, a fictional company

- **Monday, 9:00.** Alex finds last week's sales summary in his Inbox. He set it up once as a scheduled task; it ran by itself, with his access.
- **10:30.** Sam writes in the Sales room that Northwind Foods wants a quote today. Mina asks Trina beside the room to make it from the price sheet, checks the numbers and presses **Send to thread**. The quote is under Sam's message. <sub>new in 0.5</sub>
- **14:00.** Mina is out with a client. Sam opens her Northwind quote chat in the Sales project and asks for a version with free delivery. Trina picks up where Mina left off, working with Sam's access. <sub>new in 0.5</sub>
- **16:00.** Mina asks for last quarter's revenue. That file is in Finance, which she can't open, so her AI can't open it either.

<img src="docs/images/readme/permission-answer.png" width="100%" alt="A sales team member asks 'What was our revenue last quarter?' and the AI answers that it found no revenue figures in any team file she can access.">

<sub><b>Same question, different people.</b> Mina is in Sales. The revenue file sits in <code>shared/Finance</code>, which she can't open, so her AI can't open it either.</sub>

## Same request, two answers

<table>
<tr>
<td width="50%" valign="top"><b>Claude Code in an empty folder</b><br><sub>It can't know your company, so it asks six questions first.</sub></td>
<td width="50%" valign="top"><b>Trina AX, same line</b><br><sub>It starts from the team's files and the CEO's proposal skill.</sub></td>
</tr>
<tr>
<td><img src="docs/images/readme/before-empty-claude.png" alt="Claude Code in an empty folder answers 'Write a proposal for Trina Logistics' with six questions about the company, the client and the format."></td>
<td><img src="docs/images/readme/after-trina-deck.png" alt="Trina AX answers the same request with a 7-page proposal deck with photos; the cover reads 'Lead time from 2.1 to 1.4 days, within your budget'."></td>
</tr>
</table>

<sub>Real outputs from 2026-10-31 and 11-01 with a fictional company, Dawnroute; the deck photos were made with Higgsfield. Claude Code is right to ask: nothing in an empty folder tells it who you are. Trina gives it the folder.</sub>

## FAQ

<details>
<summary><b>Is the AI included?</b></summary>

<br>No. Trina is the workspace. Your team connects its own Claude or ChatGPT subscription, or an API key, and AI usage is billed by that account. Use only accounts and plans authorized for your use.

</details>

<details>
<summary><b>How is this different from giving everyone a Claude seat?</b></summary>

<br>A seat gives each person their own empty workspace. Trina gives everyone the same company folders and team skills on one server, with each person's folder permissions checked by the server. You can still connect per-person accounts.

</details>

<details>
<summary><b>Do we need an AI account to try it?</b></summary>

<br>No. The [local demo](docs/QUICKSTART.md) runs with AI turned off and fictional data, so you can look at files, skills and permissions first. To see Trina answer, you need a server with your own AI connection ([Try it](#try-it-in-10-minutes)).

</details>

<details>
<summary><b>Can admins read our chats and rooms?</b></summary>

<br>No. Your own chats and side chats with Trina are visible only to you, and a project's shared chats only to the people on that project. A room is visible to its members; admins can't open rooms they aren't in. Activity records show which files the AI read, not the conversation. People who operate the server or its storage can read stored data.

</details>

<details>
<summary><b>Does it work with Korean HWP files?</b></summary>

<br>Yes. The AI reads the text of HWP/HWPX files on every server. With the optional HWP Preview plugin turned on, it also makes new .hwpx documents (headings, paragraphs, lists, simple tables), fills in an existing .hwp or .hwpx form (placeholders, empty cells, table rows) and saves it in the same format, keeping the rest of the file as it was, and shows visual previews. The plugin does not run on Debian 12. More in the [FAQ](docs/FAQ.md).

</details>

## The 97-second story

https://github.com/user-attachments/assets/61f3469b-358d-4b3a-9233-c6b23b5db835

<sub><b>Sound on.</b> A team lead sets up Claude once, and on her first day a new hire’s proposal comes out like his.<br>Animated story with the real app at 1:15. Fictional company.</sub>

## For whoever sets it up

### Try it in 10 minutes

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile
bun run demo        # → http://127.0.0.1:19760 · sign in as alice / teamax-demo-1
```

A fictional team with six starter skills. AI is off, so no AI account is needed. Sign in as `bob` in a private window: each sees a different group folder. Needs Git, Bun 1.3.12 and Go 1.27+. This is **not a production install**. [Walkthrough](docs/QUICKSTART.md)

To try rooms with the AI, run the [Docker install](docs/INSTALL-DOCKER.md) with a release (`TRINA_AX_VERSION=0.4.0`, or `0.5.0-beta.1` for a first version of the side chat and shared project chats) and connect your own AI account.

### Your team's first week

Create the owner account, then **permissions → AI connection → invite the team → first skill → first backup**. These starter skills use fictional inputs:

| Role | A real task | Copyable skill |
|---|---|---|
| CEO / team lead | Turn weekly notes into decisions, risks and next steps | [Weekly report](examples/skills/weekly-team-report/SKILL.md) |
| Sales | Draft a follow-up from a meeting, without inventing promises | [Sales follow-up](examples/skills/sales-follow-up/SKILL.md) |
| Marketing | Prepare a campaign brief from approved brand notes | [Brand brief](examples/skills/brand-brief/SKILL.md) |
| Finance | Flag missing receipts and uncertain amounts for review | [Expense review](examples/skills/expense-review/SKILL.md) |
| HR | Answer onboarding questions from permitted policies | [New-hire guide](examples/skills/new-hire-guide/SKILL.md) |
| Everyone | Extract decisions and actions from a meeting note | [Meeting summary](examples/skills/meeting-summary/SKILL.md) |

A skill is a reusable set of instructions, not model training or extra access. People review results before using them. [Team lead checklist](docs/for-teams.md) · [All examples](examples/README.md)

### How to run

| | Trina hosting | Self-host on Linux | Office Mac | Local demo |
|---|---|---|---|---|
| Best for | Teams without IT | Teams with an IT owner | A small office with a dedicated Mac | Looking around |
| Who runs it | Trina, in AWS Seoul | Your IT | Your office operator | You |
| AI | Your authorized Claude or OpenAI connection | Same | Claude (no Codex) | Off |
| Cost | Free 14-day trial, then a monthly plan + AI usage | Free software + your server | Free software | Free |
| Start | [See the plans](https://ax.trina.app/#pricing) | [Linux guide](docs/INSTALL-LINUX.en.md) · [Docker](docs/INSTALL-DOCKER.md) | [Office guide](docs/OFFICE.en.md) | [Quickstart](docs/QUICKSTART.md) |

Trina provides the workspace, not the AI: use only Claude and OpenAI accounts and plans authorized for your use. AI usage is billed separately by the account you connect. Self-hosted, Claude Code can also run on other models such as DeepSeek, Kimi or GLM through an [Anthropic-compatible gateway](docs/CONFIGURATION.md#anthropic-compatible-gateway). [Current prices](https://ax.trina.app/#pricing)

Linux self-hosting needs Debian 12/13 or Ubuntu 24.04, systemd with cgroup v2, amd64 or arm64, 4 GB RAM recommended and 20 GB disk minimum. Your IT team installs, updates and restores backups.

### Under the hood

Our first commit, on 2026-10-21, already had the permission function (`server/src/policy/authorize.ts`). Every file call still goes through it.

```mermaid
flowchart LR
  P["Your team<br/>browser · Mac · Windows · iPhone · Android"] --> S["Trina server"]
  E["Claude Code / Codex<br/>own shell and file tools turned off"] -->|"only path: Trina file tools"| C{"Permission check<br/>as the person asking"}
  S --> C
  C --> D[("Company folders<br/>shared · groups · projects · users")]
  E -. "direct disk access denied by the OS" .-x D
```

- **The agent is real.** Up to 150 tool rounds per answer by default, up to 4 sub-agents at a time (Claude), web search. Sub-agents work as the same person, through the same checks, and leave the same activity records.
- **The way in is narrow.** The engine's own shell and file tools are turned off and covered by regression tests for each engine. Its path to your folders is Trina's file tools, checked on every call.
- **Keys stay out of reach.** Tokens are sealed in the browser before they're sent. The engine gets a per-turn stand-in token, and a model proxy adds the real one.
- **Your chats with Trina are yours.** Your own chats and side chats are visible only to you, and a project's shared chats only to the people on that project. A room is visible to its members; admins can't open rooms they aren't in. Admins see which files the AI read, not the conversation. Server operators can still read stored data, and we say so [below](#data-and-limits).

<sub>OS isolation (a dedicated engine account) applies to Linux and role-account Mac installs. Office Mac runs as the signed-in user, and the local demo has no OS isolation. → <a href="docs/security-and-permissions.md">Security and permissions</a> · <a href="docs/PERMISSIONS.md">Permission model (Korean)</a></sub>

### Data and limits

Self-hosting is not offline: the context a request needs goes to the AI provider you connect. Server operators, including Trina for hosting, can read stored files and chats; app admins cannot browse private conversations.

<details>
<summary><b>What leaves the server, connection rules and what we don't promise</b></summary>

<br>

- Selected context goes to the chosen AI provider, and configured integrations receive their requests. Each Codex web search sends the conversation so far to OpenAI's search service. The sound of video and audio files the AI reads goes to OpenRouter when the team chose OpenRouter for speech and allowed it. The server asks `updates.trina.app` for its own public address every 30 minutes (`MYCEL_EXIT_ADDRESS_CHECK=off` turns that off). [Details](docs/security-and-permissions.md)
- Server operators can read stored files and chats, including Trina operators for hosting. App administrators do not get a browser for everyone's private conversations.
- Removing folder access does not erase earlier answers. Wider-sharing confirmation is not universal data-loss prevention.
- No security certification, perfect answers, guaranteed savings or automatic legal, financial or HR decisions. Review outputs and deployment boundaries.
- The AI sees photos and scanned PDF pages as images (an admin can turn this off), but Linux servers run no OCR: scanned documents and photos are not text-searchable there.
- On Linux servers the AI also reads video and audio files: evenly spaced frames go to the AI provider like images, and the sound is turned into text by the team's speech provider only when an admin allows it ("Turn video sound into text"). With OpenRouter as the provider, the sound of team files goes to OpenRouter and its provider; confidential chats never send it. Office Macs cannot read video yet.
- HWP/HWPX text extraction is available to every team. [Visual previews](resources/hwp/README.md), and the AI making and filling in Hangul documents, come with the optional HWP Preview plugin, which needs macOS or Linux with glibc 2.39 or newer, so Debian 12 does **not** support them.
- In managed installations, eligible personal connections take priority, followed by connections assigned to a person, a group, then the whole team. On fresh Trina teams, one company connection can serve the whole team by default; existing saved choices persist. Connection-level consent still applies. **This software setting does not grant permission under Anthropic's or OpenAI's terms.** The local demo disables AI; development and office local-login modes have different connection behavior. [Connection details](docs/FAQ.md)

</details>

## Community and contributing

Ask questions and meet other teams on [Discord](https://discord.gg/zUVfSR8MVk) (the "Trina AX" server). News goes out on [X](https://x.com/trina_ax).

[Latest release and checksums](https://github.com/trina-app/trina-ax/releases/latest) · [Changes](CHANGELOG.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md) · [Development](docs/DEVELOPMENT.md) · [Configuration](docs/CONFIGURATION.md) · [Machine-readable index](llms.txt)

The app speaks English, Korean, Indonesian, Japanese and Spanish. Published installers can lag behind source changes; check their release notes.

## License

Free to use, including commercially, under [AGPL-3.0-only](LICENSE). If you offer a modified version over a network, offer its source to those users. The cloud protocol is separately licensed under MIT ([license](shared/src/cloud-protocol/LICENSE)). [Notices](NOTICE) · [Third-party notices](docs/THIRD-PARTY-NOTICES.md)

Claude Code and Codex have their own terms; this project is not endorsed by Anthropic or OpenAI. Claude is a trademark of Anthropic.
