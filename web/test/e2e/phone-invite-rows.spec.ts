// Phone rows in Admin (QA TC-390, TC-382 item 4) in Chromium (Android's engine), and a computer's unchanged look. The
// cases are in phone-invite-rows.cases.ts.
import { test } from '@playwright/test'
import { computerCases, phoneCases } from './phone-invite-rows.cases'

test.describe('phone', () => phoneCases())

test.describe('computer', () => computerCases())
