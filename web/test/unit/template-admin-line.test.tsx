// Admin › Connected apps: the line under a team template's row says how each member connects it. A sign-in template
// said "Each member connects their own key" (QA tracking TC-2980); it says each member signs in with their own
// account, and a key template keeps its key line (components/integrations/TemplatesView.tsx TemplateRow).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { IntegrationTemplate } from '@mycel/shared/api'
import { translate, useLocaleStore, type Locale } from '../../src/i18n'
import { TemplateRow } from '../../src/components/integrations/TemplatesView'
import { installDom, mount, removeDom } from './dom-host'

const tpl = (auth: IntegrationTemplate['auth']): IntegrationTemplate => ({
  id: 'tpl-1', kind: 'mcp', name: 'Acme Docs', url: 'https://mcp.acme.example/mcp', auth, authHeader: auth === 'header' ? 'X-Api-Key' : null,
  notes: null, access: { everyone: true, groups: [], users: [] }, oauthClient: null, connected: 0, createdBy: null,
  createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z',
})

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => { useLocaleStore.setState({ locale: 'ko' }) })

async function line(auth: IntegrationTemplate['auth'], locale: Locale) {
  useLocaleStore.setState({ locale })
  const m = await mount(<ul><TemplateRow tpl={tpl(auth)} groups={[]} users={[]} onEdit={() => {}} onDeleted={() => {}} /></ul>)
  try { return m.get('template-admin-line').textContent } finally { await m.unmount() }
}

describe('the line under a template in Admin', () => {
  for (const locale of ['en', 'ko'] as const) {
    test(`${locale}: a sign-in template says each member signs in with their own account`, async () => {
      const text = await line('oauth', locale)
      expect(text).toBe(translate(locale, 'integrations.template.eachSignIn'))
      expect(text).not.toBe(translate(locale, 'integrations.template.eachOwn'))
    })
    test(`${locale}: a key template keeps "connects their own key"`, async () => {
      expect(await line('bearer', locale)).toBe(translate(locale, 'integrations.template.eachOwn'))
      expect(await line('header', locale)).toBe(translate(locale, 'integrations.template.eachOwn'))
    })
  }
  test('the English words', async () => {
    expect(await line('oauth', 'en')).toBe('Each member signs in with their own account')
    expect(await line('bearer', 'en')).toBe('Each member connects their own key')
  })
})
