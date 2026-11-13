// The connector dialog's collapsed 고급 line (QA TC-204, TC-187): what a member reads before opening Advanced is the
// word 고급 only, no summary of its choices (no "MCP server" / "API" kind, no "(OAuth)"). The open section has them.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { IntegrationDialog } from '../../src/components/integrations/IntegrationDialog'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', username: 'mia', name: 'Mia', role: 'member', prefs: {} }, team: { name: 'Acme', defaultLocale: 'ko' }, groups: [], session: { id: 's', client: 'web' }, server: { version: '0', dev: true } } as unknown as Me } })
})
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }); useSession.setState({ status }) })

test('a member adding a connection reads only 고급 on the closed Advanced, not MCP or OAuth', async () => {
  const m = await mount(<MemoryRouter><IntegrationDialog scope="personal" onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
  try {
    const line = (await m.until(() => m.find('integration-advanced'), 'the collapsed line')).textContent ?? ''
    expect(line).toBe('고급')
    expect(m.find('integration-advanced-summary')).toBeNull()
    expect(m.get('integration-advanced').getAttribute('aria-expanded')).toBe('false')
  } finally { await m.unmount() }
})
