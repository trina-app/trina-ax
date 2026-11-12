// Admin › System on a phone (QA TC-269 step 1, TC-270 step 1) in Chromium (Android's engine). The cases are in
// phone-admin-system.cases.ts.
import { test } from '@playwright/test'
import { systemCases, systemFollowUps } from './phone-admin-system.cases'

systemCases()

test.describe('follow-ups', () => systemFollowUps())
