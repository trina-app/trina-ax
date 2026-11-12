// No zoom of the whole page in the phone app and the installed app; the picture viewer zooms inside itself (QA TC-246),
// in Chromium: Android's engine. The cases are in phone-page-zoom.cases.ts; WebKit (the iPhone's) in
// phone-page-zoom.webkit.spec.ts.
import { test } from '@playwright/test'
import { pageZoomCases } from './phone-page-zoom.cases'

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

pageZoomCases()
