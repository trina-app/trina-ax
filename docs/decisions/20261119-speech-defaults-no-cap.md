# Speech-to-text defaults by server, and no per-read cap on a recording

- Date: 2026-11-19
- Status: accepted
- Supersedes: the defaults of docs/DECISIONS.md "AI reads video and audio" (on for this server above 2 cores, off for
  OpenRouter with the team's key) and its hosted cap (founder Q8: 2 minutes of new sound a read); the one media read at
  a time of the same entry
- Branch: fix/speech-defaults-no-cap (the owner, QA TC-5004, TC-4987; limits audit #12 and N19)

- **Ask (A):** turning the sound of video and audio into text is on by default on hosted servers and on the Mac app
  (whisper runs there), and on a Linux self-install or the Docker image when the machine has at least 4 CPU cores and
  8 GB of memory; off on a smaller self-installed server. An admin's explicit choice stays.
- **Rule (A):** `mediaTranscriptsDefault(provider, { hosted, mac, bigEnough })` in shared/src/api/entities.ts, the one
  place the default lives: on when hosted (a plan, the hosted deployment, or the hosting service's speech key, which
  only hosted servers keep), whatever provider works there; on for "On this server" on an Apple silicon Mac or with
  `localSpeechBigEnough` (4 cores and 7.5 GiB, so an "8 GB" machine that reports less still counts); off otherwise,
  also for OpenRouter with the team's own key on its own server (that sends team files' sound to a third party the
  team did not pick for it). The cores are the plan's or the machine's; inside a container the cgroup v2 `cpu.max` and
  `memory.max` at the root it sees count (system/limits.ts `containerLimits`), never the server unit's
  `MemoryMax=75%`. Only `aiMediaTranscripts: null` follows the new rule: a stored choice, on or off, is kept.
- **Voice input's provider (A):** a server with whisper-cli and ffmpeg (the Linux kit and the Docker image carry both)
  and 4 cores and 8 GB now reads `local` while no admin chose a provider, like the Apple silicon Mac before
  (jobs/transcribe.ts `localSpeechReady`, main.ts). A saved OpenRouter key still wins. The model is fetched ahead
  (jobs/model-prefetch.ts), as for every `local` server.
- **Ask (G):** no 2-minute cap. The whole file is transcribed, in the background when needed; the AI waits for the
  result or reads on as parts finish. The only limit is the plan's speech-to-text hours; when they run out, say so
  plainly, how to get more, and keep the text made so far. More media reads at once on bigger servers.
- **Rule (G):** `HOSTED_LOCAL_NEW_SEC` and the `slow` note are gone. When a read stops for its time (or a connection's
  minute, or voice input holding whisper.cpp), or reached its 10/30-minute span before the end of the part asked for
  (the whole file without `time`), the rest of that part is transcribed in the background (FileService
  `fillTranscript`) by the same `mediaTranscript`, so every check before each piece holds as in a read: the switch and
  provider, a confidential lock, the plan's hours, the person's access to the file (and never for a guest). It keeps
  the read's work folder (the file copy) and drops it when done; each run has an audit row with `background: true`.
  One per file (a later read moves its end), at most `mediaParallel()` at once; Stop of the turn ends it; it tries
  again after voice input or other pieces held whisper.cpp, up to 12 times without progress. Pieces being made are
  shared (`piecesMaking`): a read of a piece the background is making waits for it in its own time, so no piece is
  made twice. The read says "The sound from X to Y is still being turned into text in the background"; reading on
  picks up what is done.
- **Hours used up:** the note says the month's speech-to-text allowance (the plan's hours) is used up, how far the
  text goes (`freeUsedPart`, the text is kept), that it comes back on the 1st, and that the team owner can change the
  plan (Starter 50, Team 100, Business 200 hours) or an admin can add the team's own OpenRouter key.
- **Parallel reads:** `mediaParallelFor(cores, memory)` = one per 2 cores and per 2 GB, 1 to 8 (a 2 vCPU / 4 GB box
  keeps one). whisper.cpp pieces: `pieceSlots()` = cores over whisper.cpp's threads, at most one per 2 GB, at least 1;
  voice input still stops them all and runs alone; a piece that waited on other pieces (not voice input) ends that
  read with "time" (the background goes on), not "voice input is using it".
- **Claude Code check:** Claude Code has no transcription; a user would run whisper over the whole file. The plan's
  hours are a cost limit of the hosting service, not a cut of what one read may do.
- **Left out:** Windows. The Windows app is a desk client (it runs no team server), so whisper there needs the PC
  runner path; that is its own piece of work (see the PR report).
- **Tests:** tests/unit/media-read.test.ts (defaults by server, 3 cores now off, a container's limits, no hosted cap,
  background fill to the end, a read waiting for a piece in progress, a `time` part filled only to its end, Stop and
  switching off end it, parallel reads and whisper slots), tests/unit/c-speech-hosted.test.ts (hosted with the team's
  key on by default, the allowance notes), tests/unit/mac-audio.test.ts (`localSpeechReady` on Linux), web
  media-transcripts-switch and admin e2e.
