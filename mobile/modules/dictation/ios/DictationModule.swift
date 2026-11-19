// Voice input on this iPhone, for the app's bridge (src/dictation.ts, capability dictation-v1): the page records,
// the app hands its samples here, the words go back to the page while the person talks. One recording at a time; a
// new start ends the one before. The recognizer itself is DictationEngine.swift.
import ExpoModulesCore
import Foundation

public class DictationModule: Module {
  private let lock = NSLock()
  private var session: (id: Int, s: DictationSession)?
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
      self.end()
      do {
        let s = try await startDictation(l) { [weak self] e in
          var e = e
          e["id"] = id
          self?.sendEvent("onDictation", e)
        }
        self.lock.lock()
        let newest = self.latest == id
        let before = newest ? self.session?.s : nil
        if newest { self.session = (id, s) }
        self.lock.unlock()
        before?.cancel()
        if !newest { s.cancel() }
        return newest
      } catch {
        return false
      }
    }

    /** 16 kHz mono signed 16-bit little-endian samples, base64 */
    Function("push") { (id: Int, b64: String) in
      guard let s = self.current(id), let data = Data(base64Encoded: b64) else { return }
      s.push(data)
    }

    /** the sound ended: the last words, then { event: done } */
    Function("stop") { (id: Int) in
      self.current(id)?.stop()
      self.lock.lock()
      if self.session?.id == id { self.session = nil }
      self.lock.unlock()
    }

    /** nothing more comes for this recording */
    Function("cancel") { (id: Int) in
      self.lock.lock()
      let s = self.session?.id == id ? self.session?.s : nil
      if s != nil { self.session = nil }
      // cancelled while it still got ready: that start gives way when it is
      if self.latest == id { self.latest = 0 }
      self.lock.unlock()
      s?.cancel()
    }

    OnDestroy { self.end() }
  }

  private func current(_ id: Int) -> DictationSession? {
    lock.lock(); defer { lock.unlock() }
    return session?.id == id ? session?.s : nil
  }

  private func end() {
    lock.lock()
    let s = session?.s
    session = nil
    lock.unlock()
    s?.cancel()
  }
}
