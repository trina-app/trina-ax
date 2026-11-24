# The promo video's MP4 is made on Linux team servers too, in the converters' isolation

- Date: 2026-11-23
- Status: accepted
- Supersedes: the "Linux team server: not in this round" handoff of [V — The first result is the company's promo video](../DECISIONS.md#v--the-first-result-is-the-companys-promo-video-featonboarding-video-2026-11-06), and the "Where" line of [The promo video saved as a file](20261116-save-promo-video.md)
- Branch: fix/linux-video-mp4 (the owner's P1, PR #423 F11: "세션을 공유해서 다른 사람이 볼려고했는데 안나오고 다운로드도 안되는데")
- Area owner: DECISIONS "V" puts the Linux render in the srt dev environment image (another developer). The owner wanted
  it fixed now; this change does it without srt (below), and the srt queued-job design stays open to that owner.

- **Ask:** on a Linux server (potenlab.trina.app, every hosted team) a promo video showed beside the chat, but nobody got
  [영상 파일로 받기], not the person who asked and not the people the chat was shared with, and the AI could not save or
  send it as a file. The MP4 was made only on a development Mac.
- **Rule:** a Linux team server (hosted, `install-linux.sh`, Docker with the video group; any mode) makes the MP4 when it
  has the list's video group: node in `/opt/trina/node` and the pinned HyperFrames CLI in
  `/opt/trina/hyperframes/current`, with the browser group's chrome-headless-shell and the media group's ffmpeg
  (`promo-video/render.ts renderTools`). Everyone who may open the chat (its owner, a shared chat's people, a project
  chat's members, each while they may open every picture in it: unchanged `rowFor`) gets the button; `save_promo_video`
  and sharing to a room send the MP4.
- **Isolation:** the CLI runs in the converters' isolation (`isolatedCommand`: bwrap, no network, the system read-only,
  only its work folder writable; HOME and TMPDIR there), the tree, node's folder and the browser's folder bound
  read-only, never as root (HyperFrames starts Chrome with `--no-sandbox`: bwrap is its sandbox, as for HTML to PDF).
  node, the CLI tree and its entry file must be root's or the server's and writable by nobody else, by their real paths
  (`trustedPath`); packages.sh installs the tree root's with `chmod -R go-w` and runs its version check as nobody.
  The page is built from the checked slots as before (no script; pictures copied with the chat owner's permissions).
- **Limits:** one render at a time on the server (as before), `--workers 1`, 8 minutes on Linux (4 on a Mac). In
  production a cgroup `S/video` beside `S/print` (`system/cgroups.ts`, in a try of its own so a failure there leaves the
  other limits): 1280 MiB, 256 tasks, swap off, two cores at most and `cpu.weight` 50 (it yields when the CPU is busy), each
  render in a leaf of its own killed together (`memory.oom.group`, `cgroup.kill`), the CPU-time limit counted for every
  core. Measured in a Debian 13 arm64 container (4 cores): one worker 80–83 s, memory.peak 1055–1076 MiB, 120 tasks; it
  finished under a 1024 MiB limit and failed under the print's 768 MiB; two workers 54 s and 1739 MiB. `S/video` exists
  when the plan's (or the machine's) memory is 3584 MiB or more: a 4 GiB team VM yes, the free plan's 2 GiB no.
- **Where it cannot:** the info says why (`mp4.why`: `not_installed` before the update installs the tools,
  `too_small`, `unsupported` for an office or production Mac, a server without bwrap, or the headless browser turned off
  with `MYCEL_HTML_PDF_BROWSER=none`) and the panel shows one short muted line in its place (on a phone an info button
  that says it), in the six languages; the AI's result and `save_promo_video`'s refusal give the same reason.
  Never a silent missing button.
- **Install:** the one list (`scripts/system/packages.json`): group `video` (install `default`: every default install and
  the hosted image, not `--minimal`; xz-utils to unpack node) with the artifacts `node` (the srt group's pin) and
  `hyperframes` (the npm tarball's url, sha256 and size; `npm ci --ignore-scripts --omit=dev` from
  `scripts/promo-video/hyperframes/package-lock.json`, which pins it and every package under it by integrity).
  `packages.sh` `pk_node_install` (the srt layout, so install-srt.sh finds it) and `pk_video_prepare` /
  `pk_video_install` (a tree per pin `<version>-<lock sha12>`, `current` only to a tree whose CLI answers the pin, the one
  before kept until the next switch). Called by `packages.sh sync` (`mycel-ctl update`: every existing Linux server,
  hosted ones included; the lock is read from `<base>/root/hyperframes/`), by `install-linux.sh` (built before the
  server stops, switched after; the image's customize.sh runs it) and by the Docker image with
  `TRINA_AX_PACKAGE_GROUPS="fonts browser video"`. The lock ships as root files, so a changed lock is a root change.
  `uninstall-srt.sh` keeps node while `/opt/trina/hyperframes` is there. install-srt.sh keeps its own node step (its
  `--boot` mode downloads nothing); both write the same folder and link from the same pin.
- **Size:** about 120 MB for the CLI tree and 200 MB for node (shared with srt) per Linux server.
- **Not done:** the srt queued-job route of V's handoff; the office Mac (no isolation for it there); room shares wait
  100 s for a render that is still running (the HTTP idle limit), so on a slow machine the first share may still go as
  the page, as before, and says so.
- **Tests:** `tests/unit/system-packages.test.ts` (the group, the pin agreeing with the lock, package.json and the server,
  the root files, install-linux.sh building before the stop, the Docker argument, `pk_video_install` with a stand-in
  node and npm: a tree that does not answer is never switched to), `tests/unit/g-cgroups.test.ts` (S/video and its
  leaf), `tests/unit/b-promo-video.test.ts` (`renderTools` and every reason; on Linux with bwrap a stand-in CLI run
  isolated, the team folder out of its reach, the person the chat is shared with downloading), `web/test/unit/promo-mp4.test.tsx`
  (the line instead of the button). A real check on a Debian 13 QA copy in Docker with claude-code: see the PR.
- **Version impact:** minor (a new capability on every Linux server), and a root update (the list and the lock changed).
