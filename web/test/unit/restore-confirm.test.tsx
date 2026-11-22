// The confirm before a version comes back (components/chat/restoreConfirm.ts): a web page's panel asks what a chat file's
// panel asks (QA b3s S-033, #375's words): the title with the version, whose later versions drop out, who in the chat sees
// the change. And the chat's line in Korean with the right particles (QA TC-b3s-17).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { confirmChatRestore } from '../../src/components/chat/restoreConfirm'
import { DialogHost } from '../../src/components/ui'
import { translate, useLocaleStore } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const CHAT = '01900000-0000-7000-8000-00000000c0b1'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
let audience: () => Response = () => json({})
const locale = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL) => (String(input).split('?')[0] === `/api/chats/${CHAT}/audience` ? audience() : json({ error: { code: 'not_found' } }, 404))) as unknown as typeof fetch
})
afterEach(() => { audience = () => json({}) })
afterAll(() => { globalThis.fetch = realFetch; useLocaleStore.setState({ locale }); removeDom() })

const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => en(k, p)

test('a page restore asks first: the version, whose later versions drop out and who sees the change; no is false', async () => {
  audience = () => json({ kind: 'people', canEdit: false, by: { id: 'junho', name: 'Junho' }, subjects: [], mentionable: [{ id: 'junho', name: 'Junho' }] })
  const m = await mount(<DialogHost />)
  try {
    const asked = confirmChatRestore({ chatId: CHAT, n: 2, dropouts: [{ id: 'Jiwoo', name: 'Jiwoo' }], t, locale: 'en' })
    const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
    expect(dialog.textContent).toContain(en('chatFile.restoreTitle', { n: 2 }))
    expect(dialog.textContent).toContain(en('files.restoreBodyNames', { names: 'Jiwoo' }))
    expect(dialog.textContent).toContain(en('chatFile.restoreSeen', { names: 'Junho' }))
    await m.click('dialog-cancel')
    expect(await asked).toBe(false)
    // a chat nobody else sees (the read fails or names nobody): the plain body, and yes is true
    audience = () => json({}, 500)
    const again = confirmChatRestore({ chatId: CHAT, n: 1, dropouts: [], t, locale: 'en' })
    const d2 = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
    expect(d2.textContent).toContain(en('files.restoreBody'))
    expect(d2.textContent).not.toContain('will see the change')
    await m.click('dialog-confirm')
    expect(await again).toBe(true)
  } finally { await m.unmount() }
})

test('the Korean lines read with the right particles after a page title, a file name and a number', () => {
  expect(translate('ko', 'chat.event.restored', { actor: '박준호', file: '연말 행사 안내', n: 2 })).toBe('박준호님이 연말 행사 안내를 버전 2로 되돌렸어요')
  expect(translate('ko', 'chat.event.restored', { actor: '박준호', file: '주간 실적.xlsx', n: 3 })).toBe('박준호님이 주간 실적.xlsx를 버전 3으로 되돌렸어요')
  expect(translate('ko', 'chatFile.restored', { n: 2 })).toStartWith('버전 2를 ')
  expect(translate('ko', 'chatFile.restored', { n: 3 })).toStartWith('버전 3을 ')
})
