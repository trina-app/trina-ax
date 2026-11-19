// Voice input on this Mac (docs/decisions/20261119-mac-dictation.md): Apple's SpeechAnalyzer with a SpeechTranscriber
// (macOS 26, Apple silicon), on the device, nothing sent anywhere. The desktop app (desktop/src/main/dictation.ts)
// runs one of these per recording or check, as its own child process:
//   dictation probe   --language ko   one line: available, the locale it would use, whether its model is installed
//   dictation install --language ko   the locale's model from Apple (AssetInventory): progress lines, then installed
//   dictation listen  --language ko   stdin: 16 kHz mono signed 16-bit little-endian sound, as it is recorded; stdout:
//                                     ready, then text lines (final: false is a guess that the next line replaces,
//                                     final: true is kept), done after stdin ends
// Every stdout line is one JSON object with an "event". Errors are {"event":"error","code":…} and exit 1. The sound
// is only read from stdin; this program never opens the microphone and keeps nothing.
@preconcurrency import AVFoundation
import Foundation
@preconcurrency import Speech

let out = FileHandle.standardOutput
let outQueue = DispatchQueue(label: "dictation.out")
func emit(_ o: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
  outQueue.sync { out.write(d); out.write(Data([0x0A])) }
}
func fail(_ code: String, _ message: String = "") -> Never {
  emit(["event": "error", "code": code, "message": message])
  exit(1)
}

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
let command = args.count > 1 ? args[1] : ""
// the app's language (en, ko, ja, zh, es, id …): two or three letters, nothing else reaches Locale
let language = (arg("--language") ?? "en").lowercased()
guard language.range(of: "^[a-z]{2,3}$", options: .regularExpression) != nil else { fail("language", "bad language") }

/** each app language's usual region, when the Mac's own languages name none for it */
let defaults: [String: String] = ["en": "en-US", "ko": "ko-KR", "ja": "ja-JP", "zh": "zh-CN", "es": "es-ES", "fr": "fr-FR", "de": "de-DE", "it": "it-IT", "pt": "pt-BR"]

@available(macOS 26.0, *)
func resolveLocale() async -> Locale? {
  let supported = await SpeechTranscriber.supportedLocales
  let ids = Set(supported.map { $0.identifier(.bcp47) })
  // the Mac's own language list first: a British Mac set to English keeps en-GB
  for p in Locale.preferredLanguages {
    let l = Locale(identifier: p)
    guard l.language.languageCode?.identifier == language, let region = l.region?.identifier else { continue }
    let id = "\(language)-\(region)"
    if ids.contains(id) { return Locale(identifier: id) }
  }
  if let d = defaults[language], ids.contains(d) { return Locale(identifier: d) }
  if let m = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)),
     m.language.languageCode?.identifier == language { return m }
  return nil
}

@available(macOS 26.0, *)
func transcriber(_ locale: Locale) -> SpeechTranscriber {
  // volatile results: the words while the person talks; fast results: about every second, not at the end
  SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [.audioTimeRange])
}

@available(macOS 26.0, *)
func installed(_ t: SpeechTranscriber) async -> Bool {
  await AssetInventory.status(forModules: [t]) == .installed
}

@available(macOS 26.0, *)
func probe() async {
  guard SpeechTranscriber.isAvailable else { emit(["event": "probe", "available": false]); return }
  guard let locale = await resolveLocale() else { emit(["event": "probe", "available": true, "supported": false]); return }
  let t = transcriber(locale)
  emit(["event": "probe", "available": true, "supported": true, "locale": locale.identifier(.bcp47), "installed": await installed(t)])
}

@available(macOS 26.0, *)
func install() async {
  guard SpeechTranscriber.isAvailable else { fail("unavailable") }
  guard let locale = await resolveLocale() else { fail("unsupported") }
  let t = transcriber(locale)
  do {
    if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
      let progress = req.progress
      let watch = Task {
        var last = -1
        while !Task.isCancelled {
          let pct = Int((progress.fractionCompleted * 100).rounded(.down))
          if pct != last { last = pct; emit(["event": "progress", "percent": pct]) }
          try? await Task.sleep(nanoseconds: 250_000_000)
        }
      }
      try await req.downloadAndInstall()
      watch.cancel()
    }
  } catch {
    fail("assets", "\(error)")
  }
  guard await installed(t) else { fail("assets", "not installed after the download") }
  emit(["event": "installed", "locale": locale.identifier(.bcp47)])
}

/** stdin's bytes as whole 16-bit samples, on their own thread (a read blocks) */
final class StdinReader: @unchecked Sendable {
  func run(_ onChunk: @escaping (Data) -> Void, _ onEnd: @escaping () -> Void) {
    Thread {
      var carry = Data()
      while true {
        let d = FileHandle.standardInput.availableData
        if d.isEmpty { break }
        carry.append(d)
        let whole = carry.count & ~1
        if whole > 0 {
          onChunk(carry.prefix(whole))
          carry = Data(carry.dropFirst(whole))
        }
      }
      onEnd()
    }.start()
  }
}

@available(macOS 26.0, *)
func listen() async {
  guard SpeechTranscriber.isAvailable else { fail("unavailable") }
  guard let locale = await resolveLocale() else { fail("unsupported") }
  let t = transcriber(locale)
  guard await installed(t) else { fail("assets", "the model for \(locale.identifier(.bcp47)) is not installed") }
  let analyzer = SpeechAnalyzer(modules: [t])
  let input = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t], considering: input) else { fail("format") }
  let converter = format == input ? nil : AVAudioConverter(from: input, to: format)
  if format != input && converter == nil { fail("format", "\(format)") }

  let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
  let results = Task {
    for try await r in t.results {
      let text = String(r.text.characters)
      let range = r.range
      emit(["event": "text", "final": r.isFinal, "text": text,
            "start": CMTimeGetSeconds(range.start), "end": CMTimeGetSeconds(CMTimeRangeGetEnd(range))])
    }
  }
  do {
    try await analyzer.prepareToAnalyze(in: format)
    try await analyzer.start(inputSequence: stream)
  } catch { fail("start", "\(error)") }
  emit(["event": "ready", "locale": locale.identifier(.bcp47)])

  var at: Int64 = 0
  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    StdinReader().run({ data in
      let n = data.count / 2
      guard n > 0, let b = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: AVAudioFrameCount(n)) else { return }
      b.frameLength = AVAudioFrameCount(n)
      _ = data.withUnsafeBytes { raw in memcpy(b.int16ChannelData![0], raw.baseAddress!, n * 2) }
      var buffer = b
      if let c = converter {
        let cap = AVAudioFrameCount(Double(n) * format.sampleRate / input.sampleRate) + 64
        guard let o = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return }
        var given = false
        var err: NSError?
        c.convert(to: o, error: &err) { _, st in
          if given { st.pointee = .noDataNow; return nil }
          given = true; st.pointee = .haveData; return b
        }
        if err != nil { return }
        buffer = o
      }
      feed.yield(AnalyzerInput(buffer: buffer, bufferStartTime: CMTime(value: at, timescale: CMTimeScale(format.sampleRate))))
      at += Int64(buffer.frameLength)
    }, { done.resume() })
  }
  feed.finish()
  do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { fail("finish", "\(error)") }
  _ = try? await results.value
  emit(["event": "done", "seconds": Double(at) / format.sampleRate])
}

// the app stops a recording that is cancelled with SIGTERM: nothing to save, just go
signal(SIGTERM) { _ in exit(0) }
signal(SIGPIPE, SIG_IGN)

Task.detached {
  guard #available(macOS 26.0, *) else {
    if command == "probe" { emit(["event": "probe", "available": false]); exit(0) }
    fail("unavailable", "macOS 26 or later")
  }
  switch command {
  case "probe": await probe()
  case "install": await install()
  case "listen": await listen()
  default: fail("usage", "dictation probe|install|listen --language xx")
  }
  exit(0)
}
dispatchMain()
