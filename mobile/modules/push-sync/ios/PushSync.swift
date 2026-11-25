// iPhone: notifications read on another device leave Notification Center
// (docs/AGENTS/plan/20261124-1853-iphone-clear-read-notifications.md, push-clear-v1).
//
// After the person read things elsewhere the team sends a silent sync push (code phone.sync): `aps` has only
// `content-available` and maybe `badge`, and `body.clear` lists the notice ids ("id,id") it pushed to this phone that are
// read now, the whole set of the push day each time. With the remote-notification background mode iOS runs the app for
// it, closed (not force-quit) or open, through application(_:didReceiveRemoteNotification:fetchCompletionHandler:);
// this takes those notifications off, as Android's Sync.kt takes them off the tray.
//
// A delivered notification is found by its notice id: `body.notificationId` in its userInfo (every push carries it;
// the notification service extension keeps userInfo) or, as a fallback, its request identifier (iOS uses the push's
// apns-collapse-id, which the gateway sets to the notice id when it is at most 64 characters). Nothing is ever shown,
// the badge is iOS's own (`aps.badge`), no network, no JS. The completion handler is called after the removal.
import ExpoModulesCore
import UIKit
import UserNotifications

enum PushSync {
  /** the contract's PUSH_SYNC_CODE */
  static let code = "phone.sync"
  /** the contract's PUSH_SYNC_MAX_CLEAR */
  static let maxClear = 40

  static func isId(_ s: Substring) -> Bool {
    !s.isEmpty && s.count <= 100 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
  }

  /** The listed notice ids of a sync push (only well-formed ones, at most maxClear), or nil when it is no sync. */
  static func ids(_ userInfo: [AnyHashable: Any]) -> Set<String>? {
    guard let body = userInfo["body"] as? [String: Any], body["code"] as? String == code else { return nil }
    let list = (body["clear"] as? String ?? "").split(separator: ",").filter(isId).prefix(maxClear)
    return Set(list.map(String.init))
  }

  /** The notice id of a delivered notification: its push's body.notificationId. */
  static func noticeId(_ n: UNNotification) -> String? {
    (n.request.content.userInfo["body"] as? [String: Any])?["notificationId"] as? String
  }

  /** Takes the listed notices off Notification Center; done(true) when one went. Never throws. */
  static func remove(_ ids: Set<String>, center: UNUserNotificationCenter = .current(), done: @escaping (Bool) -> Void) {
    if ids.isEmpty { done(false); return }
    center.getDeliveredNotifications { delivered in
      let gone = delivered.filter { n in ids.contains(noticeId(n) ?? "") || ids.contains(n.request.identifier) }.map { $0.request.identifier }
      if !gone.isEmpty { center.removeDeliveredNotifications(withIdentifiers: gone) }
      done(!gone.isEmpty)
    }
  }
}

public class PushSyncAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    // every subscriber must answer (Expo waits for all of them before it answers iOS)
    guard let ids = PushSync.ids(userInfo) else { completionHandler(.noData); return }
    PushSync.remove(ids) { removed in completionHandler(removed ? .newData : .noData) }
  }
}

/** The app tells the module is in this build by its presence (src/badge.ts takesClear) and then offers push-clear-v1.
 * `clear` is the same removal for a sync iOS shows to the open app as a notification to present (willPresent, which
 * comes instead of or next to the app delegate call, src/push.ts quietForeground); a second removal of the same ids
 * changes nothing. */
public class PushSyncModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PushSync")
    AsyncFunction("clear") { (list: String, promise: Promise) in
      PushSync.remove(PushSync.ids(["body": ["code": PushSync.code, "clear": list]]) ?? []) { removed in promise.resolve(removed) }
    }
  }
}
