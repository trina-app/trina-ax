// The phone's 프로젝트 tab (QA TC-255) in WebKit: the iPhone app's engine. The cases are in phone-projects-tab.cases.ts.
import { test } from '@playwright/test'
import { projectsTabCases } from './phone-projects-tab.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

projectsTabCases()
