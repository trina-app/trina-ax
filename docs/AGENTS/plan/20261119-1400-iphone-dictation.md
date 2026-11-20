# Voice input on the iPhone: the phone itself writes the words while you talk

- Date (UTC): 2026-11-19 14:00
- Branch: `feat/ios-dictation` (on `batch/20261119-voice`, which carries the Mac app's dictation, PR #28 in #30)
- Status: done (App Store submission of 1.0.10 not started)
- Where: `mobile/modules/dictation/ios/` (new Expo module), `mobile/src/dictation.ts`, `mobile/src/protocol.ts`
  (`dictation-v1`), `mobile/src/bridge.ts`, `mobile/App.tsx`, `web/src/lib/mobile.ts` (`phoneDictation`),
  `web/src/lib/macDictation.ts`, `web/src/lib/useVoiceInput.ts`. Why: the follow-up section of
  [20261119-0300-mac-dictation.md](20261119-0300-mac-dictation.md).
- Version impact: phone app 1.0.10 (App Store), minor; no server change, no migration.

## Design

- **Engine** `DictationEngine.swift` (no Expo import, so a bench compiles the same file): SpeechTranscriber on iOS 26
  where available, else DictationTranscriber, else SFSpeechRecognizer on the device before iOS 26 (the decision's
  table). Locale: the phone's own region for the app language, else a usual one (ko-KR, en-US …).
- **Module** `DictationModule.swift`: check, install (progress events), start, push, stop, cancel; one recording at
  a time; a stopped recording is kept until done or an error went out.
- **Bridge** `dictation-v1`: the page's messages (`dictation-check`, `-install`, `-start`, `-push` never answered,
  `-stop`, `-cancel`), events back with `dictationEventScript` (only to the document with that nonce). Fenced with
  the file transfers and photo picks.
- **Page**: `phoneDictation()` has the desktop bridge's `dictation` shape; `macDictationBridge()` returns it inside
  the iPhone app; the notes say "this phone" (`voice.phone*`, six languages).

## Measurements (2026-11-19)

The Simulator cannot run the models (decision file), so the engine file ran on this Mac on the Mac decision's clips.

| recognizer | ko CER | en WER | first words after speech starts (ko / en) | every word final after Stop (ko / en) |
|---|---|---|---|---|
| SpeechTranscriber (this engine) | 6.1% | 3.7% | 0.98 s / 0.82 s | 0.04 s / 0.15 s |
| SpeechTranscriber (Mac helper, #28) | 6.1% | 3.7% | 1.26 s / 0.88 s | 0.37 s / 0.20 s |
| DictationTranscriber | 9.9% | 10.7% | 0.67 s / 0.63 s | 0.26 s / 0.21 s |
| team server, whisper small (#28 bench) | 10.8% | 8.3% | about 3.2-3.5 s | + the answer |

## Steps

1. Engine and bench on the Simulator (models do not run there) and on this Mac. Done.
2. Module, protocol, bridge, App.tsx; usage text; 1.0.10. Done.
3. Page bridge and wording. Done.
4. Tests: unit (app side, page side), web e2e with a fake app; Simulator Release build. Done.
5. Review, QA rows (TC-5320..5326), PR. Done.
6. Real iPhone: the decision's list; then the App Store build (scripts/ios-release.sh) with the owner's OK.
