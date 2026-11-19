// Voice input on this iPhone (docs/decisions/20261119-iphone-dictation.md): Apple's own speech recognition on the
// phone, nothing sent anywhere. The page records as always (WebKit's microphone) and hands its 16 kHz samples over the
// app's bridge (dictation-v1); this turns them into words while the person talks. No Expo import here: the bench in
// the PR compiles this same file for the iOS Simulator.
//
// Which recognizer, best first (`engine` in check):
//   analyzer   iOS 26 SpeechTranscriber (SpeechAnalyzer), the model the Mac app uses; the newer iPhones
//   dictation  iOS 26 DictationTranscriber (SpeechAnalyzer), Apple's keyboard dictation model; every iOS 26 iPhone
//   legacy     before iOS 26: SFSpeechRecognizer with requiresOnDeviceRecognition, only where the phone already has the
//              language's on-device model (Settings › General › Keyboard › Dictation); this one asks the Speech
//              Recognition question once (NSSpeechRecognitionUsageDescription)
// None of them for the language: "unsupported", and the team server transcribes, as before.
//
// Events (one per call of `emit`): text {final, text} (final false is a guess the next text replaces; true is kept),
// done (after stop: every word final), error {code}. None of these keep the sound.
@preconcurrency import AVFoundation
import Foundation
@preconcurrency import Speech

public typealias DictationEmit = @Sendable ([String: Any]) -> Void

public enum DictationEngineKind: String, Sendable { case analyzer, dictation, legacy }

/** each app language's usual region, when the phone's own languages name none for it */
private let usualRegion: [String: String] = ["en": "en-US", "ko": "ko-KR", "ja": "ja-JP", "zh": "zh-CN", "es": "es-ES", "id": "id-ID", "fr": "fr-FR", "de": "de-DE", "it": "it-IT", "pt": "pt-BR"]

/** the app language as Apple's locales take it (two or three letters), else nil */
public func dictationLanguage(_ s: String) -> String? {
  let l = s.lowercased()
  return l.range(of: "^[a-z]{2,3}$", options: .regularExpression) != nil ? l : nil
}

/** the locale of `language` among `ids` (BCP 47): the phone's own region for it first (en-GB), then the usual one */
func pickLocale(_ language: String, _ ids: Set<String>, preferred: [String] = Locale.preferredLanguages) -> String? {
  for p in preferred {
    // the older names: they read the same on every iOS this app runs on
    let l = Locale(identifier: p)
    guard l.languageCode == language, let region = l.regionCode else { continue }
    if ids.contains("\(language)-\(region)") { return "\(language)-\(region)" }
  }
  if let d = usualRegion[language], ids.contains(d) { return d }
  return ids.sorted().first { $0.hasPrefix(language + "-") }
}

public struct DictationCheck: Sendable {
  /** ready: transcribes now; needs-model: once Apple's model is on the phone (install); unsupported: no on-device
   * recognizer for this language here */
  public let state: String
  public let locale: String?
  public let engine: DictationEngineKind?
  public var dictionary: [String: Any] {
    var d: [String: Any] = ["state": state]
    if let locale { d["locale"] = locale }
    if let engine { d["engine"] = engine.rawValue }
    return d
  }
}

public enum DictationEngine {
  /** the recognizer for `language` on this phone, and whether it can start now. `only`: that recognizer or none (the
   * bench compares them on the same clips; the app never passes it) */
  public static func check(_ language: String, only: DictationEngineKind? = nil) async -> DictationCheck {
    if #available(iOS 26.0, macOS 26.0, *) {
      if only == nil || only == .analyzer, SpeechTranscriber.isAvailable,
         let id = pickLocale(language, Set(await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) })) {
        // a status of unsupported (this phone cannot run it after all) falls through to the dictation model
        let status = await AssetInventory.status(forModules: [analyzerModule(Locale(identifier: id))])
        if status == .installed { return DictationCheck(state: "ready", locale: id, engine: .analyzer) }
        if status != .unsupported { return DictationCheck(state: "needs-model", locale: id, engine: .analyzer) }
      }
      if only == nil || only == .dictation, let id = pickLocale(language, Set(await DictationTranscriber.supportedLocales.map { $0.identifier(.bcp47) })) {
        let status = await AssetInventory.status(forModules: [dictationModule(Locale(identifier: id))])
        if status == .installed { return DictationCheck(state: "ready", locale: id, engine: .dictation) }
        if status != .unsupported { return DictationCheck(state: "needs-model", locale: id, engine: .dictation) }
      }
    }
    if only != nil && only != .legacy { return DictationCheck(state: "unsupported", locale: nil, engine: nil) }
    // before iOS 26: only a language whose on-device model the phone already has, and never after a refusal
    let auth = SFSpeechRecognizer.authorizationStatus()
    if auth == .denied || auth == .restricted { return DictationCheck(state: "unsupported", locale: nil, engine: nil) }
    let ids = Set(SFSpeechRecognizer.supportedLocales().map { $0.identifier.replacingOccurrences(of: "_", with: "-") })
    if let id = pickLocale(language, ids), let r = SFSpeechRecognizer(locale: Locale(identifier: id)), r.supportsOnDeviceRecognition {
      return DictationCheck(state: "ready", locale: id, engine: .legacy)
    }
    return DictationCheck(state: "unsupported", locale: nil, engine: nil)
  }

  /** Apple's model for `language` (SpeechAnalyzer only), `progress` 0-100 on the way: installed, failed or unsupported */
  public static func install(_ language: String, only: DictationEngineKind? = nil, progress: @escaping @Sendable (Int) -> Void) async -> String {
    let c = await check(language, only: only)
    guard let id = c.locale, let engine = c.engine else { return "unsupported" }
    if c.state == "ready" { return "installed" }
    guard #available(iOS 26.0, macOS 26.0, *), engine != .legacy else { return "unsupported" }
    let module: any SpeechModule = engine == .analyzer ? analyzerModule(Locale(identifier: id)) : dictationModule(Locale(identifier: id))
    do {
      if let req = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
        let p = req.progress
        let watch = Task {
          var last = -1
          while !Task.isCancelled {
            let pct = Int((p.fractionCompleted * 100).rounded(.down))
            if pct != last { last = pct; progress(pct) }
            try? await Task.sleep(nanoseconds: 250_000_000)
          }
        }
        defer { watch.cancel() }
        try await req.downloadAndInstall()
      }
    } catch { return "failed" }
    return await check(language, only: only).state == "ready" ? "installed" : "failed"
  }

  @available(iOS 26.0, macOS 26.0, *)
  static func analyzerModule(_ locale: Locale) -> SpeechTranscriber {
    // volatile results: the words while the person talks; fast results: about every second, not at a pause
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
  }

  @available(iOS 26.0, macOS 26.0, *)
  static func dictationModule(_ locale: Locale) -> DictationTranscriber {
    // keyboard dictation's model with its punctuation, guesses while the person talks
    DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [.volatileResults, .frequentFinalization], attributeOptions: [])
  }
}

/** The sound as the page sends it: 16 kHz mono signed 16-bit little-endian. */
let pageFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

func pcmBuffer(_ data: Data) -> AVAudioPCMBuffer? {
  let n = data.count / 2
  guard n > 0, let b = AVAudioPCMBuffer(pcmFormat: pageFormat, frameCapacity: AVAudioFrameCount(n)) else { return nil }
  b.frameLength = AVAudioFrameCount(n)
  _ = data.withUnsafeBytes { raw in memcpy(b.int16ChannelData![0], raw.baseAddress!, n * 2) }
  return b
}

func convert(_ b: AVAudioPCMBuffer, _ c: AVAudioConverter?, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
  guard let c else { return b }
  let cap = AVAudioFrameCount(Double(b.frameLength) * format.sampleRate / pageFormat.sampleRate) + 64
  guard let o = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return nil }
  var given = false
  var err: NSError?
  c.convert(to: o, error: &err) { _, st in
    if given { st.pointee = .noDataNow; return nil }
    given = true; st.pointee = .haveData; return b
  }
  return err == nil ? o : nil
}

/** One recording: start, push while the page records, stop (the last words, then done) or cancel (nothing more). */
public protocol DictationSession: AnyObject, Sendable {
  func push(_ data: Data)
  func stop()
  func cancel()
}

/** Starts a recording for `language` with the best recognizer this phone has, or throws (the page then uses the team
 * server): unsupported, a refused Speech Recognition question (legacy only), or the recognizer did not start. */
public func startDictation(_ language: String, only: DictationEngineKind? = nil, emit: @escaping DictationEmit) async throws -> DictationSession {
  let c = await DictationEngine.check(language, only: only)
  guard c.state == "ready", let id = c.locale, let engine = c.engine else { throw DictationError.unsupported }
  if engine == .legacy { return try await LegacySession.start(Locale(identifier: id), emit: emit) }
  guard #available(iOS 26.0, macOS 26.0, *) else { throw DictationError.unsupported }
  let locale = Locale(identifier: id)
  return try await AnalyzerSession.start(engine == .analyzer ? DictationEngine.analyzerModule(locale) : DictationEngine.dictationModule(locale), emit: emit)
}

public enum DictationError: Error { case unsupported, denied, start }

@available(iOS 26.0, macOS 26.0, *)
final class AnalyzerSession: DictationSession, @unchecked Sendable {
  private let feed: AsyncStream<AnalyzerInput>.Continuation
  private let lock = NSLock()
  private var at: Int64 = 0
  private var ended = false
  private var cancelled = false
  private let format: AVAudioFormat
  private let converter: AVAudioConverter?
  private let analyzer: SpeechAnalyzer
  private var resultsTask: Task<Void, Never>?
  private var results: Task<Void, Never>? {
    get { lock.lock(); defer { lock.unlock() }; return resultsTask }
    set { lock.lock(); resultsTask = newValue; lock.unlock() }
  }
  private let emit: DictationEmit

  private init(analyzer: SpeechAnalyzer, format: AVAudioFormat, feed: AsyncStream<AnalyzerInput>.Continuation, emit: @escaping DictationEmit) {
    self.analyzer = analyzer
    self.format = format
    self.converter = format == pageFormat ? nil : AVAudioConverter(from: pageFormat, to: format)
    self.feed = feed
    self.emit = emit
  }

  static func start(_ module: any SpeechModule, emit: @escaping DictationEmit) async throws -> AnalyzerSession {
    let analyzer = SpeechAnalyzer(modules: [module])
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module], considering: pageFormat) else { throw DictationError.start }
    let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
    let s = AnalyzerSession(analyzer: analyzer, format: format, feed: feed, emit: emit)
    if format != pageFormat && s.converter == nil { throw DictationError.start }
    s.results = Task {
      do {
        if let t = module as? SpeechTranscriber {
          for try await r in t.results { s.text(String(r.text.characters), final: r.isFinal) }
        } else if let t = module as? DictationTranscriber {
          for try await r in t.results { s.text(String(r.text.characters), final: r.isFinal) }
        }
      } catch { s.fail("results") }
    }
    do {
      try await analyzer.prepareToAnalyze(in: format)
      try await analyzer.start(inputSequence: stream)
    } catch {
      // nothing of it stays: the stream ends, the analyzer stops, its results with it
      feed.finish()
      s.results?.cancel()
      await analyzer.cancelAndFinishNow()
      throw DictationError.start
    }
    return s
  }

  private func live() -> Bool { lock.lock(); defer { lock.unlock() }; return !cancelled }

  /** true once: nothing more comes after done */
  private func finishOnce() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if cancelled { return false }
    cancelled = true
    return true
  }

  private func text(_ t: String, final: Bool) {
    if live() { emit(["event": "text", "final": final, "text": t]) }
  }

  private func fail(_ code: String) {
    lock.lock()
    let first = !cancelled
    cancelled = true
    lock.unlock()
    if first { emit(["event": "error", "code": code]) }
  }

  func push(_ data: Data) {
    lock.lock(); defer { lock.unlock() }
    guard !ended, let b = pcmBuffer(data), let buffer = convert(b, converter, to: format) else { return }
    feed.yield(AnalyzerInput(buffer: buffer, bufferStartTime: CMTime(value: at, timescale: CMTimeScale(format.sampleRate))))
    at += Int64(buffer.frameLength)
  }

  func stop() {
    lock.lock()
    if ended { lock.unlock(); return }
    ended = true
    lock.unlock()
    feed.finish()
    Task {
      do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { fail("finish"); return }
      await results?.value
      if finishOnce() { emit(["event": "done"]) }
    }
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let was = ended
    ended = true
    lock.unlock()
    if !was { feed.finish() }
    results?.cancel()
    Task { await analyzer.cancelAndFinishNow() }
  }
}

/** Before iOS 26: SFSpeechRecognizer on the phone only (requiresOnDeviceRecognition). Each partial result is the whole
 * text of the stretch so far, so it is the guess; the final one is kept. After a pause iOS 17 and later may start the
 * partial results again from the beginning: the stretch before is then kept (sent as final) first, so its words stay. */
final class LegacySession: DictationSession, @unchecked Sendable {
  private let request = SFSpeechAudioBufferRecognitionRequest()
  private var task: SFSpeechRecognitionTask?
  private let lock = NSLock()
  private var finished = false
  private var stopped = false
  /** the newest partial text: the guess of the stretch now */
  private var stretch = ""
  private let emit: DictationEmit
  private let recognizer: SFSpeechRecognizer
  private let floatFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
  private let converter: AVAudioConverter?

  private init(_ r: SFSpeechRecognizer, emit: @escaping DictationEmit) {
    recognizer = r
    self.emit = emit
    converter = AVAudioConverter(from: pageFormat, to: floatFormat)
  }

  static func start(_ locale: Locale, emit: @escaping DictationEmit) async throws -> LegacySession {
    // the Speech Recognition question, once: the sound still stays on the phone (requiresOnDeviceRecognition)
    var auth = SFSpeechRecognizer.authorizationStatus()
    if auth == .notDetermined {
      auth = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
        SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
      }
    }
    guard auth == .authorized else { throw DictationError.denied }
    guard let r = SFSpeechRecognizer(locale: locale), r.isAvailable, r.supportsOnDeviceRecognition else { throw DictationError.unsupported }
    let s = LegacySession(r, emit: emit)
    s.request.requiresOnDeviceRecognition = true
    s.request.shouldReportPartialResults = true
    s.request.taskHint = .dictation
    if #available(iOS 16.0, macOS 13.0, *) { s.request.addsPunctuation = true }
    s.task = r.recognitionTask(with: s.request) { [weak s] result, error in s?.on(result, error) }
    return s
  }

  private func on(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
    lock.lock()
    if finished { lock.unlock(); return }
    let final = result?.isFinal == true || error != nil
    if final { finished = true }
    let wasStopped = stopped
    let before = stretch
    let text = result?.bestTranscription.formattedString ?? ""
    let restarted = result != nil && LegacySession.restarted(before, text)
    if result != nil { stretch = result!.isFinal ? "" : text }
    lock.unlock()
    if restarted { emit(["event": "text", "final": true, "text": before]) }
    if let result { emit(["event": "text", "final": result.isFinal, "text": text]) }
    else if error != nil && !before.isEmpty { emit(["event": "text", "final": true, "text": before]) }
    // after Stop the end is done; before it (the recognizer gave up by itself, or "no speech" for a long while) the
    // recording ended on the way: the words so far stay and the page says so
    if final { emit(wasStopped ? ["event": "done"] : ["event": "error", "code": "ended"]) }
  }

  /** a partial that starts the stretch again: shorter than the one before and not its beginning */
  static func restarted(_ before: String, _ now: String) -> Bool {
    let b = before.lowercased(), n = now.lowercased()
    guard !b.isEmpty, n.count < b.count else { return false }
    return !b.hasPrefix(String(n.prefix(min(3, n.count))))
  }

  func push(_ data: Data) {
    lock.lock(); let open = !stopped && !finished; lock.unlock()
    guard open, let b = pcmBuffer(data), let f = convert(b, converter, to: floatFormat) else { return }
    request.append(f)
  }

  func stop() {
    lock.lock(); let first = !stopped; stopped = true; lock.unlock()
    if first { request.endAudio() }
  }

  func cancel() {
    lock.lock(); finished = true; stopped = true; lock.unlock()
    task?.cancel()
  }
}
