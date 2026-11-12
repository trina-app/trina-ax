// Admin's pages on a phone (QA TC-377, TC-379, TC-382 item 3) in Chromium (Android's engine), and a computer's pages
// unchanged. The cases are in phone-admin-bar.cases.ts.
import { test } from '@playwright/test'
import { adminBarCases, adminBarComputerCases } from './phone-admin-bar.cases'

adminBarCases()
test.describe('a computer', () => adminBarComputerCases())
