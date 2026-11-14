// Settings › Profile › Delete account (src/components/settings/AccountDeletion.tsx; App Store review 5.1.1(v), Google
// Play): the date it would be deleted, a short list of what goes and stays, one button that asks for the password; once
// asked the date and a button to keep the account; the owner is sent to Members (and, on a hosted team, told about
// deleting the whole team). What the page sends, and the inbox texts of the owners and of the person.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDeletionRequest, Me } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { AccountDeletion, deletionDueText, deletionNoticeText, deletionRowText } from '../../src/components/settings/AccountDeletion'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const me = (role: 'owner' | 'admin' | 'member'): Me => ({
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me)
const DUE = '2026-11-21T12:00:00.000Z'

describe('the page', () => {
  const realFetch = globalThis.fetch
  const before = useLocaleStore.getState().locale
  const status = useSession.getState().status
  let state: AccountDeletionRequest = { state: 'none', requestedAt: null, dueAt: null, auditDays: 30 }
  const calls: { key: string; body: string | null }[] = []
  const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      calls.push({ key, body: typeof init?.body === 'string' ? init.body : null })
      if (key === 'GET /api/me/deletion-request') return json(state)
      if (key === 'POST /api/me/deletion-request') {
        if (JSON.parse(String(init?.body)).password !== 'right one') return json({ error: { code: 'forbidden', message: '비밀번호가 맞지 않아요.', fields: { 'body.password': 'wrong password' } } }, 403)
        return json((state = { state: 'pending', requestedAt: '2026-11-14T12:00:00.000Z', dueAt: DUE, auditDays: 30 }))
      }
      if (key === 'DELETE /api/me/deletion-request') return json((state = { state: 'none', requestedAt: null, dueAt: null, auditDays: 30 }))
      return json({ error: { code: 'internal', message: `no route ${key}` } }, 500)
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale: before })
    useSession.setState({ status })
  })

  test('ask: the date and what happens, one button; the password in a dialog (a wrong one said there); then the date and a keep button', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('member') } } as never)
    state = { state: 'none', requestedAt: null, dueAt: null, auditDays: 30 }
    const m = await mount(<MemoryRouter><AccountDeletion /></MemoryRouter>)
    try {
      await m.until(() => m.find('account-deletion-none'), 'the page')
      const page = m.get('account-deletion').textContent ?? ''
      expect(page).toContain('계정 삭제')
      expect(page).toContain('7일 뒤인')
      expect(page).toContain('팀장과 관리자에게 알림이 가요')
      expect(page).toContain('팀장만 읽을 수 있는 보관 폴더로 옮겨져요')
      expect(page).toContain('대화방에 보낸 메시지와 파일(내 이름으로 남아요)')
      // TC-1920: a chat shared with people by name goes with the account (auth/sweeper.ts purges every chat with no
      // shared_at); only a shared project chat stays
      expect(page).toContain('사람이나 그룹에게 공유한 대화')
      expect(page).toContain('프로젝트에 공유한 대화')
      expect(page).toContain('팀 활동 기록에 남는 삭제 기록(30일)')
      expect(page).toContain('최대 8주')
      expect(m.container.querySelectorAll('button').length).toBe(1)
      await m.click('account-deletion-request')
      await m.until(() => m.find('reauth-password'), 'the password dialog')
      // the fake document's inputs have no select(), which the dialog calls after a refusal
      Object.assign(m.get('reauth-password'), { select: () => {} })
      await m.type('reauth-password', 'wrong')
      await m.click('reauth-confirm')
      await m.until(() => (m.html().includes('비밀번호가 맞지 않아요') ? true : null), 'the wrong password said in the dialog')
      expect(m.find('account-deletion-none')).not.toBeNull()
      await m.type('reauth-password', 'right one')
      await m.click('reauth-confirm')
      await m.until(() => m.find('account-deletion-pending'), 'the pending state')
      const sent = calls.filter((c) => c.key === 'POST /api/me/deletion-request').map((c) => c.body)
      expect(sent).toEqual([JSON.stringify({ confirm: true, password: 'wrong' }), JSON.stringify({ confirm: true, password: 'right one' })])
      expect(m.find('reauth-password')).toBeNull()
      expect(m.get('account-deletion-date').textContent).toContain('2026')
      expect(m.get('account-deletion-date').textContent).toContain('삭제돼요')
      expect(m.find('account-deletion-request')).toBeNull()
      expect(m.container.querySelectorAll('button').length).toBe(1)
      await m.click('account-deletion-cancel')
      await m.until(() => m.find('account-deletion-none'), 'the button again')
      expect(calls.some((c) => c.key === 'DELETE /api/me/deletion-request')).toBe(true)
    } finally { await m.unmount() }
  })

  test('an admin\'s own request is told to the team owner only, and the words say so', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('admin') } } as never)
    state = { state: 'none', requestedAt: null, dueAt: null, auditDays: 30 }
    const m = await mount(<MemoryRouter><AccountDeletion /></MemoryRouter>)
    try {
      await m.until(() => m.find('account-deletion-none'), 'the page')
      const page = m.get('account-deletion').textContent ?? ''
      expect(page).toContain('팀장에게 알림이 가요')
      expect(page).not.toContain('관리자')
    } finally { await m.unmount() }
  })

  test('the owner: cannot ask, no button, a link to Members; on a hosted team, deleting the whole team is mentioned', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('owner') } } as never)
    state = { state: 'owner', requestedAt: null, dueAt: null }
    const m = await mount(<MemoryRouter><AccountDeletion /></MemoryRouter>)
    try {
      await m.until(() => m.find('account-deletion-owner'), 'the owner state')
      expect(m.container.querySelectorAll('button').length).toBe(0)
      expect(m.get('account-deletion').textContent).toContain('팀장을 넘기면')
      expect(m.get('account-deletion-owner-hosted').textContent).toContain('팀 전체를 삭제')
      expect(m.get('account-deletion-transfer').getAttribute('href')).toBe('/admin/members')
    } finally { await m.unmount() }
  })
})

describe('texts', () => {
  test('English reads naturally, with the plural of days', () => {
    expect(en('accountDeletion.title')).toBe('Delete account')
    expect(en('accountDeletion.when', { date: 'Nov 21, 2026', days: 7 })).toContain('on Nov 21, 2026, 7 days from now.')
    expect(en('accountDeletion.kept', { days: 1 })).toContain('(1 day)')
    expect(en('accountDeletion.kept', { days: 90 })).toContain('(90 days)')
    expect(en('accountDeletion.rowHint', { days: 7 })).toBe('Your account is deleted 7 days after you ask. You can cancel until then.')
  })
  test('TC-1920: chats shared with people or groups are listed as deleted; only shared project chats stay, in every language', () => {
    expect(en('accountDeletion.goes')).toContain('your private chats, the chats you shared with people or groups, your memories')
    expect(en('accountDeletion.stays')).toContain('files in team folders, shared project chats,')
    const project: Record<string, string> = { ko: '프로젝트', ja: 'プロジェクト', zh: '项目', id: 'proyek', es: 'proyectos', en: 'project' }
    const people: Record<string, string> = { ko: '그룹', ja: 'グループ', zh: '群组', id: 'grup', es: 'grupos', en: 'groups' }
    for (const l of Object.keys(project)) {
      expect(translate(l as never, 'accountDeletion.stays')).toContain(project[l])
      expect(translate(l as never, 'accountDeletion.goes')).toContain(people[l])
    }
  })
  test('the owners\' inbox: a name and the date while it waits; taken back; done; an older server with no detail', () => {
    expect(deletionNoticeText(ko, { deletionRequest: { name: '민지', state: 'open' } })).toBe('민지님이 계정 삭제를 요청했어요.')
    expect(deletionNoticeText(en, { deletionRequest: { name: 'Minji', state: 'open', dueAt: DUE } }, 'en')).toBe('Minji asked to have their account deleted. It is deleted on Nov 21, 2026.')
    expect(deletionNoticeText(ko, { deletionRequest: { name: '민지', state: 'cancelled' } })).toBe('민지님이 계정 삭제를 취소했어요.')
    expect(deletionNoticeText(ko, { deletionRequest: { name: null, state: 'handled' } })).toBe('계정이 삭제됐어요.')
    expect(deletionNoticeText(ko, {})).toBe('팀원이 계정 삭제를 요청했어요.')
  })
  test('the person\'s own date notice: the date while it is open, closed after', () => {
    expect(deletionDueText(en, { deletionDue: { dueAt: DUE } }, 'en')).toContain('your account is deleted on Nov 21, 2026.')
    expect(deletionDueText(en, { deletionDue: { dueAt: null } }, 'en')).toBe('Your account deletion request is closed.')
  })
})

// TC-1976: Settings › Profile's row says the date while a deletion is pending and offers "Keep my account" there, not
// "Delete my account" again
describe('the profile row', () => {
  test('pending: the date and Keep my account; none, the owner, or not read yet: the link with the usual hint', () => {
    const pending = deletionRowText(en, { state: 'pending', requestedAt: '2026-11-14T12:00:00.000Z', dueAt: DUE }, 'en')
    expect(pending.keep).toBe(true)
    expect(pending.hint).toContain('Your account will be deleted on')
    expect(pending.hint).toContain('2026')
    expect(en('accountDeletion.cancel')).toBe('Keep my account')
    // a request from before automatic deletion (no date yet) says when it was asked
    expect(deletionRowText(en, { state: 'pending', requestedAt: '2026-11-14T12:00:00.000Z', dueAt: null }, 'en')).toMatchObject({ keep: true, hint: expect.stringContaining('You asked on') })
    const plain = en('accountDeletion.rowHint', { days: 7 })
    for (const v of [null, { state: 'none' as const, requestedAt: null, dueAt: null }, { state: 'owner' as const, requestedAt: null, dueAt: null }]) {
      expect(deletionRowText(en, v, 'en')).toEqual({ keep: false, hint: plain })
    }
    // the team's language too
    expect(deletionRowText(ko, { state: 'pending', requestedAt: null, dueAt: DUE }, 'ko').hint).not.toBe(ko('accountDeletion.rowHint', { days: 7 }))
  })
})
