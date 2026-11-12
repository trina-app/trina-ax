// Settings choices on a phone as rows that open a sheet (QA TC-378) in WebKit: the iPhone app's engine. The cases are
// in phone-choice-rows.cases.ts.
import { test } from '@playwright/test'
import { phoneCases } from './phone-choice-rows.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

phoneCases()
