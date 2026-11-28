// The <app> in Chrome extension's native messaging helper (shared/src/chrome-native.ts, desktop/src/common/chrome-pair.ts).
// Chrome, Edge or Brave start it for our extension ids only (the host manifest's allowed_origins) and pass the caller's
// origin as the first argument. Each message (4-byte length in this computer's byte order + UTF-8 JSON) goes to the
// running desktop app as one line `{"origin":…,"request":…}` over the app's socket, and the app's one-line reply goes
// back the same way. When the app does not answer: {"type":"error","reason":"app_not_running"}.
// The socket: MYCEL_CHROME_PAIR_SOCKET (a development run's start script sets it), else
// ~/Library/Application Support/<the app's data folder>/chrome/pair.sock (build.sh writes the folder's name into
// config.swift). It keeps nothing, writes no file and logs nothing.
import Foundation

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

let notRunning = Data(#"{"type":"error","reason":"app_not_running"}"#.utf8)

func socketPath() -> String {
  if let p = ProcessInfo.processInfo.environment["MYCEL_CHROME_PAIR_SOCKET"], p.hasPrefix("/") { return p }
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  return "\(home)/Library/Application Support/\(appDataDir)/chrome/pair.sock"
}

/// one round trip to the app: the line out, one line back (at most maxBytes), or nil
func ask(_ line: Data) -> Data? {
  let path = socketPath()
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  if fd < 0 { return nil }
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
  if bytes.count >= cap { return nil }
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    for (i, b) in bytes.enumerated() { raw[i] = b }
    raw[bytes.count] = 0
  }
  let ok = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
  if ok != 0 { return nil }
  var sent = 0
  let sentOk = line.withUnsafeBytes { (p: UnsafeRawBufferPointer) -> Bool in
    while sent < line.count {
      let n = Darwin.write(fd, p.baseAddress! + sent, line.count - sent)
      if n <= 0 { return false }
      sent += n
    }
    return true
  }
  if !sentOk { return nil }
  var reply = Data()
  var buf = [UInt8](repeating: 0, count: 4096)
  while reply.count <= maxBytes {
    let n = read(fd, &buf, buf.count)
    if n <= 0 { break }
    reply.append(contentsOf: buf[0..<n])
    if let i = reply.firstIndex(of: 0x0a) { return reply.subdata(in: reply.startIndex..<i) }
  }
  return nil
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
    write(Data(#"{"type":"error","reason":"refused"}"#.utf8))
    continue
  }
  var out = line
  out.append(0x0a)
  if let reply = ask(out), (try? JSONSerialization.jsonObject(with: reply, options: [])) != nil {
    write(reply)
  } else {
    write(notRunning)
  }
}
