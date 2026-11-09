# IT handoff: deploy and operate Trina AX

[한국어](for-admins.ko.md)

Decide data sensitivity, server ownership, authorized provider connections, client needs, outbound network policy and who restores backups. Selected context leaves for the provider; hosted operators can access stored data. [Security boundaries](security-and-permissions.md).

Two more outbound flows to allow for: the server asks `https://updates.trina.app/ip` for its own public address at start and every 30 minutes (`MYCEL_EXIT_ADDRESS_CHECK=off` opts out; then every web address the AI opens asks a person and scheduled tasks open none; Admin > System > Diagnostics shows whether the server knows its address), and each Codex web search sends the conversation so far to OpenAI's search service.

save_url downloads go from the server to the file's address, like web pages the AI opens: public internet addresses only, every redirect checked again. A download streams to `<data>/work` and then into the team folder; there is no size limit, but a file over 1 GB asks the person first (a scheduled run skips it), and the server refuses a download that would leave less than 10% of its disk free (at least 5 GB, at most 20 GB). Images and files a connected service returns inside its answer are kept under `<data>/connection-media` for 24 hours (at most 200 MB per chat). An answer from a connected service's tool may now be up to 25 MB (1 MB for everything else).

When the AI reads a photo, screenshot or scanned PDF page, it sees the image, and the image goes to the provider like any other file content. Admins can turn this off in Team settings ("Send images, PDF pages and video frames to the AI", on by default); the switch also covers HWP page images and the in-app browser's screenshots. Linux servers run no OCR: scanned documents and photos are not text-searchable there.

On Linux servers the AI reads video and audio files (up to 1 GB) like Claude Code users do with ffmpeg and whisper: evenly spaced frames (the switch above) and a timed transcript. ffmpeg comes from the distribution (an apt dependency of the installer, not part of the bundle); keep the server's security updates on, because its decoders read files people upload. The transcript uses the team's speech provider (Team settings › Voice input) only while "Turn video sound into text" is on: on by default for "On this server" (off by default on a server with 2 CPU cores or fewer, where it is slow; frames still go), off by default for OpenRouter, where turning it on sends the sound of team files to OpenRouter and its provider (another outbound flow to allow for; never from confidential chats). Each new transcript is an activity record ("Turned the sound of a video or audio file into text": who, which file, how many seconds, which provider; never the words). "On this server" works in 30-second pieces, as many as fit in one read (5 minutes) at the speed the server measured on itself; finished pieces are kept, so reading again goes on from there. Voice input goes before a video's transcript. Office Macs cannot read video and audio yet.

On a Trina-hosted server (every plan, the free one too), speech-to-text is included: each team gets 50 hours of sound a month (Korea time) on Starter, 100 on Team and 200 on Business (10 on the free plan), one pool shared by voice input and the AI's video and audio reads. Voice input is on by default there and "Turn video sound into text" defaults on. The sound goes through OpenRouter to DeepInfra in the US (Groq in the US when DeepInfra is down), only to providers that keep no data (zero data retention, no training). Team settings › Voice input shows the hours used this month out of the plan's; past them voice input and video sound stop until the 1st, and both say so. A team that adds its own OpenRouter key there uses that key first, without the limit, billed to its own OpenRouter account. Turning voice input off, or "Turn video sound into text" off, works as on any server. Confidential chats never send sound out: not the sound of files, and not voice input either. The composer tells the server which chat a recording is for, and the server refuses to send a confidential chat's recording to OpenRouter (the composer says so; a new chat counts as confidential only while every chat is). With "On this server" voice input still works in confidential chats, because nothing leaves the server.

On a team's own server (Linux or a Mac), voice input is off until an admin turns it on in Team settings › Voice input. Saving the team's OpenRouter key there is enough: while no provider is chosen, the saved key turns voice input on, and removing it turns it off again. OpenRouter costs about $0.1 per hour of recording, billed to the team's OpenRouter account. A provider chosen there, "Off" included, always goes before the key. "On this server" needs whisper.cpp (whisper-cli) and ffmpeg on the server: the Linux kit brings whisper-cli and installs ffmpeg, the Mac builds bring neither (Homebrew: `brew install whisper-cpp ffmpeg`, then restart the server, which looks for them when it starts). Without them the mic stays hidden and Team settings says which one is missing.

By default one answer may use tools up to 150 times (tools the AI uses together count once); admins can change this in Team settings ("Tool rounds per answer", 10–500). At the limit the answer pauses and Continue picks it up. A higher limit lets one answer work longer, so it can cost more; the 20-minute limit and budgets still apply.

| Mode | Guide | Operational boundary |
|---|---|---|
| Linux server / VM | [Install](INSTALL-LINUX.en.md) | systemd and cgroup v2, dedicated accounts and OS isolation. Plain Docker is not the production installer target |
| Docker (Linux or Mac host) | [Install](INSTALL-DOCKER.md) | Same accounts, sandbox and egress rule in one container; no per-turn cgroup limits, updates by image tag. New, less tested |
| Office Mac | [Install](OFFICE.en.md) | Runs as signed-in user, stops on logout. Claude path, no Codex |
| Role-account Mac | [Detailed installation](INSTALL.md) | Separate accounts and LaunchDaemons; operator-maintained source bundle, not a released desktop DMG |
| Fictional local evaluation | [Quick try](QUICKSTART.md) | AI disabled, loopback only, not a production isolation test |

After owner creation: **permissions → AI connection → invite the team → first skill → first backup**. Managed connections prefer eligible personal credentials. On fresh teams one company connection can serve the whole team; existing choices and connection-level consent remain. Provider authorization is separate.

The team folder's real folder names (`shared/`, `groups/`, `projects/`, `skills/`, `users/`), the API paths and the
paths the AI sees are unchanged; the Files screen shows them as Company-wide, Groups, Projects, Team skills and Personal
(the person's own as My folder), and in Korean as 전사 공유, 부서, 프로젝트, 팀 스킬 and 개인. The Korean screens call admin
groups **부서** (Admin › 부서; group chats people start themselves keep 그룹 대화). A new team gets `shared/Templates/`
(named in the team's language, `shared/양식/` in Korean), and the setup puts the company intro, brand, meeting notes and
first team files under `shared/`. Teams that started before keep theirs in `groups/<team name>/`; nothing is moved.

Pilot acceptance: demonstrate two users' different file access, review a skill result against its sources, inspect usage and perform an encrypted off-host backup/restore drill. [Starter examples](../examples/README.md) · [Backup and restore](BACKUP-RESTORE.md).

Before updating, read the [latest release](https://github.com/trina-app/trina-ax/releases/latest), including default changes, and back up. Linux and office Mac use the Trina feed. App rollback is not database/file rollback. A Linux server keeps the current version and the previous one (for roll-back) and removes older ones by itself, so the app takes about 1–1.5 GB of disk ([Kept versions](INSTALL-LINUX.en.md#kept-versions)). [Configuration](CONFIGURATION.md) · [Troubleshooting](TROUBLESHOOTING.md).

Browser/mobile web and a Windows installer are available. The Mac server ZIP is not a desktop DMG. This source includes EN/KO/ID/JA/ES. HWP visual preview is the optional HWP Preview plugin (Admin > Plugins); it is unavailable on Debian 12 and default bundles omit its runtime. Check release notes before installing published artifacts. [Support](../SUPPORT.md).

PDFs the AI makes on a Linux server draw Korean, Japanese and Chinese with the Noto Sans CJK fonts that come with each release; there is nothing to install. An office Mac uses its own fonts (Apple SD Gothic Neo, Hiragino Sans, PingFang). Each PDF is set in the language it is written in: a Japanese document gets the Japanese faces first and a Chinese one the Chinese faces (the same characters are drawn differently in each), and a document without Korean, Japanese or Chinese text follows the team language.

Plugins (HWP Preview and others), their permission prompt and how official packages are verified: [Plugins (Korean)](PLUGINS.md).
