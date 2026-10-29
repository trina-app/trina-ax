# Frequently asked questions

## Who is Trina AX for?

Company IT teams and developers who want a shared AI workspace over company files, with folder access checked for
the person making the request. The user interface supports English, Korean and Indonesian; PDF, Office and HWP/HWPX
reading are useful for teams working with Korean business documents.

## What is included in this repository?

The team server, web and desktop clients, native helpers, relay, mobile source and Trina branding.
The hosted service's billing, provisioning, operations console and website are private. The software license and
component exceptions are described in [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

| Choice | Server operator | Where to start |
|---|---|---|
| Self-host on Linux | Your company manages the machine, updates, backups and access | [Linux guide](INSTALL-LINUX.md) |
| Self-host on an office Mac | Your company keeps the Mac running and manages installation and backups | [Office guide](OFFICE.md) |
| Trina hosting | Trina operates the hosted service; agree service details with Trina | [Product site](https://ax.trina.app) |

## Do team members install an AI CLI?

The Claude Code and Codex CLI engines run on the team server. Members can use a web browser. In managed
installations, the owner configures team connections. Personal AI connections are enabled by default and the owner
can disable them; sharing one subscription across members is disabled by default. Development mode uses the Mac OS user's local CLI logins. Personal external-service integrations are also enabled by default, with a separate admin setting. The experimental API engine uses a team-configured OpenAI-compatible endpoint.

## Does self-hosting mean files never leave the network?

Files and chats are stored on the team server, but context used for an answer is sent to the selected model
provider. External-service tools send requests to the configured service. Server administrators can read the
stored data. See [SECURITY.md](../SECURITY.md).

## Which clients can I use?

Web, Windows desktop, Mac desktop source and mobile web. Check [Releases](https://github.com/trina-app/trina-ax/releases)
for available installers. A Mac desktop DMG is not distributed yet, pending signing and notarization. The Mac office
ZIP is a server bundle. Mobile source in the repository does not imply an App Store or Play Store release.

## Will every document or model work?

No. HWP/HWPX support is read-only text extraction, with no preview or creation. Images are read through OCR only,
not visual scene understanding. Extraction depends on document structure, fonts and installed conversion/OCR tools. The experimental API
engine needs compatible streaming Chat Completions and tool calls, and behavior varies by model/provider.
AI answers should be checked against the source documents.

## Are automatic updates available?

Yes. The Trina update feed (`https://updates.trina.app`) is live since 2026-10-29. v0.2.5 is the current release, on
GitHub Releases and on the feed. Linux servers apply app-only releases by themselves in the update window. Releases
that change root parts are applied by `mycel-update.timer` daily, or at once with `sudo mycel-ctl update`. Office Macs
check the feed nightly; `teamax update now` installs at once. There is no Mac desktop DMG yet.

## Where should I ask for help?

Use [Issues](https://github.com/trina-app/trina-ax/issues) for reproducible problems and suggestions, in English or
Korean. Check the [installation guide](INSTALL.md) first for setup problems. Report security concerns privately
using [SECURITY.md](../SECURITY.md). Discussions are not currently enabled; there is no dedicated discussion link.
