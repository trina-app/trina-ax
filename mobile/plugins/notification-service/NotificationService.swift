// The iPhone app's notification service extension (docs/DECISIONS.md "아이폰 알림의 이름"). A room push comes with the
// generic words the push gateway chose ("Trina AX" / "새 메시지가 있어요") and mutable-content. Here the phone asks its
// own team, with the label key it got at registration, what the push says: who and where ("민준 · #마케팅 › 스레드", a
// DM "민준"), never the message's text. The push gateway never sees a name.
//
// It acts only on a room notice (code room.*) for the device this phone registered with its current team; it calls only
// the team address the app stored, never anything from the payload, over https, without cookies, cache or redirects, for
// at most 5 seconds; on any failure it shows what Apple delivered. Added to the Xcode project by
// ../notification-service.js; the keychain item comes from the app (src/labels.ts, src/push.ts labelSlot).
import Foundation
import Security
import UserNotifications

/// What the app keeps for this extension in the keychain group they share.
struct LabelAccess {
  let origin: URL
  let deviceId: String
  let key: String
}

/// The team's words for one push.
struct LabelWords {
  let title: String
  let body: String?
  let roomId: String?
}

enum Label {
  /// expo-secure-store's naming: service "<keychainService>:no-auth", account the key's UTF-8 bytes (src/labels.ts)
  static let service = "team-ax.push-label:no-auth"
  static let item = "label"
  static let timeout: TimeInterval = 5
  static let maxAnswer = 4096

  /// [A-Za-z0-9_-]{min,max}: the ids and keys the team server uses
  static func token(_ s: String, min: Int, max: Int) -> Bool {
    let u = s.unicodeScalars
    return u.count >= min && u.count <= max && u.allSatisfy { c in
      let v = c.value
      return (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 45 || v == 95
    }
  }
  static func isId(_ s: String) -> Bool { token(s, min: 1, max: 100) }

  /// https://host[:port] and nothing else (the app saved the team's origin, src/address.ts).
  static func teamOrigin(_ raw: String) -> URL? {
    guard raw.count <= 2048, let c = URLComponents(string: raw), c.scheme == "https", let host = c.host, !host.isEmpty,
          c.user == nil, c.password == nil, c.query == nil, c.fragment == nil, c.path.isEmpty else { return nil }
    return c.url
  }

  /// The app's item in the shared group (readable after the phone's first unlock), or nil.
  static func access(group: String) -> LabelAccess? {
    guard !group.isEmpty else { return nil }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: Data(item.utf8),
      kSecAttrAccessGroup as String: group,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data, data.count <= 2048,
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], (o["v"] as? Int) == 1,
          let raw = o["origin"] as? String, let origin = teamOrigin(raw),
          let deviceId = o["deviceId"] as? String, isId(deviceId),
          let key = o["key"] as? String, token(key, min: 43, max: 43) else { return nil }
    return LabelAccess(origin: origin, deviceId: deviceId, key: key)
  }

  /// The request for a room notice of this phone's device on its current team, or nil.
  static func request(userInfo: [AnyHashable: Any], access: LabelAccess?) -> URLRequest? {
    // expo-notifications' place for a push's data on iOS: userInfo["body"] (push-gateway/src/apns.ts)
    guard let data = userInfo["body"] as? [String: Any], let code = data["code"] as? String, code.hasPrefix("room."),
          let notificationId = data["notificationId"] as? String, isId(notificationId),
          let device = data["device"] as? String, isId(device),
          let access, access.deviceId == device,
          let url = URL(string: "/api/push/devices/\(access.deviceId)/label", relativeTo: access.origin)?.absoluteURL,
          url.scheme == "https", url.host == access.origin.host,
          let body = try? JSONSerialization.data(withJSONObject: ["key": access.key, "notificationId": notificationId]) else { return nil }
    var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
    r.httpMethod = "POST"
    r.httpShouldHandleCookies = false
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    // the team server's CSRF rule for a request without a session (server/src/http/middleware.ts)
    r.setValue("1", forHTTPHeaderField: "x-mycel-csrf")
    r.httpBody = body
    return r
  }

  /// The team's answer: a 200 JSON object with a title, or nil (an empty answer, an older server, anything else).
  static func words(data: Data?, response: URLResponse?) -> LabelWords? {
    guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data, data.count <= maxAnswer,
          (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased().hasPrefix("application/json"),
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let raw = o["title"] as? String else { return nil }
    let title = plain(raw)
    guard !title.isEmpty else { return nil }
    let body = (o["body"] as? String).map { plain($0, max: 200) }.flatMap { $0.isEmpty ? nil : $0 }
    let roomId = (o["roomId"] as? String).flatMap { isId($0) ? $0 : nil }
    return LabelWords(title: title, body: body, roomId: roomId)
  }

  /// One plain line, the server's plainLabel again (shared/src/api/notifications.ts): no control or format characters
  /// (bidirectional overrides, zero-width spaces; the emoji joiner stays), no line breaks, single spaces, at most `max`.
  static func plain(_ s: String, max: Int = 120) -> String {
    var scalars = String.UnicodeScalarView()
    for u in s.unicodeScalars {
      if u.value == 0x200D { scalars.append(u); continue }
      switch u.properties.generalCategory {
      case .format: continue
      case .control, .lineSeparator, .paragraphSeparator: scalars.append(" ")
      default: scalars.append(u)
      }
    }
    let line = String(scalars).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    guard line.count > max else { return line }
    return String(line.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
  }
}

/// Only the team's own address answers: a redirect is not followed (the request ends with the 3xx, which is no answer).
final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

/// Its state is behind the lock (the answer, the timeout guard and the system may finish at the same time).
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
  private let lock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?
  private var session: URLSession?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    lock.lock(); handler = contentHandler; original = request.content; lock.unlock()
    // the shared keychain group, written into this extension's Info.plist at prebuild (../notification-service.js)
    let group = Bundle.main.object(forInfoDictionaryKey: "MycelLabelAccessGroup") as? String ?? ""
    guard let ask = Label.request(userInfo: request.content.userInfo, access: Label.access(group: group)) else { return finish(nil) }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = Label.timeout
    config.timeoutIntervalForResource = Label.timeout
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.urlCache = nil
    config.urlCredentialStorage = nil
    config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    config.waitsForConnectivity = false
    let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    // the system may have ended this already (serviceExtensionTimeWillExpire): then nothing is asked
    lock.lock(); let open = handler != nil; if open { self.session = session }; lock.unlock()
    guard open else { return session.invalidateAndCancel() }
    session.dataTask(with: ask) { data, response, _ in self.finish(Label.words(data: data, response: response)) }.resume()
    // the session's timeouts end the request; this is the last guard
    DispatchQueue.global().asyncAfter(deadline: .now() + Label.timeout + 1) { self.finish(nil) }
  }

  override func serviceExtensionTimeWillExpire() { finish(nil) }

  /// Exactly once: the team's words over Apple's, or Apple's as they came.
  private func finish(_ words: LabelWords?) {
    lock.lock()
    let handler = self.handler, original = self.original, session = self.session
    self.handler = nil; self.session = nil
    lock.unlock()
    session?.invalidateAndCancel()
    guard let handler, let original else { return }
    guard let words, let content = original.mutableCopy() as? UNMutableNotificationContent else { return handler(original) }
    content.title = words.title
    if let body = words.body { content.body = body }
    // one stack per room in Notification Center
    if let roomId = words.roomId { content.threadIdentifier = roomId }
    handler(content)
  }
}
