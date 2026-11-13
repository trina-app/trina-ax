// The iPhone's edge swipe on the team page, on or off (App.tsx, src/nav.ts swipeGate).
//
// WebKit slides the page away over a picture of the screen it goes back to. It takes that picture as the person leaves
// a screen, but only while allowsBackForwardNavigationGestures is on (WKWebView setAllowsBackForwardNavigationGestures
// also sets setShouldRecordNavigationSnapshots). A screen left while the swipe was off has no picture, and a swipe back
// to it shows a plain white view (ViewGestureControllerIOS beginSwipeGesture) until the page has drawn it again: white
// in dark mode. The app turns the swipe off at a tab's root (nav-v1), so every swipe back to a root flashed white.
//
// So the app keeps allowsBackForwardNavigationGestures on (WebKit keeps taking pictures) and turns the swipe itself off
// here: WebKit's back and forward swipes are UIScreenEdgePanGestureRecognizers on the WKWebView (its
// _UINavigationInteractiveTransitionBase controllers), and their isEnabled is what the property toggles too. Only public
// UIKit API. Answers how many it set: 0 means no web view or no such recognizer (a later iOS), and the app then gates the
// swipe with the property as before.
import ExpoModulesCore
import UIKit
import WebKit

public class EdgeSwipeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EdgeSwipe")

    AsyncFunction("setEnabled") { (enabled: Bool) -> Int in
      var set = 0
      for scene in UIApplication.shared.connectedScenes {
        guard let windows = (scene as? UIWindowScene)?.windows else { continue }
        for window in windows { set += Self.apply(enabled, in: window) }
      }
      return set
    }.runOnQueue(.main)
  }

  private static func apply(_ enabled: Bool, in view: UIView) -> Int {
    if let web = view as? WKWebView {
      var set = 0
      for case let edge as UIScreenEdgePanGestureRecognizer in web.gestureRecognizers ?? [] {
        edge.isEnabled = enabled
        set += 1
      }
      return set
    }
    return view.subviews.reduce(0) { $0 + apply(enabled, in: $1) }
  }
}
