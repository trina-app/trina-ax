// Tests for the menubar status model (no XCTest needed: compiled with StatusModel.swift into one executable by
// `menubar/build.sh --test`, exits non-zero on the first failure).
import Foundation

var failures = 0
func expect(_ cond: @autoclosure () -> Bool, _ what: String, file: String = #file, line: Int = #line) {
    if cond() { print("ok   \(what)") } else { failures += 1; print("FAIL \(what) (\(file):\(line))") }
}

let json = """
{"format":1,"writtenAt":"2026-10-21T00:00:00Z","version":"0.1.0","pid":123,"webUrl":"https://acme.treesoop.com",
 "localUrl":"http://127.0.0.1:47820","label":"app.treesoop.mycel","logsDir":"/Library/Logs/mycel",
 "connection":{"mode":"relay","state":"connected","address":"https://acme.treesoop.com","detail":null},
 "queue":{"running":1,"queued":2},"firewall":"ok","sandbox":"ok","lastBackupAt":null,"overall":"ok","problems":[],"extra":"ignored"}
"""
let s = parseStatus(json.data(using: .utf8)!)
expect(s != nil, "status.json parses (unknown fields ignored)")
expect(s?.connection.state == "connected", "connection state")
let healthy = Health(ok: true, version: "0.1.0")

var m = menuState(status: s, statusAge: 10, health: healthy, daemon: .running, lang: .ko)
expect(m.icon == .ok, "healthy server: ok icon")
expect(m.headline.contains("켜짐") && m.headline.contains("0.1.0"), "headline in Korean with version")
expect(m.lines.contains { $0.contains("실행 중 1") }, "queue line")
expect(m.webUrl == "https://acme.treesoop.com", "web URL is the team address")

var r = s!
r.connection.state = "replaced"
m = menuState(status: r, statusAge: 10, health: healthy, daemon: .running, lang: .en)
expect(m.icon == .replaced, "replaced by another instance: own icon")
expect(m.alert?.contains("another Mac") == true, "replaced: alert text (en)")

var f = s!
f.firewall = "fail"; f.overall = "fail"; f.problems = ["AI 엔진 방화벽(pf): 꺼짐"]
m = menuState(status: f, statusAge: 10, health: healthy, daemon: .running, lang: .ko)
expect(m.icon == .fail && m.alert?.contains("방화벽") == true, "firewall off: fail icon and alert")
expect(m.lines.contains("AI 엔진 방화벽(pf): 꺼짐"), "problems listed")

m = menuState(status: s, statusAge: 600, health: healthy, daemon: .running, lang: .ko)
expect(m.icon == .warn && m.lines.first?.contains("status.json") == true, "stale status file: warn")

m = menuState(status: s, statusAge: 10, health: nil, daemon: .disabled, lang: .ko)
expect(m.icon == .off && m.offerLoginItems && m.lines[0].contains("로그인 항목"), "daemon switched off: Login Items hint")
m = menuState(status: s, statusAge: 10, health: Health(ok: false, version: "0.1.0"), daemon: .notRunning, lang: .id)
expect(m.icon == .off && !m.offerLoginItems && m.headline.contains("mati"), "unhealthy (id)")

expect(daemonState(launchctlExit: 113, output: "Could not find service") == .disabled, "launchctl: not loaded")
expect(daemonState(launchctlExit: 0, output: "state = running") == .running, "launchctl: running")
expect(daemonState(launchctlExit: 0, output: "state = waiting") == .notRunning, "launchctl: waiting")
expect(Lang.current(["en-US"]) == .en && Lang.current(["id-ID"]) == .id && Lang.current(["fr"]) == .ko, "language choice")
expect(parseHealth("{\"ok\":true,\"version\":\"1\",\"uptimeSec\":3}".data(using: .utf8)!) == Health(ok: true, version: "1"), "health parses")

// status.json is written by the server account: nothing in it may make the admin's app open a non-web URL
var evil = s!
evil.webUrl = "file:///Applications/Calculator.app"
m = menuState(status: evil, statusAge: 10, health: healthy, daemon: .running, lang: .ko)
expect(m.webUrl == nil, "file:// web URL from status.json is dropped")
evil.webUrl = "x-apple.systempreferences:com.apple.Foo"
expect(menuState(status: evil, statusAge: 10, health: healthy, daemon: .running, lang: .ko).webUrl == nil, "custom URL scheme dropped")
expect(safeWebURL("https://acme.treesoop.com/x") != nil && safeWebURL("http://acme.localhost:19100") != nil, "http(s) team addresses allowed")
expect(safeWebURL("https://user:pw@evil.example") == nil && safeWebURL("javascript:alert(1)") == nil && safeWebURL(nil) == nil, "credentials / javascript refused")
expect(safeLocalURL("http://127.0.0.1:47820", fallback: "F") == "http://127.0.0.1:47820", "loopback health URL kept")
expect(safeLocalURL("http://evil.example:80", fallback: "F") == "F" && safeLocalURL("file:///etc/passwd", fallback: "F") == "F" && safeLocalURL("http://127.0.0.1:1/x?y", fallback: "F") == "F", "non-loopback health URL replaced")
f.firewall = "fail"
expect(menuState(status: f, statusAge: 10, health: healthy, daemon: .running, lang: .en).alert?.contains("refused") == false, "firewall alert does not promise a refusal the server does not make")

print(failures == 0 ? "all menubar model tests passed" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
