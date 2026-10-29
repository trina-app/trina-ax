import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Standalone native guard fixture owns an ephemeral server and needs no fake team.
export default defineConfig({ ...base, testMatch: /rtc-native\.spec\.ts/, webServer: undefined })
