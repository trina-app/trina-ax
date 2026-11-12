// Connectors on a phone (QA TC-262 step 1) in WebKit: the iPhone app's engine. The cases are in
// phone-connectors.cases.ts.
import { test } from '@playwright/test'
import { connectorsCases } from './phone-connectors.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

connectorsCases()
