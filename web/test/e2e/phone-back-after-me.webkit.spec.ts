// Android Back after 나 (QA TC-404) in WebKit (the same page code the iPhone app runs). The cases are in
// phone-back-after-me.cases.ts.
import { test } from '@playwright/test'
import { backAfterMeCases } from './phone-back-after-me.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })
backAfterMeCases()
