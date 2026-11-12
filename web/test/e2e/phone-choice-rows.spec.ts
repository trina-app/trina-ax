// Settings choices on a phone as rows that open a sheet (QA TC-378) in Chromium (Android's engine), and a computer's
// select boxes kept. The cases are in phone-choice-rows.cases.ts.
import { test } from '@playwright/test'
import { desktopCases, phoneCases } from './phone-choice-rows.cases'

phoneCases()

test.describe('a computer', () => desktopCases())
