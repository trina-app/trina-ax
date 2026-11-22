// "Ask to view" in the side panel for a team-file link in a room message that does not open for me (QA S-120,
// components/RoomFileAsk.tsx): the line, who answers (the poster by name, else the owner or an admin), the button and
// what it says after; a waiting ask's date; 'no' falls back to today's line (FileMoved); a share since opens the link.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import { RoomFileAsk } from '../../src/components/RoomFileAsk'
import { installDom, mount, removeDom } from './dom-host'

const R = '01900000-0000-7000-8000-0000000000b1', M = '01900000-0000-7000-8000-0000000000b2'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ACCESS = `/api/rooms/${R}/messages/${M}/file-access`
let routes: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {}
const sent: { key: string; url: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    sent.push({ key, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    return routes[key]?.(init) ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => { sent.length = 0; routes = {} })
afterAll(() => { globalThis.fetch = realFetch; removeDom(); useLocaleStore.setState({ locale: localeBefore }) })
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const panel = () => mount(<MemoryRouter><RoomFileAsk room={{ roomId: R, messageId: M }} path="groups/sales/q3 summary.pdf" fallback="The file can't be found, or you don't have access." /></MemoryRouter>)

test('ask: the line, the generic answerer, [Ask to view]; after it, the sent line', async () => {
  routes[`GET ${ACCESS}`] = () => json(200, { status: 'ask', by: null })
  routes[`POST ${ACCESS}`] = () => json(200, { status: 'sent', askedAt: '2026-11-22T01:00:00.000Z' })
  const m = await panel()
  await m.until(() => m.find('room-file-ask'), 'the ask')
  expect(m.html()).toContain(en('roomFileAsk.title'))
  expect(m.html()).toContain(en('roomFileAsk.byAdmin'))
  // the path asked about is the link's, in the query
  expect(new URL(sent[0]!.url, 'http://x').searchParams.get('path')).toBe('groups/sales/q3 summary.pdf')
  await m.click('room-file-ask-send')
  await m.until(() => m.find('room-file-ask-sent'), 'the sent line')
  expect(m.get('room-file-ask-sent').textContent).toBe(en('linkAccess.sent'))
  expect(sent.find((x) => x.key === `POST ${ACCESS}`)!.body).toEqual({ path: 'groups/sales/q3 summary.pdf' })
  expect(m.find('room-file-ask-send')).toBeNull()
  await m.unmount()
})

test('the poster is named when they answer; a waiting ask shows its date and no button', async () => {
  routes[`GET ${ACCESS}`] = () => json(200, { status: 'asked', askedAt: '2026-11-21T01:00:00.000Z', by: 'Jiwoo Han' })
  const m = await panel()
  await m.until(() => m.find('room-file-ask-sent'), 'the asked line')
  expect(m.html()).toContain(en('roomFileAsk.byName', { name: 'Jiwoo Han' }))
  expect(m.find('room-file-ask-send')).toBeNull()
  expect(m.get('room-file-ask').getAttribute('data-state')).toBe('asked')
  await m.unmount()
})

test('no: today\'s line (through FileMoved), nothing about the file; a share since: Open', async () => {
  routes[`GET ${ACCESS}`] = () => json(200, { status: 'no' })
  routes['GET /api/files/moved'] = () => json(200, { status: 'no' })
  const m = await panel()
  await m.until(() => m.find('file-moved-no'), 'the fallback')
  expect(m.get('file-moved-no').textContent).toBe("The file can't be found, or you don't have access.")
  expect(m.find('room-file-ask')).toBeNull()
  await m.unmount()
  routes[`GET ${ACCESS}`] = () => json(200, { status: 'open', link: 'AbCdEfGhIjKlMnOpQrStUv' })
  const o = await panel()
  await o.until(() => o.find('room-file-ask-open'), 'the open button')
  expect(o.get('room-file-ask-open').textContent).toBe(en('roomFileAsk.open'))
  await o.unmount()
})
