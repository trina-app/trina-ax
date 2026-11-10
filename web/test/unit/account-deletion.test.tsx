// Settings › Profile › 계정 삭제 요청 (src/components/settings/AccountDeletion.tsx; App Store review 5.1.1(v)): one short
// paragraph and one button per state (ask / pending with a cancel / the owner, sent to Team settings), what the page
// sends, and the owners' inbox text while the request waits, after a cancel and once the account is deleted.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDeletionRequest, Me } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { AccountDeletion, deletionNoticeText } from '../../src/components/settings/AccountDeletion'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const me = (role: 'owner' | 'admin' | 'member'): Me => ({
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me)

describe('the page', () => {
  const realFetch = globalThis.fetch
  const before = useLocaleStore.getState().locale
  const status = useSession.getState().status
  let state: AccountDeletionRequest = { state: 'none', requestedAt: null }
  const calls: { key: string; body: string | null }[] = []
  const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      calls.push({ key, body: typeof init?.body === 'string' ? init.body : null })
      if (key === 'GET /api/me/deletion-request') return json(state)
      if (key === 'POST /api/me/deletion-request') return json((state = { state: 'pending', requestedAt: '2026-11-05T01:00:00.000Z' }))
      if (key === 'DELETE /api/me/deletion-request') return json((state = { state: 'none', requestedAt: null }))
      return json({ error: { code: 'internal', message: `no route ${key}` } }, 500)
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale: before })
    useSession.setState({ status })
  })

  test('ask: what happens and one button; then when it was asked and a cancel; cancel brings the button back', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('member') } } as never)
    state = { state: 'none', requestedAt: null }
    const m = await mount(<MemoryRouter><AccountDeletion /></MemoryRouter>)
    try {
      await m.until(() => m.find('account-deletion-none'), 'the page')
      const page = m.get('account-deletion').textContent ?? ''
      expect(page).toContain('계정 삭제 요청')
      expect(page).toContain('팀장과 관리자에게 앱 안에서 알림이 가고, 그중 한 사람이 계정을 삭제해요')
      expect(page).toContain('팀장만 읽을 수 있는 보관 폴더로 옮겨지고')
      expect(page).not.toContain('파일도 지워져요')
      expect(page).toContain('14일 뒤')
      expect(page).toContain('팀 폴더에 둔 파일은 팀에 남아요')
      expect(m.container.querySelectorAll('button').length).toBe(1)
      await m.click('account-deletion-request')
      await m.until(() => m.find('account-deletion-pending'), 'the pending state')
      expect(calls.find((c) => c.key === 'POST /api/me/deletion-request')?.body).toBe(JSON.stringify({ confirm: true }))
      expect(m.get('account-deletion').textContent).toContain('그때까지는 지금처럼 쓸 수 있어요')
      expect(m.find('account-deletion-request')).toBeNull()
      expect(m.container.querySelectorAll('button').length).toBe(1)
      await m.click('account-deletion-cancel')
      await m.until(() => m.find('account-deletion-none'), 'the button again')
      expect(calls.some((c) => c.key === 'DELETE /api/me/deletion-request')).toBe(true)
    } finally { await m.unmount() }
  })

  test('an admin\'s own request goes to the team owner only, and the words say so', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('admin') } } as never)
    state = { state: 'none', requestedAt: null }
    const m = await mount(<MemoryRouter><AccountDeletion /></MemoryRouter>)
    try {
      await m.until(() => m.find('account-deletion-none'), 'the page')
      const page = m.get('account-deletion').textContent ?? ''
      expect(page).toContain('팀장에게 앱 안에서 알림이 가고, 팀장이 계정을 삭제해요')
      expect(page).not.toContain('관리자')
      await m.click('account-deletion-request')
      await m.until(() => m.find('account-deletion-pending'), 'the pending state')
      expect(m.get('account-deletion').textContent).toContain('팀장이 처리하면')
      expect(m.get('account-deletion').textContent).not.toContain('관리자')
    } finally { await m.unmount() }
  })

  test('the owner: cannot ask, no button, a link to Team settings to hand the owner role over', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('owner') } } as never)
    state = { state: 'owner', requestedAt: null }
    const m = await mount(<MemoryRouter><AccountDeletion /></MemoryRouter>)
    try {
      await m.until(() => m.find('account-deletion-owner'), 'the owner state')
      expect(m.container.querySelectorAll('button').length).toBe(0)
      expect(m.get('account-deletion').textContent).toContain('팀장을 넘기면')
      expect(m.get('account-deletion-transfer').getAttribute('href')).toBe('/admin/members')
    } finally { await m.unmount() }
  })
})

describe('texts', () => {
  test('English reads naturally, with the plural of days', () => {
    expect(en('accountDeletion.title')).toBe('Request account deletion')
    expect(en('accountDeletion.body', { days: 1 })).toContain('after 1 day,')
    expect(en('accountDeletion.body', { days: 1 })).toContain('archive that only the team owner can read')
    expect(en('accountDeletion.body', { days: 30 })).toContain('after 30 days,')
  })
  test('the owners\' inbox: a name while the account is there; taken back; done; an older server with no detail', () => {
    expect(deletionNoticeText(ko, { deletionRequest: { name: '민지', state: 'open' } })).toBe('민지님이 계정 삭제를 요청했어요.')
    expect(deletionNoticeText(ko, { deletionRequest: { name: '민지', state: 'cancelled' } })).toBe('민지님이 계정 삭제 요청을 취소했어요.')
    expect(deletionNoticeText(ko, { deletionRequest: { name: null, state: 'handled' } })).toBe('계정 삭제 요청을 처리했어요.')
    expect(deletionNoticeText(ko, {})).toBe('팀원이 계정 삭제를 요청했어요.')
    expect(deletionNoticeText(en, { deletionRequest: { name: 'Minji', state: 'open' } })).toBe('Minji asked to have their account deleted.')
  })
})
