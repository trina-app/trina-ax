// Phone rows in Admin (QA TC-390, TC-382 item 4) in WebKit: the iPhone app's engine. The cases are in
// phone-invite-rows.cases.ts.
import { test } from '@playwright/test'
import { phoneCases } from './phone-invite-rows.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

phoneCases()
