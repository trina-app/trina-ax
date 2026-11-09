// A message's hover bar on computers (components/rooms/MessageHoverBar.tsx, in RoomMessages): ✅ 👀 👍 toggle mine
// through the reactions API, 반응 추가 opens the eight, 스레드에서 답장 opens the thread, ⋮ holds copy (and edit and
// delete for my own); none on event lines or deleted messages, no thread button on a reply; under the list's first
// message; Esc closes its menu.
import { afterEach, beforeAll, afterAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { uuidv7, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'
import { at, BEN, CY, ME, message } from './rooms-fixtures'

const R = uuidv7()
const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })
afterEach(() => useRooms.getState().reset())

const render = (ms: ReturnType<typeof message>[], o: { variant?: 'timeline' | 'root' | 'reply'; threadRootId?: string } = {}) =>
  renderToStaticMarkup(<RoomMessages roomId={R} messages={ms} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} variant={o.variant} threadRootId={o.threadRootId} />)
const count = (html: string, s: string) => html.split(s).length - 1
const bars = (html: string) => html.match(/data-testid="message-hover-bar"/g)?.length ?? 0

test('in order: ✅ 👀 👍, add reaction, reply in thread, more; every button named', () => {
  const html = render([message({ roomId: R, seq: 1, body: 'hello' }), message({ roomId: R, seq: 2, body: 'second' })])
  expect(bars(html)).toBe(2)
  const bar = html.slice(html.lastIndexOf('data-testid="message-hover-bar"'))
  const order = ['data-emoji="✅"', 'data-emoji="👀"', 'data-emoji="👍"', 'data-testid="message-react"', 'data-testid="message-thread"', 'data-testid="message-more"'].map((s) => bar.indexOf(s))
  expect(order.every((x) => x > 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(bar).toContain(`aria-label="${translate('en', 'rooms.reactWith', { emoji: '✅' })}"`)
  expect(bar).toContain(`aria-label="${translate('en', 'rooms.react')}"`)
  expect(bar).toContain(`aria-label="${translate('en', 'rooms.replyInThread')}"`)
  expect(bar).toContain(`aria-label="${translate('en', 'common.more')}"`)
  // a toolbar with a name; it floats (absolute), so nothing moves when it shows
  expect(html).toMatch(/role="toolbar" aria-label="[^"]+" class="absolute /)
  // the list's first message has it under it (the header above would cut it), the others above
  expect(count(html, 'data-below=""')).toBe(1)
  expect(html.indexOf('data-below=""')).toBeLessThan(html.indexOf('second'))
})

test('none on an event line or a deleted message; no thread button on a reply (in the thread, or sent to the room too)', () => {
  const root = uuidv7()
  expect(bars(render([message({ roomId: R, seq: 1, body: '', author: BEN, event: { type: 'left' } }), message({ roomId: R, seq: 2, body: '', deletedAt: at(3) })]))).toBe(0)
  const inThread = render([message({ roomId: R, seq: 3, body: 'a reply', threadRootId: root })], { variant: 'reply', threadRootId: root })
  expect(bars(inThread)).toBe(1)
  expect(inThread).not.toContain('data-testid="message-thread"')
  expect(inThread).toContain('data-testid="message-react"')
  const loud = render([message({ roomId: R, seq: 4, body: 'to the room too', threadRootId: root, alsoInRoom: true })])
  expect(loud).not.toContain('data-testid="message-thread"')
  // a thread's root in the panel: no thread button there either
  expect(render([message({ roomId: R, seq: 5, body: 'root' })], { variant: 'root' })).not.toContain('data-testid="message-thread"')
})

test('a quick reaction toggles mine through the reactions API; reply in thread opens the thread with the box ready', async () => {
  const realFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method} ${new URL(String(input), 'http://team.localhost').pathname} ${init?.body}`)
    return new Response(JSON.stringify({ reactions: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const m0 = message({ roomId: R, seq: 1, body: 'react to me', reactions: [{ emoji: '👀', count: 1, mine: true, users: [ME] }] })
  const opened: [string, boolean | undefined][] = []
  const m = await mount(<RoomMessages roomId={R} messages={[m0]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={(id, focus) => opened.push([id, focus])} />)
  try {
    const button = (e: string) => m.container.querySelector(`[data-testid="hover-react"][data-emoji="${e}"]`)!
    expect(button('👀').getAttribute('aria-pressed')).toBe('true')
    expect(button('✅').getAttribute('aria-pressed')).toBe('false')
    await m.click(button('✅') as never)
    await m.click(button('👀') as never)
    await m.settle(10)
    expect(calls).toEqual([
      `PUT /api/rooms/${R}/messages/${m0.id}/reactions ${JSON.stringify({ emoji: '✅', on: true })}`,
      `PUT /api/rooms/${R}/messages/${m0.id}/reactions ${JSON.stringify({ emoji: '👀', on: false })}`,
    ])
    await m.click('message-thread')
    expect(opened).toEqual([[m0.id, true]])
    // 반응 추가 opens the eight
    await m.click('message-react')
    expect(m.container.querySelectorAll('[data-testid="reaction-pick"]').length).toBe(8)
  } finally {
    globalThis.fetch = realFetch
    await m.unmount()
  }
})

test("more: copy for anyone's message; copy, edit and delete for my own; Esc closes it and gives the keyboard back", async () => {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name, role: 'member' } } as unknown as Me } })
  const theirs = message({ roomId: R, seq: 1, body: 'theirs' })
  const mine = message({ roomId: R, seq: 2, author: ME, body: 'mine' })
  const m = await mount(<RoomMessages roomId={R} messages={[theirs, mine]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  try {
    const more = m.container.querySelectorAll('[data-testid="message-more"]')
    const items = () => ['message-reply-thread', 'message-copy', 'message-edit', 'message-delete'].filter((id) => !!m.find(id))
    await m.click(more[0] as never)
    expect(items()).toEqual(['message-copy'])
    await m.click(more[0] as never)
    await m.click(more[1] as never)
    expect(items()).toEqual(['message-copy', 'message-edit', 'message-delete'])
    const menu = m.container.querySelector('[role="menu"]')!
    await m.settle(10)
    ;(menu as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(Object.assign(new FakeEvent('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }))
    await m.settle(10)
    expect(m.container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(more[1] as never)
  } finally {
    useSession.setState({ status: { kind: 'loading' } })
    await m.unmount()
  }
})
