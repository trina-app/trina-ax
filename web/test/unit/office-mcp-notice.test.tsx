// The office owner's one-time card on Admin › Home (QA TC-4470; server/src/office/claude-mcp-notice.ts): what was removed,
// why, where the copy is and how to switch; owners only, nothing when the server has nothing to say, and closed for good.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me, OfficeClaudeMcpNotice } from '@mycel/shared/api'
import { OfficeMcpNotice } from '../../src/pages/admin/OfficeMcpNotice'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const en = (k: Parameters<typeof translate>[1], p: Record<string, string | number> = {}) => translate('en', k, p)
const meAs = (role: 'owner' | 'admin', prefs: Record<string, unknown> = {}) => ({
  user: { id: 'olga', username: 'olga', name: 'Olga', email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
}) as unknown as Me
const NOTICE: OfficeClaudeMcpNotice = { firstAt: '2026-11-17T01:00:00.000Z', names: ['github', 'notes'], moreNames: 0, backupFolder: '~/TeamAX/config/claude-mcp-backups', teamax: '~/TeamAX/teamax' }

let answer: OfficeClaudeMcpNotice | null = NOTICE
const calls: { method: string; url: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('/api/admin/office-claude-mcp-notice')) return json(answer)
    if (url.startsWith('/api/me') && method === 'PATCH') return json(meAs('owner', body?.prefs ?? {}))
    return json({})
  }) as unknown as typeof fetch
})
beforeEach(() => { calls.length = 0; answer = NOTICE; useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => useSession.setState({ status }))
afterAll(() => { globalThis.fetch = realFetch; removeDom() })

const card = () => <MemoryRouter><OfficeMcpNotice /></MemoryRouter>

test('the owner reads what was removed, why, where the copy is and how to switch; closing it saves the preference', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: meAs('owner') } } as never)
  const m = await mount(card())
  try {
    const box = await m.until(() => m.find('admin-office-mcp-notice'), 'the card')
    expect(box.textContent).toContain(en('officeMcpNotice.title'))
    expect(m.get('admin-office-mcp-removed').textContent).toBe(en('officeMcpNotice.removed', { names: 'github, notes' }))
    expect(m.get('admin-office-mcp-folder').textContent).toBe('~/TeamAX/config/claude-mcp-backups')
    expect(box.textContent).toContain('~/TeamAX/teamax configure --claude-token-file <file> && ~/TeamAX/teamax restart')
    expect(box.textContent).toContain('~/TeamAX/teamax claude-mcp backups')
    expect(box.textContent).toContain('~/TeamAX/teamax claude-mcp restore <copy>')
    // plain words: the setting's own name never shows
    expect(box.textContent).not.toMatch(/mcpServers|MCP/)
    m.get('admin-office-mcp-ok').click()
    await m.until(() => (m.find('admin-office-mcp-notice') ? null : true), 'the card closed')
    await m.until(() => calls.find((c) => c.method === 'PATCH' && c.url.startsWith('/api/me')), 'the preference saved')
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ prefs: { officeMcpNotice: 'seen' } })
  } finally { await m.unmount() }
})

test('only other settings went: said so; more names than listed are counted', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: meAs('owner') } } as never)
  answer = { ...NOTICE, names: [] }
  let m = await mount(card())
  try { expect((await m.until(() => m.find('admin-office-mcp-removed'), 'the line')).textContent).toBe(en('officeMcpNotice.removedOther')) } finally { await m.unmount() }
  answer = { ...NOTICE, moreNames: 3 }
  m = await mount(card())
  try { expect((await m.until(() => m.find('admin-office-mcp-removed'), 'the line')).textContent).toBe(en('officeMcpNotice.removedMore', { names: 'github, notes', count: 3 })) } finally { await m.unmount() }
})

test('nothing for an admin, after it was closed, or when the server has nothing to say', async () => {
  for (const [me, a] of [[meAs('admin'), NOTICE], [meAs('owner', { officeMcpNotice: 'seen' }), NOTICE], [meAs('owner'), null]] as const) {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    answer = a
    calls.length = 0
    const m = await mount(card())
    try {
      await new Promise((r) => setTimeout(r, 50))
      expect(m.find('admin-office-mcp-notice')).toBeNull()
      // an admin and a closed card do not even ask
      if (a) expect(calls.some((c) => c.url.startsWith('/api/admin/office-claude-mcp-notice'))).toBe(false)
    } finally { await m.unmount() }
  }
})
