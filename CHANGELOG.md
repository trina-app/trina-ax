# Changelog

Published artifacts and authoritative release notes are in [GitHub Releases](https://github.com/trina-app/trina-ax/releases).
This file summarizes user-visible changes; it is not a list of every commit.

## Unreleased

**Upgrade note:** two small database migrations (217 and 327, additions only: the previous version still opens the database). Linux servers need the root update once for this release: mycel-ctl has the new tenant command `hosted-speech-key-set` (the update timer installs it, or run `sudo mycel-ctl update`). One new team setting, "Turn video sound into text" (Admin > Team settings > Voice input): it starts at its default, on when voice input runs on this server (off on a server with 2 CPU cores or fewer, where it is slow) and off when it uses OpenRouter. Linux servers use the distribution's `ffmpeg` package (the installer already installs it and stops without it). Keep the server's security updates on: ffmpeg's decoders read files people upload.

- Hosted servers (every plan, the free one too): speech-to-text is included, one pool of 10 hours of sound a team a month (Korea time) shared by voice input and the AI's video and audio reads. The hosting service hands each team's server its own OpenRouter key (the new tenant command `hosted-speech-key-set`; mycel-ctl and `admin.js hosted-speech-key`), kept encrypted like the team's own key and never shown. With it, voice input is on by default (OpenRouter) and "Turn video sound into text" defaults on; an admin's choice, off too, still wins. The sound goes through OpenRouter to DeepInfra in the US, or Groq in the US when DeepInfra is down, with zero data retention. Admin › Team settings › Voice input shows "This month: N of 10 free transcription hours used"; past 10 hours voice input and video reads say so and stop until the 1st. A team's own OpenRouter key comes first and is not counted. A server that is not hosted removes the hosting key at start. In all five languages.
- Voice input and video sound through OpenRouter: when the provider fails (5xx) or does not answer in time, the request is sent once more (OpenRouter may send it to another provider), after the same checks as new sound (in a read: the switch, the provider, a confidential lock, the person's access to the file); only both failing is shown.
- Chat: the AI reads video and audio files, like a Claude Code user with ffmpeg and whisper. Reading a video (mp4, mov, m4v, webm, mkv, avi, 3gp) gives evenly spaced frames as images with their times and a timed transcript of the sound between them; an audio file (mp3, m4a, wav, aac, flac, ogg, opus, amr, aiff, caf, wma) gives the transcript. The AI can look at a part (`time`, for example "1:00-2:30"), ask for fewer, bigger frames for small text on a screen, or skip the sound. A read covers up to 10 minutes of sound next to frames and 30 minutes without them, and says what to read next (a 1-hour meeting takes two reads with OpenRouter; this server's speech model works in 30-second pieces and keeps each one it finished, as many a read as its speed allows, at most 2 minutes of new sound a read on a hosted server). Files up to 1 GB. The step reads "Watch video · …" / "Listen to audio · …". Linux servers only: an office Mac says it cannot read video yet.
- Privacy: the sound of a video or audio file is turned into text by the team's speech provider only while "Turn video sound into text" is on. With OpenRouter, turning it on sends the sound of team files (meeting recordings, calls) to OpenRouter and its provider, which the setting says; a new provider starts from its own default again. Confidential chats never send sound out (a transcript the server already made may be used there). Before each new piece of sound the setting, the provider, the chat's confidentiality and the person's access to the file are checked again, so turning the setting off or taking access away stops a read that is already running. This server's speech model is never downloaded by a read. Transcripts are kept by content on the server for up to 30 days (200 MB, not in backups), so reading the same file again costs nothing, and each new transcript is an activity record without its words. In all five languages.
- Video and audio sound on this server (whisper.cpp, the "On this server" speech provider): a read makes its frames first and gives the sound the time left, so a slow transcript never leaves a video without its frames. The sound goes in 30-second pieces, as many as fit in the read's 5 minutes at the speed the server measured on itself (voice input measures it too; one unusually slow run cannot stop later reads); the result says how far the transcript got, and reading again goes on from there (finished pieces are kept). Silent parts (gaps with no sound at all; quiet speech still counts as sound) are not transcribed and lines over them are dropped (whisper made words up there), each part keeps its own language, and when whisper is unsure of a few seconds of speech it tries again told the file's language (else the team's), keeping that only when it is not a translation (never reported as the language heard). whisper.cpp uses 2 threads on a 2-core server. On a server with 2 CPU cores or fewer "Turn video sound into text" starts off; the read and the setting say why, and an admin can turn it on. The setting's text follows the server (piece length, a hosted server's 2 minutes a read, the measured speed). A hosted server still transcribes at most 2 minutes of new sound a read. In all five languages.
- Voice input goes first: while someone dictates, a video read's transcript waits (a piece that was running stops and is made again after it), so dictation no longer takes minutes next to a video read on a small server. A read waits for a long voice input job at most 45 seconds, then says voice input is using the transcription and that reading again goes on.
- Admin > Team settings: "Send images and PDF pages to the AI" is now "Send images, PDF pages and video frames to the AI" (the same setting); video frames follow it, the API engine and the per-answer image limit like images. Picking another speech provider in the form and back no longer turns "Turn video sound into text" back on; only a save that changes the provider starts it again from that provider's default.
- Security: video decoding runs in the converter isolation with allow-lists of formats and decoders (by decoder name, checked on Debian 12's ffmpeg 5.1 and Debian 13's 7.1), one thread, time and memory limits; frames come on ffmpeg's output and are drawn again by the image normalizer. A playlist or concat file disguised as a video never opens another file. Only a video's length, size, codecs and frame rate reach the AI, never its title, comment or subtitle text, and the transcript is marked as file content, not instructions.
- Korean: the AI's image notes and voice input errors now use the same polite, plain style as the rest of the app (해요체 instead of 합니다체), like the team server's other messages in 0.2.16. The meaning is unchanged.
- Search by meaning (the AI's `search` tool) is off by default. In a test with a folder of about 2,900 files it put unrelated passages ahead of the right document for most questions, used up to about 1.9 GB of memory while indexing and kept most CPU cores busy for minutes; the AI finds documents with grep and file names, as before. `MYCEL_SEMANTIC=on` turns it back on. An index and model already downloaded stay on disk (about 120 MB plus the index) and are used again when it is turned on.
- Team skills: every person now sees the skills they can use. A member's Team skills page used to show no skill at all (only their own suggestions; "Frequently used skills" appears only once a skill has been used). The page now opens on "Available skills", the same list as the "/" menu: team skills in folders the person can read and their own personal skills, each with its description and file, "Use in chat" and "View file". Nothing there can be changed; reviewing suggestions and recent changes stay with the people who manage skills and admins. In all five languages.
- Skill picker ("/" in the message box): every matching skill is listed, not only the first eight, and the list scrolls. The sixth row was cut in half and the arrow keys moved to rows you could not see; now the chosen row stays in sight, also on a phone.
- Counts say "1 person", "1 use", "1 time", "1 file", "1 unread notification" in English and Spanish instead of "1 people", "1 uses" and so on: on the Skills page and the new-chat home, the "more people will see this" questions, notifications, Admin › System, the desktop browser's "more questions waiting", and the team server's cards when the AI saves where more people can see it or moves or copies files ("1 item" instead of "1 item(s)", "Move it?" for one file). Japanese, Korean and Indonesian do not change a word with the number and read as before.
- Desktop app: the browser's question before the AI uses a site now says what the AI is doing in plain words, such as "Open browser · https://…" or "Open page · https://…", the same words as the step under the answer. It used to show the internal tool name ("preview_start").
- Skills: the AI now knows every skill you can use, not only the first 50. Before, skills after the 50th (by name, often plugin skills and skills in later folders) were left out of its list without a word, so it never picked them on its own; typing "/name" still worked. Now each skill is one short line (its name and what it is for), like in Claude Code, and the AI loads the full steps with a new skill tool when it uses one ("Use skill · …" under the answer). When a team has more skills than fit, every name stays; your own skills and the ones you use most keep their description, the AI can search the rest ("Find skills …"), and the server points it to the skills that match your message. Skills in folders you cannot open are never named, found or loaded, by the AI or its helpers.
- Skills: a chat that goes on is told which skills were added, changed or removed since it started, so a skill made during a conversation can be used in it.
- Skills: the Team skills page says how many skills the AI sees with their description and by name only, when not all of them fit. The server now reads up to 1,000 skill files per folder (was 200) and tells the people who manage team skills when there are more. Team rules: when there are more than 10 rule files, the AI is told how many it does not get and the managers see a note (only the first 10 are followed, as before).
- External services: a service that offers more tools than the AI can use shows "100 of 150 tools" in Settings, and the AI is told so (at most 100 tools per service and 200 in one answer, as before).
- Speech through OpenRouter (voice input and the AI's video and audio reads): a long recording no longer comes back in the wrong language. The speech model picks one language for a whole request from its first 30 seconds, so a 13-minute Korean meeting whose first voice it took for Japanese came back translated into Japanese. Now a recording or piece of a minute or more that it heard in an unlikely language (not the team's language or English, words it was unsure of, or a language other parts of the file were not in) is sent once more told the file's language or the team's, and the answer the model is surer of is kept; a Japanese meeting stays Japanese. On that meeting the Korean text went from almost all wrong to about 1 character in 5 (as one voice recording, 1 in 12), and its timestamps are right again. A language it was told is not shown as the language heard. Confidential chats still send nothing.
- Speech through OpenRouter: quiet recordings are raised before they are sent (a room microphone at -45 dBFS: about 1 error in 10 characters before, under 1 in 100 now), never far enough to make the model invent words over room noise.
- Speech through OpenRouter: the sound is sent as FLAC, which is lossless, so the text is exactly what it was, at about 40–50% of the upload (10 minutes: 7–9.5 MB instead of 19 MB), which keeps long pieces further inside OpenRouter's one-minute limit on a slow connection. A recording's title and comment tags are no longer sent with it.
- Speech through OpenRouter: the request asks for DeepInfra, and for Groq when DeepInfra is down, and no other provider (with zero data retention and no data collection, as before); OpenRouter does not apply this to speech yet, so a key's own provider settings on OpenRouter decide for now. The answer's language is read the same way from every provider ("Korean" from Groq is `ko`). Each activity record of a video or audio transcript now also says which provider served each request (looked up at OpenRouter a few seconds after the read; never the words).
- Self-hosted servers: Claude Code can answer with another company's models through an Anthropic-compatible gateway (OpenRouter; the Anthropic-compatible APIs of DeepSeek, Kimi, GLM): `engine.anthropicGateway` in server.json, managed mode only, no admin screen. Only the model ids set there reach the gateway (never a `claude-*` name); Claude Code's opus / sonnet / haiku aliases and its side requests use them, and Admin › AI engines and the team default list them. The gateway's key is added in Admin › AI connections as "API key for <name>" (an OpenRouter key is checked on its `/api/v1/key`). While it is set, Claude subscription connections and Claude API keys added for Anthropic are off on the server: they are kept, and nothing is sent with them. Costs use what OpenRouter reports it charged, or the prices in server.json. Conversations go to the gateway provider and the model's vendor. [Configuration](docs/CONFIGURATION.md#anthropic-compatible-gateway). In all five languages.
- Copying an answer keeps its formatting, like Claude's copy. "Copy answer" now puts two versions on the clipboard: formatted text and, as before, the answer's Markdown. Pasting into Gmail, Outlook, Word or Google Docs gives headings, bold, lists, links, code blocks and real tables with borders; pasting into a plain text field gives the Markdown. Images from other sites become links and never load where you paste them; links to team files point to the file on the team server, so whoever opens one signs in first. Math and diagrams are pasted as their source. Works over plain http on an office network and in the desktop app too.
- Settings › Memory: add a memory yourself and correct one in place, not only delete. "Add memory" opens a field at the top of the list; the pencil on a memory opens the same field with its text. The rules are the AI's own: one line of up to 300 characters (line breaks and runs of spaces become one space), not empty; Enter saves and Esc leaves it as it was. A memory you correct counts as yours from then on, and its source chat link stays. The audit log records that someone added, changed or deleted one of their own memories, never the text. Memories still keep no earlier versions. In all five languages.

## 0.2.16 — 2026-11-01

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.16).

**Upgrade note:** no database migrations in this release (the schema reader level stays 4, and 0.2.15 still opens the database). Linux servers need the root update once for this release: its root programs are the first built without the commit stamp, so they differ from 0.2.15's; the update timer installs it, or run `sudo mycel-ctl update`. Later releases that do not change these programs need no root step. Nothing to change in settings.

- Linux servers (and Macs set up with `install-macos.sh`) no longer fill their disk with old versions. Every update added a whole version folder under `app/versions` (about 540 MB unpacked) and nothing removed the old ones: at one release a day that is about 16 GB a month, enough to fill a hosted Starter server within months. Now the server account removes them by itself, 10 minutes after the server starts and then every hour: every version folder except the current one, the previous one (Admin › System › Update › Roll back, and where the bootstrap goes when the current one no longer verifies), the newest one downloaded but not applied yet, and any changed in the last 24 hours; also `.staging-*` and `*.partial` folders an interrupted update left (once a day old) and engine folders `app/engines/<name>/<sha12>` that `current` no longer points to (a day after the installer changed the engine). Never while an update is pending, never following a link, never into a mount point, no root step. A folder is first renamed to `.prune-<hex>` and then removed, so a removal cut short leaves no half version; such a leftover goes a day later. A folder that changes while it is being taken out and cannot get its name back is kept as `.prune-hold-<hex>` (never removed) and named in Diagnostics. A folder the server account cannot remove (owned by another account, such as root's copy from an installer that was stopped) is named in Diagnostics for root to remove. `app/` stays at about 1–1.5 GB. The first run after the update to 0.2.16 removes what has collected (in a test: 9 versions, 4.5 GB, about 40,000 files in 5 seconds). `admin.js prune-versions --dry-run` lists what it would remove and `admin.js prune-versions` removes it now. Admin › System › Diagnostics shows the kept versions and their size ("Kept versions", in all five languages). Office Macs keep `app`, `app.previous` and `app.failed` as before.
- `mycel-ctl update` removes the work folder an earlier update left in `.install-tmp` when it was killed (a download and an unpacked bundle, about 600 MB).
- Office Macs: when several releases in a row fail to install, only the last one's download and unpacked bundle stay for a retry (before, each failed release's stayed until an update worked).
- Release builds use exactly Go 1.27.3, the Go that built 0.2.15 (`GO_VERSION` in both workflows, the same as `versions.json`), so a new Go patch or runner image no longer changes the root programs and makes a release need the root update. `docs/RELEASE-CI.md` says how to move it.
- PDFs the AI makes on a Linux server now show Korean, Japanese and Chinese. Before, these characters came out as empty boxes, because a Linux server has no font for them (only DejaVu) and typst fell back to its own font without them. The Linux server kit now carries the Noto Sans CJK fonts (2.004, Regular and Bold, OFL-1.1) in the version folder and make_file gives them to typst; headings and bold text are bold. Installed servers get the fonts with their normal update: no root step, no package to install. PDFs made before need to be made again. The kit grows by about 32 MB (40 MB unpacked). The fonts' notice and licence are in `licenses/noto-sans-cjk/`. Office Macs are unchanged: they use the Mac's own fonts. Word files were never affected.
- Linux server updates: the root programs (mycel-ctl, the launcher, the sandbox helper, the bootstrap, mycel-safeops) no longer change with every release. They carried the commit they were built from, so every release so far needed the root update ("Administrator rights needed"), even when these programs had not changed. Now a release that does not change them needs no root step; the first release with this change still needs it once, since its programs are the first without the commit.
- HWP preview: when the HWP Preview plugin is installed but turned off, an admin is now told to turn it on in Admin › Plugins (before: "Admins can add it"). In all five languages.
- AI image reads: when a converter replaced its work folder, the AI is told the file could not be read (damaged), not that it was too heavy.
- Look and contrast: the office update banner and the hosting notices now write their text in the darker accent colour (5.2:1 on their tint in light, was 3.3:1), and so do the links in Admin (Engines, System, AI connections, Team settings). Bordered buttons (such as "Always allow", "Try again" and "Restore") have an edge at least 3:1 against the page instead of a faint hairline. Switches: the off track is darker (at least 3.3:1, was about 2:1) and in dark the knob turns warm black on the orange when on (6.6:1, a white one was 2.9:1; in light it stays white, 3.7:1), and the keyboard focus ring sits outside the track so it also shows when the switch is on. The danger button's border is stronger (3.5:1 or more, was about 2:1). The quiet delete buttons (Delete on a project, turning off a skill manager's folder) are red again, as intended (they showed grey); a plain "no" stays neutral, like Claude Code's: "Deny" on the in-app browser's site card and "Reject" on a team skill review; the delete icon of an external service turns red on hover. Light and dark.
- The app's font is now named as what it is: the system face (Apple SD Gothic Neo and SF on Macs and iPhones, Segoe UI with Malgun Gothic on Windows, Noto Sans KR on Linux). Pretendard was listed first but never shipped, so nothing changes unless Pretendard is installed on your computer. AI-made pages (artifacts) use the same default.
- The phone's browser bar and the installed app's title bar use Trina's page colour in light and dark (`theme-color`), not the older green-grey theme's.
- The mobile app's default accent is Trina's orange, with a dark label on its Connect button so it stays readable; the team address screen uses Trina's colours and a field edge you can see.
- Desktop app: the welcome screen and the browser toolbar use the same colours as the web app (the focus ring is the accent, dark-mode error red, warning tint), bordered buttons and fields have a 3:1 edge, and orange text is the darker accent text. The office Mac's helper page (the certificate install steps) uses Trina's colours instead of the older green.
- Korean: messages from the team server (sign-in, files, system and update status, safety checks, the office Mac's helper and command line, the relay's pages) and a few app texts now use the same polite, plain style as the rest of the app (해요체 instead of 합니다체). The meaning is unchanged. Error notes and steps saved in earlier answers still change language with the screen.
- The icon script paints full-bleed app icons on the logo's own dark tile colour instead of the old green; the committed icons already looked like that, so they are unchanged.

## 0.2.15 — 2026-11-01

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.15).

**Upgrade note:** no database migrations in this release (the schema reader level stays 4, and 0.2.14 still opens the database). Nothing to change in settings.

- Files: drag rows onto a folder to move them there, like Finder or Google Drive. Dragging a selected row moves the whole selection; dragging any other row moves just that row and leaves the selection as it was. Folders can be dragged too, but never into themselves or their own subfolders. A breadcrumb also takes the drop to move items up. While you drag, the breadcrumbs show in place of the selection bar and the dragged rows are dimmed. A folder you can drop on is highlighted and says "Move here". A read-only or navigation-only folder says "Can't move here" and takes nothing. The move follows the same rules as the "Move" action: per-item permission checks, read-only items skipped and counted, one question for the batch if the move hides items from other people, renaming on a name clash, failures listed per item, and the same toast. The "Move" action stays the keyboard way to do it. Computer files dropped on a folder row are uploaded into that folder, and the upload list shows where each one goes. Dragging a file into a chat's message box still attaches it. In all five languages.
- Text fields: the edges of inputs, selects and text areas (the message box too) now have at least 3:1 contrast against the page in light and dark (WCAG 1.4.11; they were 1.28:1). A new `--c-field-border` token is used only for field edges, so cards and dividers keep their lighter lines. A focused field gets a 2px accent edge, at least 3:1 against the page. The chat's message box stays quiet, as in Claude: focused, its edge only turns darker.
- Security: what a converter leaves in its work folder (ffmpeg, whisper.cpp, heif-dec, pandoc, typst, the HWP renderer) is now used only when it is a plain file the converter itself wrote there, and a run whose work folder no longer is the one the server made is refused. Before, a converter taken over by a hostile file could make the server use another file it can read as the converter's result: sent to OpenRouter for transcription, or shown as a transcript, an attachment thumbnail, a HEIC or HWP preview, or the text of a new document; make_file could also write outside its work folder. The attachment thumbnail now comes straight from ffmpeg's output, and make_file writes only under names nothing in the work folder has taken.

## 0.2.14 — 2026-10-31

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.14).

**Upgrade note:** no database migrations in this release (the schema reader level stays 4, and 0.2.13 still opens the database). One default changes: an answer may now use tools up to 150 times before it pauses (was 50); to keep the old limit, set Admin > Team settings > "Tool rounds per answer" to 50.

- Chat: one answer may now use tools up to 150 times (was 50) before it pauses with "Continue"; tools the AI uses together count once, like Claude Code's turns. Admins can change it in Admin > Team settings ("Tool rounds per answer", 10–500, in all five languages). The 20-minute limit, budgets, each sub-agent's own 50 rounds and the API engine's 30 rounds stay as they were.
- Chat: a new AI tool, edit_files, makes the same exact change in up to 50 files in one call (for example one status line in many notes) instead of one edit per file. Each file still gets its own access check, read-first rule, version history, conflict copy and confirmation card, and its own activity record; a file that cannot be changed is listed and does not stop the others. Not offered in confidential chats or through the remote MCP connector.
- Chat: after a change to many files or items, the AI is asked to also list the ones it left unchanged (already as asked, or skipped and why).
- Chat: the AI is asked to write everything it says to the person in the answer's language, including the short text between tool calls, so a Korean answer no longer starts with "Verify:" or "Let me check…". What the person asks for in another language (an English email, a translation), code, file names and quotes stay as they are. Sub-agents write their reports in that language too. Claude, Codex and the API engine; a chat that continues an earlier session gets it with its next message.
- Admin > System > Diagnostics: the "Remote access (relay)" line on a server without the relay now says what the server knows. With a public address set up (`tunnel.host`: the Linux installer's `--public-host` or office mode's internet address, or the server's own https domain in `publicOrigins` / `MYCEL_PUBLIC_ORIGINS`) it shows that address and says the team can connect from outside (ok), instead of "the team can only connect from the office network"; with neither, it says so and, on Linux, how to set the public address. A relay's team address (a hosted `<team>.trina.app` address, or this server's address at its own relay) is not counted, so the hosted cloud keeps its support wording. A connected relay still shows its address. In all five languages.
- Admin > System > Connection: without the relay, a server with a public address shows "Public address, no relay" and the address instead of "Office network only" with an "Off" badge, also in "Change connection type". Servers without one show "Office network only" as before. In all five languages.

## 0.2.13 — 2026-10-31

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.13).

**Upgrade note:** no database migrations in this release (the schema reader level stays 4, and 0.2.12 still opens the database). Nothing to change in settings.

- Codex web search steps: a step whose query Codex has not named yet reads "Searching the web…", and an open of a search result reads "Opening a search result" instead of "Web search: " with nothing after it. A search the team server refused to send (it named an address instead of one of its results) now shows as failed with the reason, not as a done (green) step; the address was never opened. In all five languages.
- Chat: a step cut off by Stop or by the per-answer time limit now says "Stopped here" / "Paused here" in words next to its grey icon, not only to screen readers.
- Admin > System > Diagnostics: "Public address of the server" says whether the server knows its public address (IPv4 / IPv6, or from the relay), does not know it yet, or has the check turned off (`MYCEL_EXIT_ADDRESS_CHECK=off`), and what "not known" means: every web address the AI opens asks a person and scheduled tasks open none. The address itself is never shown. Installed servers and office Macs.
- Scheduled tasks: the card (when the AI creates a task, and "다시 확인") lists an address whose query is longer than 200 characters apart, with the query highlighted, and says runs never open it (such an address always needs a person, and nobody is there during a run). "Opens without asking" now counts only the addresses a run really opens.
- Docs: the privacy and admin pages (security-and-permissions, for-admins, the READMEs) now say that the server asks `https://updates.trina.app/ip` for its public address at start and every 30 minutes (`MYCEL_EXIT_ADDRESS_CHECK=off` opts out), and that each Codex web search sends the conversation so far to OpenAI's search service.
- Release notices: every server and office bundle now carries the Public Suffix List notice (MPL-2.0, source https://publicsuffix.org/list/, compiled into the tldts dependency) and the MPL-2.0 text in `licenses/public-suffix-list/`, added by the notice collector instead of by hand; a build without it stops.

## 0.2.12 — 2026-10-30

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.12).

**Upgrade note:** take a backup first (Admin > System > Backups > Back up now, and an off-host copy). Migrations 214, 215, 216, 322, 323 and 324 change the database; they are additive (reader 1), so the schema reader level stays 4 and 0.2.11 can still open the database. This release changes root files (units, mycel-ctl, root's 1A program copies): `sudo mycel-ctl update` or the update timer installs it. Scheduled tasks the AI made before this release were never confirmed by anyone: they are paused on upgrade until their owner checks them again (Settings > Scheduled tasks > "다시 확인"); owners get a notice, Admin > Members lists the waiting tasks, and templates keep running. Personal connections set to "run without asking" ask again. Servers ask `https://updates.trina.app/ip` for their own public address at start and every 30 minutes (outbound https to the feed, as for updates); `MYCEL_EXIT_ADDRESS_CHECK=off` opts out, and then every web address asks. Safe operations 1A on Linux is turned on with `sudo mycel-ctl safe-ops on` (`off`, `status`); while it is on, the server and every engine share at most 4 GiB of memory and 4 CPUs, so use a machine with 8 GB or more.

- Sub-agents: like Claude Code's Agent tool, the AI can hand parts of a big request to up to 4 helper AIs at once. They work as the same person (same tools except asking the person, memories, schedules and the browser; the same access checks, cards and activity records) and their steps show under a "Sub-task" row. On by default; Admin > Team settings can turn it off. Claude only (not Codex yet); on an office Mac that uses its own Claude login, confidential chats get none yet. The model proxy now checks the tool names of every request, and the engine starts with `--restricted` and every unused built-in denied. Migration 214 (reader 1).
- Scheduled tasks: when the AI creates one, a card shows the title, the schedule, the whole instruction and the web addresses in it; only those addresses open without asking in its runs, and a run's message no longer counts as typed by the person.
- Web pages and search results: the AI opens at most 8 of their links per answer and 30 per conversation without asking; then each new one asks.
- Servers without a relay (Linux behind a Cloudflare tunnel, hosted servers) now learn their own public address from the update feed (`https://updates.trina.app/ip`, over IPv4 and IPv6, at start and every 30 minutes), so they refuse web addresses that lead back through their own router and otherwise follow the normal rules: addresses the person typed or allowed open without a card, the link budget applies, and scheduled tasks open the addresses their card showed. Before, every web address asked with an "office address" card and scheduled runs could open none. A server that cannot reach the feed (or with `MYCEL_EXIT_ADDRESS_CHECK=off`) still asks for every address; its schedule card now says runs cannot open the addresses yet instead of promising they open, a scheduled run tells the AI why, and the card no longer mentions an office.
- Scheduled tasks nobody confirmed (made before the schedule card) no longer run: they are paused, their owner gets a notice (in the app, and by push per the "scheduled task failed" setting) and a banner, and "다시 확인" in Settings > Scheduled tasks shows the same card with the whole instruction and its addresses; resuming there confirms the task. The switch cannot resume such a task. Admin > Members lists waiting tasks (owner, schedule, since when; never the title or instruction). Migration 216 (reader 1).
- Address cards: "이 대화에서 이 사이트 허용" (allow this site in this conversation) opens later addresses on the same site (registrable domain by the Public Suffix List: example.co.kr, alice.github.io) without asking, in that chat and for that person only, outside the link budget. Addresses with long random-looking parts or a long name before the site (both now highlighted on the card, which then offers no site choice), a user name or password, or a long query still ask, the name is still looked up only after the check, office-network addresses are still refused, and confidential chats never use it. New server dependency: tldts 7.0.30 (MIT; carries the Public Suffix List, MPL-2.0). Migration 324 (reader 1).
- web_fetch and the in-app browser look a web address up only after the person allowed it; the desktop browser cancels requests it blocks without looking the name up.
- Connected services: the card before a change shows everything that is sent, where it goes first; "run without asking" is for team connections only, and runs in a scheduled task only if its card allowed it.
- Codex (the team's AI connections) can search the web again, like Claude: it had no search tool at all with the team's own model provider. Cached results only (OpenAI's own index, no live page loads), enforced by the model proxy; each search sends the conversation to the model service's search endpoint, as Claude's WebSearch does to Anthropic. Never in confidential chats or approved template runs. The step shows the query. Pages are opened only from the search's own results (an address goes through web_fetch and its card); a search the model service refuses or limits fails by itself and no longer affects the AI connection, and shows as failed.
- Admin > AI connections says that OpenRouter, Gemini and local models are connected in AI engines > API engine, with a link (the connections here are for Claude and Codex).
- Chat: a step that was still running when you pressed Stop shows as stopped (like Claude Code's "Interrupted"), not as a red failed step. Older apps still show it as not finished.
- Images: "Send images and PDF pages to the AI" and the per-answer image limit now also cover HWP page images (hwp_render) and the in-app browser's screenshots; when they are not sent, the AI is told why and what gives the text instead. On a Mac, the API engine and the remote MCP connector read images and scanned pages with Apple Vision again when they cannot take images.
- "Ask the AI to fix it" no longer carries web addresses from the artifact's title or key.
- Security: artifacts and HTML / SVG previews can no longer open WebRTC or WebTransport connections, including through nested frames, shadow roots or `document.write`; inside them, `document.write`/`open`, `setHTMLUnsafe`, `window.open` and nested iframes are turned off. In confidential chats (Safe operations 1A) they are shown without running scripts except in the desktop app, with a notice in ko/en/id/ja/es. Other chats work as before. See docs/DECISIONS.md "Artifact frames: no direct connections".
- AI connections: a ChatGPT (Codex) connection now counts its use (tokens, requests, last used) in Admin > AI connections, so its monthly limit works; chatgpt.com sends its answer stream with no content type, and the model proxy read it as a plain reply. The server log no longer warns about Codex's background calls or about the Stop button (logged as the person's stop).
- Safe operations 1A works on a standard Linux install: `sudo mycel-ctl safe-ops on|off|status` turns it on (root-owned copies of `mycel-safeops` and `pandoc` in `root/safe-ops/`, the flag, and limits on the new `<id>.slice` that now holds the server and the launcher: memory ≤ 4 GiB, no swap, 512 tasks, ≤ 4 CPUs, only while 1A is on) and restarts both units. A release that changes either program needs root. Refusals and Admin › System › Diagnostics say what is missing ("Safe PowerPoint (1A)").
- Safe operations 1A: tries refused before converting anything no longer use the 8-per-hour / 4-per-reply slots; busy, cleanup, the hourly limit (with the minutes to wait), the per-reply limit and the budget are separate messages in five languages.
- Safe operations 1A: after it is turned off, only chats that ran a 1A job stay without web fetch, connectors and the browser; other chats used while it was on get them back. Migration 323 (reader 1); chats it cannot rule out stay locked.
- Files: a download-only (generated, quarantined) file no longer offers "Ask AI" or "add to chat"; the panel says the AI cannot read it.
- Files: the Files list does the same: a download-only file shows "Download only", and its menu keeps "Ask AI" and "add to chat" off with the reason (the folder listing API marks such files with `downloadOnly`, an optional field); the attach picker shows it as not attachable.
- Steps under an answer: HWP page views, scheduled tasks, search by meaning, Google Drive and video steps have names in all five languages instead of the tool's name.
- Server log: stopping an answer while it streams (Codex or Claude) writes one info line, like stopping one that waits; the sub-agent line shows the token count instead of `[redacted]`.

## 0.2.11 — 2026-10-30

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.11).

**Upgrade note:** no database migrations in this release (the schema reader level stays 4). `MYCEL_HWP_PREVIEW` no longer does anything; you can remove it from the environment file. Linux servers no longer use tesseract: new installs do not install it, and a copy that is already installed is not used.

- HWP Preview is available: the first official plugin, cleared by the founder on 2026-10-30 (the font-width tables inside rhwp are accepted as a known risk while edwardkim/rhwp#8387 is open). An owner or admin installs it from Admin > Plugins > Official plugins > Install; the server downloads the pinned build for its platform from `https://updates.trina.app` (so it needs outbound https there), checks it and shows the permission prompt. Hosted servers, self-installed servers and office Macs all install it this way; a self-installed server or office Mac without internet access can take the same file through Install from file or `<data folder>/plugins/import/`. It runs on macOS (Apple silicon and Intel), Ubuntu 24.04 and Debian 13; Linux with glibc older than 2.39 (Debian 12) shows "Not supported on this server" and downloads nothing. Turning the plugin on is the only switch. HWP/HWPX text reading, search, original downloads and the write guard stay built in without the plugin.
- The AI sees images and PDF pages, like Claude Code's Read: photos, screenshots and other images reach the AI as images, and a PDF is read by pages (at most 20 per read; a page without a text layer, such as a scan, comes as a page image). On by default; owners and admins can turn it off in Admin > Team settings > "Send images and PDF pages to the AI". Images go to the AI provider like other file content. Linux servers no longer run OCR, so scanned documents and photos are not text-searchable there; a Mac server keeps Apple Vision for the search index of scanned PDFs.
- Chat: while the AI waits for the answer to its question, sending from the message box answers it (the typed text, plus what is ticked on a several-answers card) instead of waiting until the answer is done; the box says so. The server's own safety checks still take only their buttons, and the server now refuses any other answer to them.
- Chat: a step that was still running when an answer paused at its time limit shows as paused, not as a failed step.
- Plugins: official plugins no longer need a separate plugin signing key. The official list in each signed release pins each official package's manifest digest per version and platform; a matching package shows as Official (matches the official list). A later release can withdraw a build: it is turned off at start and refused. The plugin package and list format is frozen as schemaVersion 1. The server reads the official list only from its verified version folder. Korean Admin > Plugins and HWP texts now use 해요체, and the install prompt says that optional permissions start ticked. See docs/PLUGINS.md.

## 0.2.10 — 2026-10-30

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.10).

**Upgrade note:** migrations 318–320 raise the schema reader level to 4. After the update, 0.2.9 cannot open the database. Roll back only from a backup that you made before the update.

- Settings > Apps: a guide shows how to install Trina as an app (PWA) on phones and computers (#9).
- Skills: a skill in a skills/ subfolder is visible only to people who can read that folder. Personal skills live in users/<me>/skills/ and only the owner sees them; they come first in the prompt skill index (#10).
- Chat: when a long conversation reaches the AI only in part (a fresh session gets 40,000 characters of history), the newest answer says so in a small note. Migration 213 (reader 1).
- Chat: an answer that reaches the per-answer limit (tool calls or time) pauses with "이어서 하기" instead of ending as an error; the AI is told where it stopped. Migration 212 (reader 1).
- Chat: messages typed while an answer runs wait under the conversation (edit or remove them) and are sent together when the answer is done; Stop keeps them, paused, with "Send now".
- Add plugins (Admin > Plugins, company scope, owners/admins): signed packages with a permission prompt, install from a file or the official list, turn on/off, update, roll back, remove, all audited. HWP preview becomes the first plugin and still needs its release gate; HWP text reading and the write guard stay built in. Default release bundles carry no renderer or plugin package. See docs/PLUGINS.md.
- Third safe-ops review: retain direct search for empty quarantine ledgers with a durable first-publication guard; bind Office search caches to source/text hashes. Migration 320 requires reader 4. Existing quarantined tenants retain immutable input admission.

### Safe operations 1A — second review fixes

- Admit immutable, hash-leased search inputs before raw/CP949 ripgrep, Office sidecar search and semantic embedding; keep quarantine active with the feature off.
- Narrow policy epoch UPDATE triggers to changed authority fields; keep revocation/restore detection while excluding session and sync accounting. New migrations 318–319 require reader 3.
- Document bounded search snapshots, conflicting-registration retry and offline crash-lease recovery. Independent release approval remains pending.

- Security re-review: exclude quarantined files from semantic ingestion and historical browser previews; index durable safe-ops lookups. Require explicit versioned reads of grep-only sources before publication.

- Safe operations 1A review fixes (default off): generated files are download-only; native no-replace publication,
  durable approval/source/cleanup records, fail-closed workflow budgets and Linux openat2 mount-safe sources.
  ko/en/id/ja/es quarantine notices; older schema readers must restore matching pre-enable DB and files to roll back.

- Safe operations 1A (opt-in, qualified Linux): image pixels with OCR fallback for Claude Code/Codex, bounded PowerPoint with bundled layouts, fresh delivery authorization, and isolated output validation. Uploaded templates, ZIP and the new Excel writer remain deferred.
- Fix desktop worker startup so offline recovery can initialize without hanging; retain the browser frame security checks.

- Refresh the desktop team name and identity after sign-in even when an earlier anonymous lookup is still pending.

- Keep experimental HWP previews disabled and exclude their native runtime from default release bundles pending licence/platform review; document Debian 12 availability in System and installation guidance. Restrict HWP macOS file reads to runtime and authorized job inputs.

- Add guarded HWP/HWPX server PNG previews and the AI `hwp_render` page tool, with pinned engine/fonts and original downloads.

- Add Japanese (日本語) and Spanish (Español) across the app, notifications, offline recovery and desktop, with localized dates and numbers.
### Team-first onboarding / 팀 중심 도입 안내

- Team leads get matching EN/KO/JA/ES entry pages, role examples, realistic permission boundaries and hosted/self-host choices. / 팀장용 4개 언어 안내·업무 예제·권한 경계·호스팅과 직접 설치 경로.
- Evaluators can run `bun run demo` for a loopback-only, model-free fictional team with six loadable starter skills. / 한 명령으로 AI를 끈 가상 팀·스킬 체험.
- Administrators get corrected release filenames, EN/KO Linux/office guides and backup/restore instructions. Both office guides travel with the next ZIP; PDFs are optional. / 파일명 수정·영한 운영 안내·복구 안내, 다음 ZIP에 두 언어 사무실 가이드 포함.
- Connection notices distinguish the existing default-on setting from provider authorization. No default is changed. / 기본 켜짐과 제공사 사용 허가를 구분하며 설정 기본값은 바꾸지 않습니다.

Real AI screenshots and full replacement-host recovery still need authorized operational validation. HWP preview remains off and its release gate is unchanged. These source changes do not publish new installers. / 실 AI 화면·새 장비 전체 복구는 별도 검증이 필요합니다. HWP 미리보기는 기본 꺼짐과 기존 출시 조건을 유지하며, 이 소스 변경만으로 새 설치 파일을 배포하지 않습니다.

## 0.2.9 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.9).

- Files: search the contents of files (text, PDF and Office through the text cache, Korean CP949 too) with the same
  permissions as the person. Office documents that are not indexed yet are indexed in the background, fairly per person.
- Files: HEIC/HEIF photos from iPhones show in the preview (converted on the server, with limits per person).

## 0.2.8 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.8).

- Shared subscriptions are on by default. One team connection that an admin adds lets the whole team use the AI; a
  person who adds their own connection uses it first.
- The note on the shared-subscription setting is shorter and easier to read.

## 0.2.7 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.7).

- Files: a file that has no preview (HWP, HWPX, ZIP and others) opens a panel with a notice and a Download button. It
  does not download at once. Spreadsheet previews say when only the first 5,000 rows show, and mark hidden sheets.
- The AI reads Word headers, footers and comments, PowerPoint speaker notes and chart values, and Korean CP949/EUC-KR
  text files. The AI does not edit a file in a legacy encoding; it can write a UTF-8 copy.
- New chat home shows the team's popular skills.
- Chat titles hide key-like strings such as test API keys.
- The AI tries the write when a folder is read-only, so the server can offer "save in my folder".
- Admin: Korean texts use one name for the owner role; Activity log date filter; owner transfer.
- Team skills: warnings for a broken SKILL.md or a name that does not match its folder; skill suggestions stay in
  the notification inbox.
- make_file xlsx: a cell that starts with "=" and parses as a formula becomes a formula (unsafe functions and external
  links are refused). Artifacts offer "ask the AI to fix it" for build errors too.

## 0.2.6 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.6).

- Linux installer: `--public-host HOST` (the team's public address, for example a Cloudflare Tunnel),
  `--app-connectors` (people connect their own Claude to the server) and `--google-drive-client FILE` (the Google
  Drive OAuth client, in the JSON format that Google Cloud downloads). `repair` and `update` keep the first two.
- App connectors can now be turned on in `server.json` (`appConnectors: true` with `tunnel.host`). The environment
  variable `MYCEL_REMOTE_MCP_ORIGIN` still works and wins.
- Linux: after an update, AI turns had no team tools (files, memory, Drive) until the launcher restarted. The launcher
  now finds the current team-tools bridge for each turn.
- Usage: amounts are labelled as an estimate of the equivalent API cost, not a bill. Each row shows its share in
  percent, and the shares add up to 100%.
- Chat: when the AI model refuses and the turn retries with another model, only the retry's answer stays.
- Chat: the "save in my folder" button after a read-only refusal puts a draft in the composer and does not send it.
- Chat: the notice about a refused write shows only text in the person's language.
- Dialogs opened from a menu (files, chats, credentials) give the focus back to the menu button when they close.
- Members: a cancelled invite leaves the list at once.
- Desktop and web: the offline page uses the person's language.
- Admin › AI engines: Codex shows the version of the CLI that the turns really run.

## 0.2.5 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.5).
The first release that servers get through the Trina update feed (`updates.trina.app`).

- Spreadsheets and Hangul files (xlsx, xls, ods, hwp, hwpx) are read in a separate, limited process. A crafted file
  can no longer slow down or stop the server.
- A stored key or token of the person is hidden as `[hidden key]` in AI answers, steps, chat titles and exports.
- PowerPoint files from the AI: the slide count and speaker notes are checked against the request.
- File history shows who made each version, the current version, and moves and renames.
- Scheduled runs show their real outcome: succeeded, finished with problems, or failed. Problem runs send the
  failure notification.
- Admin › Team settings: the number of days that deleted chats stay in the chat trash.
- API engine: correct cost, clearer errors, status check and label.
- App connector (remote MCP): `upload_file` and `create_upload_link` for uploads from Claude Code and other clients.
- Desktop and admin fixes from QA.

## 0.2.4 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.4).
Also on the Trina update feed since 2026-10-29.

- Voice input is now optional and off by default. Admins choose it in Admin › Team settings › Voice input: OpenRouter
  speech-to-text (cloud, `openai/whisper-large-v3-turbo`, zero data retention requested) with the team's own OpenRouter
  API key, or local whisper on the server (private). Members do not see the mic while voice input is off.
- Upgrade note: teams that used local whisper choose "On this server" once.

## 0.2.3 — 2026-10-29

[Published release and notes](https://github.com/trina-app/trina-ax/releases/tag/v0.2.3).
Available on GitHub Releases only; the Trina update feed is not live. Assets include Linux kits (amd64/arm64),
a Mac office server ZIP, the Windows installer, SHA256SUMS and its signature. There is no Mac desktop DMG.

- Personal and team external-service connections: MCP servers and HTTP APIs, with access rules and write approval.
- File operations: select multiple files; AI tools to move, copy and rename files of any type.
- Chat titles generated after the answering AI's response, and team logos used as the tab icon.
- PDF preview data files included for scanned pages and Korean text with non-embedded fonts; WebM previews retain video tracks.
- Clearer scheduled-task dates and one-time task behavior; validation of automatic update windows.
- Language and usability fixes for chat errors, push notifications, offline reloads, keyboard focus, name validation and deletion guidance.
- Codex local-login startup improvements, stricter integration secret handling and write approvals, and renewed identity/file-audience checks.
- Nested PowerPoint distribution notices included. Incomplete voice-provider selection was reverted before this version.

See [design and validation records](docs/DECISIONS.md) for implementation details.

## 0.2.2 — 2026-10-28

[First public release](https://github.com/trina-app/trina-ax/releases/tag/v0.2.2).

- Linux server kits for amd64 and arm64, Mac office bundle, Windows desktop installer, and release checksum/signature files.
- Failed sign-ins from a shared address no longer lock out the whole team.
- Desktop in-app browser cookies and allowed sites are scoped to one person and cleared on sign-out or account changes.
- PowerPoint previews use `@aiden0z/pptx-renderer` (Apache-2.0).
- Linux PDF/Office text extraction works under the systemd service.
- Trina branding, Signal Orange colors and application icons.

The Mac desktop DMG is not included: Apple signing and notarization are pending. Release checksum signatures are
separate from operating-system application signing.
