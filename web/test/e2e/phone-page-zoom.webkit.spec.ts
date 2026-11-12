// No zoom of the whole page in the phone app and the installed app; the picture viewer zooms inside itself (QA TC-246),
// in WebKit: the iPhone app's engine. The cases are in phone-page-zoom.cases.ts.
import { test } from '@playwright/test'
import { pageZoomCases } from './phone-page-zoom.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })
test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

pageZoomCases()
