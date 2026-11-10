import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Standalone native fixtures (the frame guard, the folder window) own an ephemeral server and need no fake team.
export default defineConfig({ ...base, testMatch: /(rtc-native|folder-window)\.spec\.ts/, webServer: undefined })
