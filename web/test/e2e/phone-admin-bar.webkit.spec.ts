// Admin's pages on a phone (QA TC-377, TC-379, TC-382 item 3) in WebKit: the iPhone app's engine. The cases are in
// phone-admin-bar.cases.ts.
import { test } from '@playwright/test'
import { adminBarCases } from './phone-admin-bar.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

adminBarCases()
