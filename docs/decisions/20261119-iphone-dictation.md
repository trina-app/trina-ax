# The iPhone app transcribes voice input on the iPhone itself, as the Mac app does

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (the phone follow-up of [20261119-mac-dictation.md](20261119-mac-dictation.md); the team server's
  way, [20261119-voice-input-latency.md](20261119-voice-input-latency.md), stays the fallback)
- Branch: feat/ios-dictation (the owner, 2026-11-19, on the chat microphone and Yogurt, github.com/FrigadeHQ/yogurt:
  words while talking, on the device)

Plan: [docs/AGENTS/plan/20261119-1400-iphone-dictation.md](../AGENTS/plan/20261119-1400-iphone-dictation.md).

- **Ask:** in the iPhone app the words show in the message box while the person talks, written on the phone, as in
  the Mac app.
- **Rule:** the iPhone app 1.0.10 has its own Expo module (`mobile/modules/dictation`) and offers the bridge
  capability `dictation-v1`. The page records as before (WebKit's microphone, the one microphone question) and hands
  its 16 kHz samples to the app as signed 16-bit base64 about every 0.1 s (`dictation-push`); the words come back as
  `mycel:mobile-dictation` events for that recording, only to the document that started it. The page side is the Mac
  app's state machine (`lib/macDictation.ts`, `OnDeviceRun`, readiness per language) on a bridge of the same shape
  (`lib/mobile.ts` `phoneDictation`), so the box, Stop, Esc, the first-use download and confidential chats behave as
  on the Mac; the notes say "this phone".
- **Which recognizer, best first:**

  | phone | recognizer | question asked | model |
  |---|---|---|---|
  | iOS 26, `SpeechTranscriber.isAvailable` and the language listed | SpeechTranscriber (SpeechAnalyzer), as the Mac app | none (as on the Mac) | Apple's, fetched on the first tap (AssetInventory) |
  | iOS 26 otherwise, language in DictationTranscriber's list | DictationTranscriber (SpeechAnalyzer, keyboard dictation's model) | none | Apple's, fetched on the first tap |
  | before iOS 26, the phone already has the language's dictation model | SFSpeechRecognizer, `requiresOnDeviceRecognition` | Speech Recognition, once (NSSpeechRecognitionUsageDescription, en/ko/zh-Hans) | the phone's own (Settings › General › Keyboard › Dictation) |
  | none of these, a refused question, Android, an app before 1.0.10, a browser | the team server, as before | | |

- **When the team server transcribes instead:** as on the Mac: no module or capability, a language the phone lacks,
  the first tap for a language (that recording; the model comes down meanwhile and the bar says how far), a failed
  download (the next tap tries again), a recognizer that did not start or stopped on the way (the server for the rest
  of the page; the words already written stay), WebKit keeping the sound paused. A fence (a new page, a session reset,
  a team change) cancels the recording and is not counted as the phone's fault.
- **Where it is allowed:** everywhere the mic shows, confidential chats and Safe operations 1A included: the sound
  never leaves the phone. The team's "voice input off" still hides the mic.
- **Measured** (2026-11-19). The iOS Simulator (iOS 26.5, Xcode 26.6) cannot run Apple's speech models:
  `SpeechTranscriber.isAvailable` is false, SFSpeechRecognizer has no on-device model, and DictationTranscriber lists
  54 locales and downloads its model (Korean in about 60 s) but `bestAvailableAudioFormat` is nil and
  `prepareToAnalyze` fails with "Model not available". So the recognizers were measured on this Mac (M1 Max, macOS
  26.6.2, the same Apple models), with the app's own engine file (`DictationEngine.swift`) compiled for macOS and fed
  in real time, on the Mac decision's real read speech (60 Zeroth Korean clips from 10 speakers, 9.5 min; 73
  LibriSpeech clips, 8.0 min; Korean CER without spaces and punctuation, English WER):
  - SpeechTranscriber: 6.1% / 3.7% (the same errors as the Mac helper of #28); first words 0.98 s (ko) / 0.82 s (en)
    after the speech starts (p90 1.88 / 1.37), then the guess keeps up with the sound; every word final 0.04 s / 0.15 s
    after Stop (p90 0.07 / 0.27).
  - DictationTranscriber: 9.9% / 10.7%; first words 0.67 s (ko) / 0.63 s (en) after the speech starts (p90 1.21 /
    0.71); every word final 0.26 s / 0.21 s after Stop (p90 0.37 / 0.41). Faster than SpeechTranscriber, clearly less
    accurate (it writes "Mr." for "MISTER", splits rare names), still about the team server's whisper small in Korean.
  - The Simulator build of the app (Release, Trina edition) builds and links the module, launches, and carries the
    usage text in en/ko/zh-Hans; the bridge and the page are tested with a fake app (unit and web e2e).
- **Needs a real iPhone:** which iPhones report SpeechTranscriber available on iOS 26, the speed of both recognizers
  on a phone's chip, WebKit's samples through `getUserMedia` on a device (the Simulator takes the Mac's microphone),
  the iOS 18 path with the Speech Recognition question, memory and heat over a minute of dictation.
- **Version impact:** minor for the phone app (1.0.10, App Store, with a new native module and an Info.plist text);
  the web page part is backward compatible (an app without `dictation-v1` keeps the server's way); no server change.
- **Tests:** `tests/unit/mobile-dictation.test.ts` (the app's side: messages, ownership, fence), `web/test/unit/
  phoneDictation.test.ts` (the page's bridge, with the Mac state machine), `web/test/e2e/phone-dictation.spec.ts` (the
  composer at 390 px with a fake iPhone app: live words, first use, an older app).
