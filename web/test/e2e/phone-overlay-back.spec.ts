// Back on a phone closes the open layer first (QA TC-245): the cases are in phone-overlay-back.cases.ts; here in
// Chromium (Android's engine), and in WebKit (the iPhone app's) in phone-overlay-back.webkit.spec.ts.
import { test } from '@playwright/test'
import { overlayBackCases } from './phone-overlay-back.cases'

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

overlayBackCases()
