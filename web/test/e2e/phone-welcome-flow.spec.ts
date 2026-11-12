// Getting started on a phone (QA TC-271), in Chromium (Android's engine). The cases: phone-welcome-flow.cases.ts.
import { test } from '@playwright/test'
import { welcomeFlowCases } from './phone-welcome-flow.cases'

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

welcomeFlowCases()
