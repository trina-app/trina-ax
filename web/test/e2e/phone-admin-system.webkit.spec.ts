// Admin › System on a phone (QA TC-269 step 1, TC-270 step 1) in WebKit: the iPhone app's engine. The cases are in
// phone-admin-system.cases.ts.
import { test } from '@playwright/test'
import { systemCases } from './phone-admin-system.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

systemCases()
