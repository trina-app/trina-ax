# Phones: Android Back after 나 goes to 트리나, not out of the app (TC-404)

Reproduced on a real Android phone (QA app, nav-v1) on dev 92ed2db2c: 트리나 → 나 → 프로젝트 (in the 나 dialog's own tab
bar) → Android Back left the app. Expected: 트리나, as from 프로젝트 tapped on 트리나's own bar.

## Plan
- Find the cause with evidence: a fake app bridge that records every `nav` with its path (the page side), and the QA
  app on an isolated Android emulator for the app side (load starts, the bridge fenced or not).
- Fix it on the web side if that is enough (it reaches every app build; iOS 1.0.5 build 9 is in TestFlight).
- e2e (Chromium and WebKit) for: 트리나 → 나 → 프로젝트 → Back; 나 → 대화 → Back; 나 › 보안 → Back → 나 → 프로젝트 → Back;
  the old paths (트리나 → 프로젝트 → Back; 프로젝트 › project › Back ×2); the app resetting what it heard.
- Unit tests in `web/test/unit/app-nav.test.ts` for any pure-function change.

## Result
- **Cause (evidence):** a fake app bridge recording every `nav` with its path showed 트리나 `{canGoBack:false,home:true}` →
  나 `{false,false}` → 프로젝트: **nothing sent**. `sendNav` skipped a send equal to the last one for the same bridge, and
  프로젝트's root has the same answer as 나's root. Android's app forgets what it heard when the WebView reports some
  same-document moves as a load start (`mobile/App.tsx` onLoadStart → `setPageNav(null)`), so with nothing heard again it
  used the WebView's history and left the app. 트리나 → 프로젝트 worked because the answer changed (home true → false).
- **Fix (web only, reaches every app build):** the skip key also has the history entry (address and key), so each screen
  tells the app again even with the same answer (`web/src/lib/mobile.ts`).
- **Tests:** `phone-back-after-me` e2e 8/8 (Chromium and WebKit; the app's own `backAction` run on the last `nav`):
  트리나 → 나 → 프로젝트 / 대화 → start tab → exit, 나 › 보안 → Back → 나 → 프로젝트, 트리나 → 프로젝트 as before. Without the
  fix the three TC-404 cases fail. `web/test/unit/mobile.test.ts` + `app-nav.test.ts` 38/38 (new: the same answer on
  another screen is sent again). phone-app-nav, phone-back-parent, phone-overlay-back, phone-projects-tab, phone-nav
  46/46. Typecheck passes.
