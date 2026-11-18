# The speech model is downloaded ahead of first use; a read waits for it and never sends the person to voice input

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "model on first use" part of [20261116-mac-local-speech.md](20261116-mac-local-speech.md) ("nothing is
  downloaded when the kit is installed", "Linux reads still never download it")
- Branch: feat/audit2-files (second limits audit item 7, QA TC-4919)

- **Ask:** on an Office Mac the first recording an AI read met the 488 MB speech model still downloading, and the AI
  told the person to "use voice input once (even a short test) and then ask me again". 20 minutes later the same ask
  worked. Never send the person to do it by hand; have the model ready, or wait for it.
- **Rule: the server fetches the model itself** (`server/src/jobs/model-prefetch.ts`, started in `main.ts`). Wherever
  the team's speech provider reads "this server" (`local`: an Apple silicon Mac with whisper-cli while nothing else is
  chosen, or a server an admin set to it) and whisper.cpp is installed, the server downloads the model one minute
  after it starts, and looks again every 10 minutes (an admin switched to local, or a download failed). A failed
  download waits 5 minutes, then twice as long each time, up to 6 hours, so a server without internet does not retry
  all the time. One download at a time, sha256 checked: the same `ensureModel` voice input and reads use.
  `MYCEL_SPEECH_PREFETCH=0` turns it off. Nothing is downloaded where speech is off or goes to OpenRouter.
- **Rule: a read that meets the download waits for it** within its time, keeping a minute for the sound, as before;
  now on any server, not only a Mac (with the prefetch the download is usually done long before). When it is not done
  in time, the read says how far it is ("The speech model (about 488 MB, needed only the first time) is still
  downloading (230 MB so far) …") and tells the AI to read the file again at once (that read waits again) and never to
  ask the person to do anything. When the last try failed, the read says the server tries again by itself and the AI
  offers to try again in a few minutes. The words "use voice input" are gone from both notes.
- **Why not a live progress bar in the step:** a tool step has no progress channel to the app today; adding one is a
  change to the chat protocol and the web app for one rare state. The read's text carries the progress, and the
  prefetch makes the state rare.
- **Not changed:** voice input's own first-use progress; the hosted servers' OpenRouter path; the model choice.
- Tests: `tests/unit/model-prefetch.test.ts` (when it runs, the back-off, the switch), `tests/unit/media-read.test.ts`
  (the notes, no "voice input", one try per pause). Version impact: minor.
