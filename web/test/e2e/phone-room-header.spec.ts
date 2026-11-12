// QA TC-257 on a phone: the room header and the file viewer's bars. The cases are in phone-room-header.cases.ts; here in
// Chromium (Android's engine), and in WebKit (the iPhone app's) in phone-room-header.webkit.spec.ts.
import { test } from '@playwright/test'
import { roomHeaderCases } from './phone-room-header.cases'

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

roomHeaderCases()
