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
(filled in when done)
