// Voice input on this iPhone, for the app's bridge (src/dictation.ts, capability dictation-v1): the page records,
// the app hands its samples here, the words go back to the page while the person talks. One recording at a time; a
// new start ends the one before. A stopped recording is kept here until its last words and done (or an error) went
// out: the recognizer's own callbacks hold it only weakly. The recognizer itself is DictationEngine.swift.
import ExpoModulesCore
import Foundation

public class DictationModule: Module {
  private let lock = NSLock()
  /** every recording not over yet: the one recording now, and stopped ones still writing their last words */
  private var sessions: [Int: DictationSession] = [:]
  /** the recording now (the one push goes to) */
  private var live: Int?
  /** the newest start asked for: a start that finishes getting ready after a newer one asked gives way */
  private var latest = 0

  public func definition() -> ModuleDefinition {
    Name("Dictation")
    Events("onDictation")

    /** the language's state on this phone: { state: ready | needs-model | unsupported, locale?, engine? } */
    AsyncFunction("check") { (language: String) async -> [String: Any] in
      guard let l = dictationLanguage(language) else { return ["state": "unsupported"] }
      return await DictationEngine.check(l).dictionary
    }

    /** Apple's model for the language: installed | failed | unsupported, progress as events { event: progress } */
    AsyncFunction("install") { (id: Int, language: String) async -> String in
      guard let l = dictationLanguage(language) else { return "unsupported" }
      return await DictationEngine.install(l) { [weak self] percent in
        self?.sendEvent("onDictation", ["id": id, "event": "progress", "percent": percent])
      }
    }

    /** a recording `id` (the app's number): true once the recognizer listens, false when it cannot (the server then) */
    AsyncFunction("start") { (id: Int, language: String) async -> Bool in
      guard let l = dictationLanguage(language) else { return false }
      self.lock.lock()
      self.latest = id
      self.lock.unlock()
      self.endLive()
      do {
        let s = try await startDictation(l) { [weak self] e in self?.event(id, e) }
        self.lock.lock()
        let newest = self.latest == id
        if newest { self.sessions[id] = s; self.live = id }
        self.lock.unlock()
        if !newest { s.cancel() }
        return newest
      } catch {
        return false
      }
    }

    /** 16 kHz mono signed 16-bit little-endian samples, base64 */
    Function("push") { (id: Int, b64: String) in
      guard let s = self.recording(id), let data = Data(base64Encoded: b64) else { return }
      s.push(data)
    }

    /** the sound ended: the last words, then { event: done } */
    Function("stop") { (id: Int) in
      self.lock.lock()
      let s = self.live == id ? self.sessions[id] : nil
      if s != nil { self.live = nil }
      self.lock.unlock()
      s?.stop()
    }

    /** nothing more comes for this recording (also one still writing its last words) */
    Function("cancel") { (id: Int) in
      self.lock.lock()
      let s = self.sessions.removeValue(forKey: id)
      if self.live == id { self.live = nil }
      // cancelled while it still got ready: that start gives way when it is
      if self.latest == id { self.latest = 0 }
      self.lock.unlock()
      s?.cancel()
    }

    OnDestroy {
      self.lock.lock()
      let all = Array(self.sessions.values)
      self.sessions = [:]
      self.live = nil
      self.lock.unlock()
      all.forEach { $0.cancel() }
    }
  }

  private func event(_ id: Int, _ e: [String: Any]) {
    let event = e["event"] as? String
    if event == "done" || event == "error" {
      lock.lock()
      sessions.removeValue(forKey: id)
      if live == id { live = nil }
      lock.unlock()
    }
    var e = e
    e["id"] = id
    sendEvent("onDictation", e)
  }

  private func recording(_ id: Int) -> DictationSession? {
    lock.lock(); defer { lock.unlock() }
    return live == id ? sessions[id] : nil
  }

  /** a new start: the recording before it goes (stopped ones still finish) */
  private func endLive() {
    lock.lock()
    let s = live.flatMap { sessions.removeValue(forKey: $0) }
    live = nil
    lock.unlock()
    s?.cancel()
  }
}
