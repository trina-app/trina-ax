// The <app> in Chrome extension's native messaging helper (shared/src/chrome-native.ts, desktop/src/common/chrome-pair.ts).
// Chrome, Edge or Brave start it for our extension ids only (the host manifest's allowed_origins) and pass the caller's
// origin as the first argument. Each message (4-byte length in this computer's byte order + UTF-8 JSON) goes to the
// running desktop app as one line `{"origin":…,"request":…}` over the app's socket, and the app's one-line reply goes
// back the same way. When there is no app at the socket: {"type":"error","reason":"app_not_running"}; when the app took
// the line but sent nothing back in time: "no_answer"; when the socket's program is not ours (a release build): "refused".
// The socket: MYCEL_CHROME_PAIR_SOCKET (a start script sets it for an app run from another user data folder), else
// ~/Library/Application Support/<the app's data folder>/chrome/pair.sock (build.sh writes the folder's name into
// config.swift). It keeps nothing, writes no file and logs nothing.
// A release build (build.sh with CHROME_HOST_TEAM_ID, the Developer ID team) talks only to a socket served by a program
// signed by that team (the socket's peer pid, checked with the Security framework) and ignores MYCEL_CHROME_PAIR_SOCKET:
// another program of this user that took the socket's place, or pointed the helper elsewhere, gets nothing to answer.
import Foundation
import Security

let maxBytes = 16 * 1024

func readExactly(_ n: Int) -> Data? {
  var d = Data()
  while d.count < n {
    let chunk = FileHandle.standardInput.readData(ofLength: n - d.count)
    if chunk.isEmpty { return nil }
    d.append(chunk)
  }
  return d
}

func write(_ json: Data) {
  var n = UInt32(json.count)
  var out = Data(bytes: &n, count: 4)
  out.append(json)
  FileHandle.standardOutput.write(out)
}

func refusal(_ reason: String) -> Data { Data("{\"type\":\"error\",\"reason\":\"\(reason)\"}".utf8) }

/// what one round trip to the app gave: its line, or why there is none
enum Answer { case line(Data), notRunning, noAnswer, notOurs }

func socketPath() -> String {
  if requiredTeam.isEmpty, let p = ProcessInfo.processInfo.environment["MYCEL_CHROME_PAIR_SOCKET"], p.hasPrefix("/") { return p }
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  return "\(home)/Library/Application Support/\(appDataDir)/chrome/pair.sock"
}

/// the program serving the socket is signed by our team (release builds; a development build checks nothing)
func peerIsOurApp(_ fd: Int32) -> Bool {
  if requiredTeam.isEmpty { return true }
  var pid: pid_t = 0
  var len = socklen_t(MemoryLayout<pid_t>.size)
  if getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) != 0 || pid <= 0 { return false }
  var code: SecCode?
  let attrs = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let c = code else { return false }
  var req: SecRequirement?
  let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(requiredTeam)\"" as CFString
  guard SecRequirementCreateWithString(text, [], &req) == errSecSuccess, let r = req else { return false }
  return SecCodeCheckValidity(c, [], r) == errSecSuccess
}

/// one round trip to the app: the line out, one line back (at most maxBytes)
func ask(_ line: Data) -> Answer {
  let path = socketPath()
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  if fd < 0 { return .notRunning }
  defer { close(fd) }
  var noSigpipe: Int32 = 1
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
  // the app asks the team page for a code: allow it a while, then give up
  var tv = timeval(tv_sec: 30, tv_usec: 0)
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  let cap = MemoryLayout.size(ofValue: addr.sun_path)
  if bytes.count >= cap { return .notRunning }
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    for (i, b) in bytes.enumerated() { raw[i] = b }
    raw[bytes.count] = 0
  }
  let ok = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
  if ok != 0 { return .notRunning }
  if !peerIsOurApp(fd) { return .notOurs }
  var sent = 0
  let sentOk = line.withUnsafeBytes { (p: UnsafeRawBufferPointer) -> Bool in
    while sent < line.count {
      let n = Darwin.write(fd, p.baseAddress! + sent, line.count - sent)
      if n <= 0 { return false }
      sent += n
    }
    return true
  }
  if !sentOk { return .noAnswer }
  var reply = Data()
  var buf = [UInt8](repeating: 0, count: 4096)
  while reply.count <= maxBytes {
    let n = read(fd, &buf, buf.count)
    if n <= 0 { break }
    reply.append(contentsOf: buf[0..<n])
    if let i = reply.firstIndex(of: 0x0a) { return .line(reply.subdata(in: reply.startIndex..<i)) }
  }
  // connected and the line went, but no reply line (the app is busy, waits on a system prompt, or closed it)
  return .noAnswer
}

let origin = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

while true {
  guard let head = readExactly(4) else { exit(0) }
  let n = Int(head.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
  if n > maxBytes { exit(1) }
  guard let body = readExactly(n) else { exit(0) }
  // one line to the app: re-encoded, so no newline from the message can split it
  guard let request = try? JSONSerialization.jsonObject(with: body, options: []),
        let line = try? JSONSerialization.data(withJSONObject: ["origin": origin, "request": request], options: [])
  else {
    write(refusal("refused"))
    continue
  }
  var out = line
  out.append(0x0a)
  switch ask(out) {
  case .line(let reply) where (try? JSONSerialization.jsonObject(with: reply, options: [])) != nil: write(reply)
  case .line: write(refusal("no_answer"))
  case .notRunning: write(refusal("app_not_running"))
  case .noAnswer: write(refusal("no_answer"))
  case .notOurs: write(refusal("refused"))
  }
}
