// Home on a phone like an AI app (QA TC-391) in WebKit, the iPhone app's engine. The cases are in
// phone-home-centered.cases.ts.
import { test } from '@playwright/test'
import { homeCenteredCases } from './phone-home-centered.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

homeCenteredCases()
