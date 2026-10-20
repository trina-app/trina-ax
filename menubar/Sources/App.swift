// Team AX menubar app (design tab 6 "서버 앱 구성 / 상태 읽기"). Shows whether the server is on, the remote-access
// state (including "replaced by another instance"), queue and problems; opens the web screen and the logs folder.
// Polls GET /api/health every minute (and right after opening the menu) and reads status/status.json, which the
// server rewrites every 30 s (readable by the admin group). The setup assistant, AI-subscription connection and
// admin-password actions (firewall repair, uninstall) are later parts of the menubar app (WORKPLAN, G).
import AppKit
import SwiftUI
import UserNotifications

struct Settings {
    /// product id (folder names): Info.plist MycelProductId, overridden by --id <id>
    let productId: String
    let displayName = "Team AX"
    var base: String { "/Library/Application Support/\(productId)" }
    var statusFile: String { "\(base)/status/status.json" }

    static func load() -> Settings {
        var id = (Bundle.main.object(forInfoDictionaryKey: "MycelProductId") as? String) ?? "mycel"
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--id"), i + 1 < args.count { id = args[i + 1] }
        return Settings(productId: id)
    }
}

@MainActor
final class Monitor: ObservableObject {
    @Published var state = MenuState(icon: .off, headline: "Team AX", lines: [], alert: nil, offerLoginItems: false, webUrl: nil, logsDir: nil)
    let settings = Settings.load()
    private var timer: Timer?
    private var notifiedReplaced = false

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
    }

    func refresh() {
        let status: StatusFile?
        var age: TimeInterval? = nil
        if let d = FileManager.default.contents(atPath: settings.statusFile) {
            status = parseStatus(d)
            if let m = try? FileManager.default.attributesOfItem(atPath: settings.statusFile)[.modificationDate] as? Date { age = Date().timeIntervalSince(m) }
        } else {
            status = nil
        }
        let local = status?.localUrl ?? "http://127.0.0.1:47820"
        let label = status?.label ?? "app.treesoop.\(settings.productId)"
        Task.detached {
            let health = await Self.fetchHealth(local)
            let daemon: DaemonState = health?.ok == true ? .running : Self.launchd(label)
            await MainActor.run {
                self.state = menuState(status: status, statusAge: age, health: health, daemon: daemon, lang: Lang.current(), product: self.settings.displayName)
                if self.state.icon == .replaced && !self.notifiedReplaced { self.notifiedReplaced = true; self.notify(self.state.alert ?? "") }
                if self.state.icon != .replaced { self.notifiedReplaced = false }
            }
        }
    }

    nonisolated static func fetchHealth(_ base: String) async -> Health? {
        guard let url = URL(string: base + "/api/health") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        guard let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return parseHealth(data)
    }

    nonisolated static func launchd(_ label: String) -> DaemonState {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["print", "system/\(label).server"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return .unknown }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        return daemonState(launchctlExit: p.terminationStatus, output: out)
    }

    func notify(_ text: String) {
        let c = UNUserNotificationCenter.current()
        c.requestAuthorization(options: [.alert, .sound]) { ok, _ in
            guard ok else { return }
            let n = UNMutableNotificationContent()
            n.title = "Team AX"
            n.body = text
            c.add(UNNotificationRequest(identifier: "replaced", content: n, trigger: nil))
        }
    }

    func open(_ s: String?) { if let s, let u = URL(string: s) { NSWorkspace.shared.open(u) } }
    func openLogs() { if let d = state.logsDir ?? Optional("/Library/Logs/\(settings.productId)") { NSWorkspace.shared.open(URL(fileURLWithPath: d)) } }
    func openLoginItems() { open("x-apple.systempreferences:com.apple.LoginItems-Settings.extension") }
}

@main
struct TeamAXMenubar: App {
    @StateObject private var monitor = Monitor()

    var body: some Scene {
        MenuBarExtra {
            Text(monitor.state.headline)
            if let a = monitor.state.alert { Text("⚠︎ " + a) }
            ForEach(Array(monitor.state.lines.enumerated()), id: \.offset) { _, l in Text(l) }
            Divider()
            if monitor.state.webUrl != nil { Button(label("웹 화면 열기", "Open web screen", "Buka layar web")) { monitor.open(monitor.state.webUrl) } }
            if monitor.state.offerLoginItems { Button(label("로그인 항목 설정 열기", "Open Login Items settings", "Buka pengaturan Item Masuk")) { monitor.openLoginItems() } }
            Button(label("로그 폴더 열기", "Open logs folder", "Buka folder log")) { monitor.openLogs() }
            Button(label("새로 고침", "Refresh", "Muat ulang")) { monitor.refresh() }
            Divider()
            Button(label("메뉴바 앱 종료", "Quit menubar app", "Keluar aplikasi menubar")) { NSApplication.shared.terminate(nil) }
        } label: {
            Image(systemName: symbol(monitor.state.icon))
        }
    }

    func label(_ ko: String, _ en: String, _ id: String) -> String { let l = Lang.current(); return l == .ko ? ko : l == .en ? en : id }
    func symbol(_ i: MenuState.Icon) -> String {
        switch i {
        case .ok: return "checkmark.circle"
        case .warn: return "exclamationmark.circle"
        case .fail: return "xmark.octagon"
        case .off: return "power.circle"
        case .replaced: return "person.2.slash"
        }
    }
}
