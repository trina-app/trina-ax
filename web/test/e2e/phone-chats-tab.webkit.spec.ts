// The phone's 대화 tab (QA TC-256) in WebKit: the iPhone app's engine. The cases are in phone-chats-tab.cases.ts.
import { test } from '@playwright/test'
import { chatsTabCases } from './phone-chats-tab.cases'

// WebKit grants no clipboard permissions: none are asked for
test.use({ browserName: 'webkit', permissions: [] })

chatsTabCases()
