// QA TC-3082: files the AI made before stored keys were hidden in saved files, that still hold one, give their person
// one Activity notice (files.stored_key; server/src/integrations/connections/file-scan.ts): how many, and under it the
// files themselves to open (only the ones the server says they may open now). The row opens nothing and keeps "Mark as
// read"; it never shows the key.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { InboxNotification, uuidv7, type Me } from '@mycel/shared/api'
import { DICTS, translate, useLocaleStore } from '../../src/i18n'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import Activity from '../../src/pages/Activity'
import { noticeLink, noticeText } from '../../src/components/settings/Notifications'
import { installDom, mount, removeDom } from './dom-host'
import { ME } from './rooms-fixtures'

setDefaultTimeout(30_000)
const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const notice = (keyFiles?: InboxNotification['keyFiles']) => InboxNotification.parse({
  id: uuidv7(), eventType: 'files.stored_key', sourceId: 'scan', code: 'files.stored_key', createdAt: new Date().toISOString(), readAt: null, chatId: null, link: null, outcome: null,
  ...(keyFiles ? { keyFiles } : {}),
})
const text = (item: InboxNotification, locale: 'en' | 'ko' = 'en') => renderToStaticMarkup(<>{noticeText(item, (k, p) => translate(locale, k, p), locale)}</>)
const own = `users/${ME.id}`

describe('the words', () => {
  test('how many files, what to do; the files that are gone; an older server', () => {
    expect(text(notice({ n: 2, files: [] }))).toBe('2 files the AI made for you have a saved key of a connected service in them. Open each one and remove the key, or delete the file.')
    expect(text(notice({ n: 1, files: [] }))).toBe('1 file the AI made for you has a saved key of a connected service in it. Open it and remove the key, or delete the file.')
    expect(text(notice({ n: 3, files: [] }), 'ko')).toBe('AI가 만든 파일 3개에 연결한 서비스의 저장된 키가 들어 있어요. 파일을 하나씩 열어 키를 지우거나 파일을 삭제해 주세요.')
    expect(text(notice({ n: 0, files: [] }))).toBe(en('notifications.event.files.stored_keyGone'))
    expect(text(notice())).toBe(en('notifications.event.files.stored_key'))
    // the row itself opens nothing: the files under it do
    expect(noticeLink(notice({ n: 1, files: [{ path: `${own}/a.md` }] }))).toBeNull()
  })
  test('every language, plain words', () => {
    const keys = ['notifications.event.files.stored_key', 'notifications.event.files.stored_keyN', 'notifications.event.files.stored_keyGone', 'notifications.keyFiles.list', 'notifications.keyFiles.more'] as const
    for (const [locale, d] of Object.entries(DICTS)) for (const k of keys) {
      expect({ locale, k, set: !!d[k], jargon: /\b(MCP|OAuth|token|secret|cache|API)\b/i.test(d[k] ?? '') }).toEqual({ locale, k, set: true, jargon: false })
    }
  })
})

const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'en' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
let inbox: InboxNotification[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/api/notifications') return json({ items: inbox, nextCursor: null, unreadCount: inbox.filter((x) => !x.readAt).length, roomUnreadCount: 0 })
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => { useRooms.getState().reset(); useSession.setState({ status }) })
afterAll(() => { globalThis.fetch = realFetch; removeDom(); useLocaleStore.setState({ locale }) })

describe('the row in Activity', () => {
  test('the files under it, each a link to open it, by name and place; "and N more" past the list; Mark as read stays', async () => {
    inbox = [notice({ n: 4, files: [{ path: `${own}/notes.md` }, { path: `${own}/reports/q3.docx` }, { path: 'shared/sales/plan.pdf' }] })]
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    useRooms.setState({ rooms: [], loaded: true })
    const m = await mount(<MemoryRouter initialEntries={['/activity']}><Activity /></MemoryRouter>)
    try {
      await m.until(() => m.find('notification-key-files'), 'the file list')
      const links = m.container.ownerDocument!.body.querySelectorAll('[data-testid="notification-key-file"]') as unknown as { getAttribute(n: string): string | null; textContent: string }[]
      expect([...links].map((a) => a.getAttribute('href'))).toEqual([
        `/files/view?path=${encodeURIComponent(`${own}/notes.md`)}`, `/files/view?path=${encodeURIComponent(`${own}/reports/q3.docx`)}`, `/files/view?path=${encodeURIComponent('shared/sales/plan.pdf')}`,
      ])
      expect([...links][0]!.textContent).toContain('notes.md')
      // the place in the sidebar's words, never users/<id>
      expect([...links][1]!.textContent).not.toContain(`users/${ME.id}`)
      expect(m.get('notification-key-files-more').textContent).toBe('and 1 more')
      expect(m.get('notification-text').textContent).toContain('4 files the AI made for you')
      // the row is no link: "Mark as read" stays beside it
      expect(m.html()).toContain(en('notifications.markRead'))
    } finally { await m.unmount() }
  })
})
