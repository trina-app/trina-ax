// Team AX menubar app — status model (no UI): reads status/status.json written by the server every 30 s and the
// result of GET /api/health, and decides what the menu shows. Pure Swift so it can be tested without AppKit
// (menubar/Tests/main.swift, run by `menubar/build.sh --test`). Design tab 6 "상태 읽기".
import Foundation

/// status/status.json (shared/src/install.ts StatusFile). Unknown fields are ignored.
public struct StatusFile: Codable, Equatable {
    public struct Connection: Codable, Equatable {
        public var mode: String
        public var state: String
        public var address: String?
        public var detail: String?
    }
    public struct Queue: Codable, Equatable {
        public var running: Int
        public var queued: Int
    }
    public var format: Int
    public var writtenAt: String
    public var version: String
    public var pid: Int
    public var webUrl: String
    public var localUrl: String
    public var label: String?
    public var logsDir: String?
    public var connection: Connection
    public var queue: Queue
    public var firewall: String
    public var sandbox: String
    public var lastBackupAt: String?
    public var overall: String
    public var problems: [String]
}

public struct Health: Codable, Equatable {
    public var ok: Bool
    public var version: String
}

public enum Lang: String { case ko, en, id
    public static func current(_ preferred: [String] = Locale.preferredLanguages) -> Lang {
        for p in preferred {
            if p.hasPrefix("ko") { return .ko }
            if p.hasPrefix("en") { return .en }
            if p.hasPrefix("id") || p.hasPrefix("in") { return .id }
        }
        return .ko
    }
}

/// What the menu shows.
public struct MenuState: Equatable {
    public enum Icon: String { case ok, warn, fail, off, replaced }
    public var icon: Icon
    /// first line, e.g. "Team AX: 켜짐 (0.1.0)"
    public var headline: String
    /// further lines (connection, queue, problems)
    public var lines: [String]
    /// shown as a separate, highlighted item with an action
    public var alert: String?
    /// offer the "Login Items" shortcut (daemon switched off in System Settings)
    public var offerLoginItems: Bool
    /// only ever an http(s) address (see safeWebURL)
    public var webUrl: String?
}

// status.json is written by the server account; this app runs as the logged-in administrator. Nothing read from it
// may make the app open anything but a web page (a file:// URL or an app path would launch a program as the admin),
// so URLs are checked here and the logs folder is a fixed path (Monitor.openLogs), never taken from the file.

/// The URL if it is an http(s) web address with a host, else nil.
public func safeWebURL(_ s: String?) -> URL? {
    guard let s, let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = u.host, !host.isEmpty, u.user == nil, u.password == nil else { return nil }
    return u
}

/// The health-check base: only http://127.0.0.1:<port> or http://localhost:<port> (no path); otherwise `fallback`.
public func safeLocalURL(_ s: String?, fallback: String) -> String {
    guard let s, let u = URL(string: s), u.scheme == "http", u.host == "127.0.0.1" || u.host == "localhost",
          let port = u.port, port > 0, port < 65536, u.path.isEmpty || u.path == "/", u.query == nil, u.user == nil else { return fallback }
    return "http://\(u.host!):\(port)"
}

enum T {
    static func s(_ l: Lang, _ ko: String, _ en: String, _ id: String) -> String { l == .ko ? ko : l == .en ? en : id }
}

public enum DaemonState: Equatable { case running, notRunning, disabled, unknown }

/// Decide the menu from the last status file, the health check and (when health fails) the launchd state.
/// `now` and `statusAge` let tests pin time: a status file older than 2 minutes means the server stopped writing.
public func menuState(status: StatusFile?, statusAge: TimeInterval?, health: Health?, daemon: DaemonState, lang: Lang, product: String = "Team AX") -> MenuState {
    let stale = (statusAge ?? .infinity) > 120
    guard let h = health, h.ok else {
        var lines: [String] = []
        var offer = false
        switch daemon {
        case .disabled:
            lines.append(T.s(lang, "백그라운드 항목이 꺼져 있습니다. 시스템 설정 > 일반 > 로그인 항목에서 \(product)를 켜 주세요.",
                             "The background item is switched off. Turn \(product) on in System Settings > General > Login Items.",
                             "Item latar belakang dimatikan. Aktifkan \(product) di Pengaturan Sistem > Umum > Item Masuk."))
            offer = true
        case .notRunning:
            lines.append(T.s(lang, "서버가 다시 시작하는 중이거나 멈췄습니다. 1분 뒤에도 그대로면 로그를 확인해 주세요.",
                             "The server is restarting or has stopped. If this lasts more than a minute, check the logs.",
                             "Server sedang dimulai ulang atau berhenti. Jika lebih dari semenit, periksa log."))
        case .running, .unknown:
            lines.append(T.s(lang, "서버가 응답하지 않습니다.", "The server does not answer.", "Server tidak merespons."))
        }
        return MenuState(icon: .off, headline: "\(product): " + T.s(lang, "꺼짐", "off", "mati"), lines: lines, alert: nil,
                         offerLoginItems: offer, webUrl: nil)
    }
    var lines: [String] = []
    var alert: String? = nil
    var icon: MenuState.Icon = .ok
    if let s = status, !stale {
        let c = s.connection
        switch c.state {
        case "connected": lines.append(T.s(lang, "원격 접속: 연결됨", "Remote access: connected", "Akses jarak jauh: terhubung") + (c.address.map { " (\($0))" } ?? ""))
        case "connecting": lines.append(T.s(lang, "원격 접속: 연결하는 중", "Remote access: connecting", "Akses jarak jauh: menghubungkan"))
        case "offline": lines.append(T.s(lang, "원격 접속: 끊김 (사무실 안 접속은 됨)", "Remote access: offline (office access works)", "Akses jarak jauh: terputus (akses kantor tetap bisa)"))
        case "replaced":
            alert = T.s(lang, "다른 맥의 서버가 이 팀 주소를 대신 쓰고 있습니다. 이 서버는 원격 접속을 멈췄습니다.",
                        "A server on another Mac has taken over this team address. This server stopped remote access.",
                        "Server di Mac lain mengambil alih alamat tim ini. Server ini menghentikan akses jarak jauh.")
            icon = .replaced
        default: lines.append(T.s(lang, "원격 접속: 꺼짐 (사무실 안에서만)", "Remote access: off (office only)", "Akses jarak jauh: mati (hanya kantor)"))
        }
        lines.append(T.s(lang, "실행 중 \(s.queue.running) · 대기 \(s.queue.queued)", "\(s.queue.running) running · \(s.queue.queued) waiting", "\(s.queue.running) berjalan · \(s.queue.queued) menunggu"))
        if s.firewall == "fail" {
            alert = alert ?? T.s(lang, "AI 엔진 방화벽 꺼짐 — 복구(관리자 비밀번호)가 필요합니다.",
                                 "AI engine firewall off — repair needed (admin password).",
                                 "Firewall mesin AI mati — perlu perbaikan (kata sandi admin).")
        }
        lines.append(contentsOf: s.problems.prefix(5))
        if icon != .replaced {
            icon = s.overall == "fail" || s.firewall == "fail" ? .fail : s.overall == "warn" ? .warn : .ok
        }
    } else {
        lines.append(T.s(lang, "자세한 상태를 읽을 수 없습니다 (status.json).", "Detailed status unavailable (status.json).", "Status rinci tidak tersedia (status.json)."))
        icon = .warn
    }
    return MenuState(icon: icon, headline: "\(product): " + T.s(lang, "켜짐", "on", "aktif") + " (\(h.version))", lines: lines, alert: alert,
                     offerLoginItems: false, webUrl: safeWebURL(status?.webUrl)?.absoluteString)
}

/// launchctl print system/<label>.server output -> daemon state (exit code 113 = not loaded / switched off).
public func daemonState(launchctlExit: Int32, output: String) -> DaemonState {
    if launchctlExit == 113 || output.contains("Could not find service") { return .disabled }
    if launchctlExit != 0 { return .unknown }
    if output.contains("state = running") { return .running }
    return .notRunning
}

public func parseStatus(_ data: Data) -> StatusFile? { try? JSONDecoder().decode(StatusFile.self, from: data) }
public func parseHealth(_ data: Data) -> Health? { try? JSONDecoder().decode(Health.self, from: data) }
