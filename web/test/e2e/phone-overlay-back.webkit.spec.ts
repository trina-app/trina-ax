// Back on a phone closes the open layer first (QA TC-245), in WebKit: the iPhone app's engine. The cases are in
// phone-overlay-back.cases.ts.
import { test } from '@playwright/test'
import { overlayBackCases } from './phone-overlay-back.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })
test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

overlayBackCases()
