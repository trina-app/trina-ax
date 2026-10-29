import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// This spec owns its stoppable server and does not need the general desktop fake servers.
export default defineConfig({ ...base, testMatch: /offline\.spec\.ts/, webServer: undefined })
