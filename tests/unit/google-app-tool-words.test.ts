// Every tool the server lists for Gmail, Google Calendar, Google Docs and Google Sheets (server/src/integrations/
// google-apps/catalog.ts) has its title and its line in every app language (web/src/lib/googleApps.ts toolWords), so a
// Korean page never shows the server's English words.
import { expect, test } from 'bun:test'
import { APP_IDS, catalog } from '../../server/src/integrations/google-apps/catalog'
import { DICTS } from '../../web/src/i18n'

test('each Google app tool has a title and a line in all five languages', () => {
  for (const [locale, dict] of Object.entries(DICTS)) {
    for (const app of APP_IDS) {
      for (const tool of catalog(app)) {
        const d = dict as Record<string, string>
        expect({ locale, tool: tool.name, title: !!d[`gapps.tool.${tool.name}`]?.trim(), line: !!d[`gapps.toolDesc.${tool.name}`]?.trim() }).toEqual({ locale, tool: tool.name, title: true, line: true })
      }
    }
  }
})
