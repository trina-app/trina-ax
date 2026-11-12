// Member screens on a phone (QA TC-380, TC-381, TC-382 items 1–2) in WebKit: the iPhone app's engine. The cases are in
// phone-member-pages.cases.ts.
import { test } from '@playwright/test'
import { memberPageCases } from './phone-member-pages.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

memberPageCases()
