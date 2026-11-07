// Web addresses in people's room messages are links (components/rooms/MessageText.tsx, lib/textLinks.ts): beside the
// @names in one message, opened as an AI answer's links are (another site in a new tab without the referrer, a page of
// this app inside it, this server's /api/ as text), in a quote and in a message being sent; the phone app, which opens
// https only, copies an http address instead of doing nothing; a long press is no click.
import { expect, setSystemTime, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ROOM_QUOTE_EXCERPT_MAX, uuidv7 } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import type { PendingSend } from '../../src/store/rooms'
import { useUi } from '../../src/store/ui'
import { closeSidePanel, getSidePanel } from '../../src/lib/sidePanel'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'
import { BEN, CY, ME, message } from './rooms-fixtures'
import { MOBILE_CAPABILITIES } from '../../../mobile/src/protocol'

const R = uuidv7()
type Ms = ReturnType<typeof message>[]
const ui = (ms: Ms, pending: PendingSend[] = []) => (
  <MemoryRouter>
    <RoomMessages roomId={R} messages={ms} pending={pending} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />
  </MemoryRouter>
)
const render = (ms: Ms, pending?: PendingSend[]) => renderToStaticMarkup(ui(ms, pending))
const anchors = (html: string) => html.match(/<a [^>]*>/g) ?? []

test('a mention and links in one message: the @name stays a mention, an address is a link that opens in a new tab', () => {
  // the test page's origin is http://localhost (no location here): a link to it is this app
  const body = '@Cy Park see https://example.com/report?q=1 (and www.example.org/a). javascript:alert(1) http://localhost/rooms/abc에서'
  const html = render([message({ roomId: R, seq: 1, body, mentions: [CY.id] })])
  expect(html).toMatch(/<span class="font-medium text-accent-text">@Cy Park<\/span>/)
  const a = anchors(html)
  expect(a.length).toBe(3)
  expect(a[0]).toContain('href="https://example.com/report?q=1"')
  expect(a[0]).toContain('target="_blank"')
  expect(a[0]).toContain('rel="noopener noreferrer nofollow"')
  expect(a[0]).toMatch(/referrerPolicy="no-referrer"/i)
  expect(a[0]).toContain('data-testid="room-link"')
  expect(a[1]).toContain('href="https://www.example.org/a"')
  // this app's own page: a link inside the app (no new tab)
  expect(a[2]).toContain('href="/rooms/abc"')
  expect(a[2]).not.toContain('target=')
  // the words around the links, the brackets and the dot of the sentence are text; javascript: is never a link
  expect(html).toContain(' (and ')
  expect(html).toContain('</a>). javascript:alert(1) ')
  expect(html).toContain('</a>에서')
  expect(html).not.toContain('href="javascript')
})

test("a link to this server's /api/ or to a path the router reads as another site stays text; a long address may break after its slashes", () => {
  const html = render([message({ roomId: R, seq: 1, body: 'http://localhost/api/admin/users and http://localhost//evil.example/login and https://example.com/artifact/Q8xK2mTz5RwLp4HvNc7JdE' })])
  expect(anchors(html).length).toBe(1)
  expect(html).toContain('http://localhost/api/admin/users and http://localhost//evil.example/login and ')
  expect(html).not.toContain('evil.example/login"')
  expect(html).toContain('>https://<wbr/>example.com/<wbr/>artifact/<wbr/>Q8xK2mTz5RwLp4HvNc7JdE</a>')
  expect(html).toContain('[overflow-wrap:anywhere]')
})

test('HTML in a message stays text around a link', () => {
  const html = render([message({ roomId: R, seq: 1, body: '<a href="javascript:alert(1)">https://example.com/a</a><img src=x onerror=alert(1)>' })])
  expect(html).toContain('&lt;a href=&quot;javascript:alert(1)&quot;&gt;<a href="https://example.com/a"')
  expect(html).toContain('&lt;/a&gt;&lt;img src=x onerror=alert(1)&gt;')
  expect(anchors(html).length).toBe(1)
})

test("a quote's excerpt has its links above the jump; an address the excerpt's '…' cut stays text", () => {
  const q = message({ roomId: R, seq: 1, body: 'the deck https://example.com/deck' })
  const reply = message({ roomId: R, seq: 2, author: CY, body: 'thanks', replyTo: { id: q.id, author: BEN, excerpt: q.body, fileCount: 0, deleted: false } })
  const html = render([q, reply])
  const quote = html.slice(html.indexOf('data-testid="message-quote"'))
  expect(quote).toContain('data-testid="message-quote-jump"')
  expect(quote).toMatch(/aria-labelledby="[^"]+n [^"]+t"/)
  expect(quote).toContain('[&amp;_a]:relative')
  expect(anchors(quote)[0]).toContain('href="https://example.com/deck"')
  // the server's cut: the first ROOM_QUOTE_EXCERPT_MAX - 1 characters and "…"
  const words = `see https://example.com/a and ${'w'.repeat(136)} https://example.com/very/long/path/that/goes/on`
  const excerpt = words.slice(0, ROOM_QUOTE_EXCERPT_MAX - 1) + '…'
  expect(excerpt.endsWith('/very/long/pa…')).toBe(true)
  const cut = message({ roomId: R, seq: 3, author: CY, body: 'ok', replyTo: { id: q.id, author: BEN, excerpt, fileCount: 0, deleted: false } })
  const cutHtml = render([q, cut])
  const cutQuote = cutHtml.slice(cutHtml.indexOf('data-testid="message-quote"'))
  expect(anchors(cutQuote).map((a) => a.match(/href="([^"]+)"/)![1])).toEqual(['https://example.com/a'])
  expect(cutQuote).toContain('https://example.com/very/long/pa…')
  // an excerpt shorter than the server's cut ends in a "…" its author typed: the address before it is a link
  const typed = message({ roomId: R, seq: 4, author: CY, body: 'ok', replyTo: { id: q.id, author: BEN, excerpt: 'see https://example.com/a…', fileCount: 0, deleted: false } })
  const typedHtml = render([q, typed])
  expect(anchors(typedHtml.slice(typedHtml.indexOf('data-testid="message-quote"')))[0]).toContain('href="https://example.com/a"')
})

test('my message while it is being sent shows its links too', () => {
  const p: PendingSend = { clientMessageId: 'c1', body: 'here https://example.com/x', files: [], mentions: [], state: 'sending' } as unknown as PendingSend
  const html = render([], [p])
  expect(anchors(html.slice(html.indexOf('room-pending-message')))[0]).toContain('href="https://example.com/x"')
})

/** a click as a browser sends it (`detail` 0: from the keyboard or a screen reader): whether the link's default (opening
 * it) was stopped */
function click(el: FakeElement, o: { detail?: number; metaKey?: boolean } = {}): boolean {
  const e = Object.assign(new FakeEvent('click', { bubbles: true, cancelable: true }), { button: 0, detail: o.detail ?? 1, metaKey: !!o.metaKey })
  el.dispatchEvent(e)
  return e.defaultPrevented
}
/** a finger on the link for `ms` */
function touch(el: FakeElement, ms: number) {
  const ev = (type: string) => Object.assign(new FakeEvent(type, { bubbles: true }), { pointerType: 'touch' })
  el.dispatchEvent(ev('pointerdown'))
  setSystemTime(new Date(Date.now() + ms))
  el.dispatchEvent(ev('pointerup'))
  setSystemTime()
}

test('the phone app opens https only: an http link there copies the address and says so; https opens as usual; a long press is no click', async () => {
  installDom()
  const g = globalThis as unknown as Record<string, unknown>
  const realNavigator = globalThis.navigator
  const copied: string[] = []
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...realNavigator, clipboard: { writeText: async (s: string) => void copied.push(s) } } })
  const m = await mount(ui([message({ roomId: R, seq: 1, body: 'http://intranet.example.com/a and https://example.com/b' })]))
  try {
    const [http, https] = m.container.querySelectorAll('[data-testid="room-link"]') as unknown as FakeElement[]
    // in a browser both just open
    expect(click(http!)).toBe(false)
    expect(click(https!)).toBe(false)
    expect(copied).toEqual([])
    // inside the phone app (its bridge is there)
    g.mycelMobile = { protocol: 1, appVersion: '0.4.0', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
    g.ReactNativeWebView = { postMessage: () => {} }
    expect(click(https!)).toBe(false)
    expect(click(http!)).toBe(true)
    await m.settle(10)
    expect(copied).toEqual(['http://intranet.example.com/a'])
    expect(useUi.getState().toasts.at(-1)?.text).toBe(translate(useLocaleStore.getState().locale, 'rooms.linkHttpCopied'))
    // a finger held on the link opened the message's menu: lifting it opens nothing
    touch(https!, 700)
    expect(click(https!)).toBe(true)
    // a short tap opens it
    touch(https!, 100)
    expect(click(https!)).toBe(false)
    // Enter after a long press that sent no click: the keyboard always opens
    touch(https!, 700)
    expect(click(https!, { detail: 0 })).toBe(false)
    expect(click(https!)).toBe(false)
  } finally {
    setSystemTime()
    delete g.mycelMobile
    delete g.ReactNativeWebView
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: realNavigator })
    await m.unmount()
    removeDom()
  }
})

test('a team file link opens its preview (the server checks access); a modifier click is left to the browser; a message being sent has no menu to hold for', async () => {
  installDom()
  closeSidePanel()
  const body = 'http://localhost/files/view?path=shared%2Freport.docx'
  const pending: PendingSend = { clientMessageId: 'c2', body: 'https://example.com/x', files: [], mentions: [], state: 'sending' } as unknown as PendingSend
  const m = await mount(ui([message({ roomId: R, seq: 1, body })], [pending]))
  try {
    const [file, sending] = m.container.querySelectorAll('[data-testid="room-link"]') as unknown as FakeElement[]
    expect(file!.getAttribute('href')).toBe(body)
    expect(click(file!, { metaKey: true })).toBe(false)
    expect(getSidePanel()).toBeNull()
    expect(click(file!)).toBe(true)
    expect(getSidePanel()).toMatchObject({ kind: 'file', file: { source: 'team', path: 'shared/report.docx' } })
    touch(sending!, 700)
    expect(click(sending!)).toBe(false)
  } finally {
    closeSidePanel()
    await m.unmount()
    removeDom()
  }
})
