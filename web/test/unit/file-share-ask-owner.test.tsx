// QA TC-7230 / TC-7231. The Share dialog for someone who may not share a file names who to ask and lets them ask the
// owner to share it with people (POST /api/files/shared/:id/ask-for; people only, never a group or Everyone). The
// owner's card for an access request says what Share does, and that the person is outside the project when the server
// says so (fileShare.outside), with "Share this file".
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { FileShares, InboxNotification, Me } from '@mycel/shared/api'
import { FileShareDialog } from '../../src/components/FileShareDialog'
import { FileRequestExtras, requestWhat } from '../../src/components/FileRequestNotice'
import { DialogHost } from '../../src/components/ui'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const en = (k: Parameters<typeof translate>[1], p: Record<string, string | number> = {}) => translate('en', k, p)
const PATH = 'projects/Launch/plan.txt'
const meAs = (role: 'member' | 'guest' = 'member') => ({
  user: { id: 'junho', username: 'junho', name: 'Junho', email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
}) as unknown as Me
const base = (o: Partial<FileShares> = {}): FileShares => ({
  path: PATH, link: { id: 'L'.repeat(22), url: '/f/' + 'L'.repeat(22) }, canShare: false, owner: { id: 'seoyeon', name: 'Seoyeon' }, mine: false, teamFile: true, people: [], ...o,
})

let answer: FileShares = base()
const calls: { method: string; url: string; body: any }[] = []
const realFetch = globalThis.fetch
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    const json = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { 'content-type': 'application/json' } })
    if (url.includes('/ask-for')) return json({ asked: 1, already: 0 })
    if (url.startsWith('/api/files/requests/')) return json({ state: 'approved' })
    if (url.startsWith('/api/files/shares')) return json(answer)
    if (url.startsWith('/api/people')) return json({ people: [{ id: 'jiwoo', name: 'Jiwoo' }, { id: 'seoyeon', name: 'Seoyeon' }] })
    if (url.startsWith('/api/groups')) return json({ groups: [{ id: 'g1', name: 'Sales' }] })
    return json({})
  }) as unknown as typeof fetch
})
beforeEach(() => {
  calls.length = 0
  answer = base()
  useLocaleStore.setState({ locale: 'en' })
  useUi.setState({ toasts: [] } as never)
  useSession.setState({ status: { kind: 'signed-in', me: meAs() } } as never)
})
afterEach(() => useSession.setState({ status }))
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
})

async function dialog() {
  const m = await mount(<MemoryRouter><FileShareDialog path={PATH} onClose={() => {}} /><DialogHost /></MemoryRouter>)
  await m.until(() => m.find('file-share-people'), 'the dialog read')
  return m
}

test('a member who may not share: who to ask by name, and Ask <owner> for the people picked (no groups offered)', async () => {
  const m = await dialog()
  try {
    expect(m.get('file-share-why').textContent).toBe('Only Seoyeon can share this file. Ask Seoyeon to share it.')
    expect(m.find('file-share-picker-search')).toBeNull()
    expect(m.find('file-share-ask')).toBeNull()
    await m.type('file-share-ask-picker-search', 'sales')
    await m.settle(200)
    expect(m.find('participant-add-group-g1')).toBeNull()
    await m.type('file-share-ask-picker-search', 'jiwoo')
    await m.click(await m.until(() => m.find('participant-add-user-jiwoo'), 'Jiwoo to add', 2000))
    const ask = m.get('file-share-ask')
    expect(ask.textContent).toBe('Ask Seoyeon')
    await m.click(ask)
    const sent = await m.until(() => calls.find((c) => c.url.includes('/ask-for')), 'the ask sent')
    expect(sent.method).toBe('POST')
    expect(sent.url).toBe(`/api/files/shared/${'L'.repeat(22)}/ask-for`)
    expect(sent.body).toEqual({ people: ['jiwoo'] })
    await m.until(() => useUi.getState().toasts.some((x) => x.text === 'Asked Seoyeon to share it.'), 'the toast')
  } finally {
    await m.unmount()
  }
})

test('the owner, sharing off, a guest, no owner: no ask', async () => {
  for (const [o, role, why] of [
    [{ canShare: true, mine: true }, 'member', null],
    [{ off: true as const }, 'member', en('fileShare.off')],
    [{}, 'guest', 'Only Seoyeon can share this file. Ask Seoyeon to share it.'],
    [{ owner: null }, 'member', en('fileShare.ownerOnly')],
  ] as const) {
    answer = base(o as Partial<FileShares>)
    useSession.setState({ status: { kind: 'signed-in', me: meAs(role) } } as never)
    const m = await dialog()
    try {
      expect(m.find('file-share-ask-picker-search')).toBeNull()
      expect(m.find('file-share-why')?.textContent ?? null).toBe(why)
    } finally {
      await m.unmount()
    }
  }
})

const notice = (fileShare: NonNullable<InboxNotification['fileShare']>): InboxNotification => ({
  id: 'n1', eventType: 'file.access_requested', sourceId: 's', code: 'file.access_requested', createdAt: '2026-11-22T00:00:00.000Z', readAt: null, chatId: null, outcome: null, link: 'file', fileShare,
}) as unknown as InboxNotification

test('the request card: what Share does, outside the project only when the server says so, and "Share this file"', async () => {
  const t = ((k: never, p?: never) => translate('en', k, p)) as never
  const f = { by: 'Jiwoo', name: 'plan.pdf', linkId: 'x', requestId: 'r1', state: 'pending' as const, canAnswer: true as const }
  expect(requestWhat(t, f)).toBe('Shares only this file with Jiwoo, view only.')
  expect(requestWhat(t, { ...f, outside: 'project' })).toBe("Shares only this file with Jiwoo, view only. Jiwoo isn't in this project, so its other files stay hidden.")
  // asked for someone else: the person who would get it
  expect(requestWhat(t, { ...f, by: 'Junho', for: 'Jiwoo' })).toBe('Shares only this file with Jiwoo, view only.')
  for (const l of ['ko', 'ja', 'zh', 'es', 'id'] as const) expect(translate(l, 'fileRequest.whatProject', { name: 'X' })).not.toBe(en('fileRequest.whatProject', { name: 'X' }))
  const m = await mount(<FileRequestExtras item={notice({ ...f, outside: 'project' })} onRead={() => {}} onChanged={() => {}} />)
  try {
    expect(m.get('file-request-what').getAttribute('data-outside')).toBe('project')
    expect(m.get('file-request-share').textContent).toBe('Share this file')
    await m.click('file-request-share')
    await m.until(() => m.find('file-request-done'), 'answered')
    expect(m.find('file-request-what')).toBeNull()
  } finally {
    await m.unmount()
  }
})
