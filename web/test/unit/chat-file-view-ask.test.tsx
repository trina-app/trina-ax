// A team file linked in a shared chat that does not open for me and that the chat's creator cannot add (QA after #651:
// the panel said only "can't be found, or you don't have access"). The chat's file-access answers view: the room
// link's [Ask to view] (components/RoomFileAsk.tsx ViewAsk) with who answers, its POST, the sent line; viewAsked: its
// date; open with a link: Open. 'no': the plain line and who can share it (components/FileMoved.tsx).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import { ChatFileAsk } from '../../src/components/ChatFileAsk'
import { installDom, mount, removeDom } from './dom-host'

const C = '01900000-0000-7000-8000-0000000000c1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ACCESS = `/api/chats/${C}/file-access`
const PATH = 'users/qa-admin/reports/weekly.md'
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
const FALLBACK = en('preview.notFound')
const panel = () => mount(<MemoryRouter><ChatFileAsk chatId={C} path={PATH} fallback={FALLBACK} /></MemoryRouter>)

test('view: who answers by name, [Ask to view] sends the chat\'s file request, then the sent line', async () => {
  routes[`GET ${ACCESS}`] = () => json(200, { status: 'view', by: 'QA Admin' })
  routes[`POST ${ACCESS}`] = () => json(200, { status: 'sent', askedAt: '2026-11-26T01:00:00.000Z' })
  const m = await panel()
  await m.until(() => m.find('chat-file-view'), 'the ask')
  expect(m.html()).toContain(en('roomFileAsk.title'))
  expect(m.html()).toContain(en('roomFileAsk.byName', { name: 'QA Admin' }))
  expect(m.find('chat-file-ask')).toBeNull()
  expect(new URL(sent[0]!.url, 'http://x').searchParams.get('path')).toBe(PATH)
  await m.click('chat-file-view-send')
  await m.until(() => m.find('chat-file-view-sent'), 'the sent line')
  expect(m.get('chat-file-view-sent').textContent).toBe(en('linkAccess.sent'))
  expect(sent.find((x) => x.key === `POST ${ACCESS}`)!.body).toEqual({ path: PATH })
  await m.unmount()
})

test('viewAsked: the generic answerer and the date, no button; open with a link: Open', async () => {
  routes[`GET ${ACCESS}`] = () => json(200, { status: 'viewAsked', askedAt: '2026-11-25T01:00:00.000Z', by: null })
  const m = await panel()
  await m.until(() => m.find('chat-file-view-sent'), 'the asked line')
  expect(m.html()).toContain(en('roomFileAsk.byAdmin'))
  expect(m.find('chat-file-view-send')).toBeNull()
  await m.unmount()
  routes[`GET ${ACCESS}`] = () => json(200, { status: 'open', link: 'AbCdEfGhIjKlMnOpQrStUv' })
  const o = await panel()
  await o.until(() => o.find('chat-file-view-open'), 'Open')
  await o.unmount()
})

test('no: the plain line and who can share it, nothing about the file', async () => {
  routes[`GET ${ACCESS}`] = () => json(200, { status: 'no' })
  routes['GET /api/files/moved'] = () => json(200, { status: 'no' })
  const m = await panel()
  await m.until(() => m.find('file-moved-no'), 'the fallback')
  expect(m.get('file-moved-no').textContent).toBe(FALLBACK)
  expect(m.get('file-moved-who').textContent).toBe(en('preview.notFoundWho'))
  expect(m.find('chat-file-view')).toBeNull()
  await m.unmount()
})
