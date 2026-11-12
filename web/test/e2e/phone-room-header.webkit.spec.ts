// QA TC-257 on a phone, in WebKit: the iPhone app's engine. The cases are in phone-room-header.cases.ts.
import { test } from '@playwright/test'
import { roomHeaderCases } from './phone-room-header.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })
test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

roomHeaderCases()
