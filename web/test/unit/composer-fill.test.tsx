// Text put in the message box for the person (components/chat/Composer.tsx): a chosen suggestion or 자연스러운 글's
// request (Home's "팀에 준비된 것") focuses the box with the caret after the text, so what they type or paste next follows
// it; a caret left at the start put a pasted text in front of "/humanizer …" and broke the command. A request that needs
// the person's own text (`waitsFor`) is not sent alone: send waits and a line under the box says what to add, until
// something follows the request (or a file is attached).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { Attachment } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Composer, { focusAtEnd } from '../../src/components/chat/Composer'
import { CHAT } from './fixtures'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

const ASK = `/humanizer ${translate('ko', 'home.prepared.humanizerAsk')}\n`
const HINT = translate('ko', 'home.prepared.humanizerPaste')
const g = globalThis as Record<string, unknown>
/** a computer (a mouse: the box takes focus by itself) or a phone (a finger: it does not, the keyboard stays down) */
const pointer = (fine: boolean) => { g.matchMedia = (q: string) => ({ matches: fine ? q === '(pointer: fine)' : q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) }
const before = useLocaleStore.getState().locale
const realFetch = globalThis.fetch

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  // nothing here needs the server; a call fails loudly
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterEach(() => { localStorage.clear() })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before })
})

const doc = () => globalThis.document as unknown as { activeElement: FakeElement | null }
const box = (m: Mounted) => m.get('composer-input') as FakeElement & { value: string; selectionStart: number; selectionEnd: number }
/** what a paste does in a browser: the text goes in at the caret (replacing a selection) */
const pasteAtCaret = async (m: Mounted, text: string) => {
  const b = box(m)
  const at = b.selectionStart ?? 0
  await m.type(b, b.value.slice(0, at) + text + b.value.slice(b.selectionEnd ?? at))
}
const open = (o: { text?: string; autoFocus?: boolean; waitsFor?: { text: string; hint: string } } = {}) => {
  const sent: string[] = []
  return mount(
    <Composer draftId="new" ensureChat={async () => CHAT} running={false} onSend={async (text: string, _a: Attachment[]) => void sent.push(text)} onStop={async () => {}} engine={{ engine: undefined, model: undefined }}
      initialText={o.text} autoFocus={o.autoFocus} waitsFor={o.waitsFor} />,
  ).then((m) => Object.assign(m, { sent }))
}

describe('the caret after a fill', () => {
  test('a box opened with text (autoFocus, a computer): focused, the caret after the text; a paste goes after the request', async () => {
    pointer(true)
    const m = await open({ text: ASK, autoFocus: true })
    try {
      expect(doc().activeElement).toBe(box(m))
      expect(box(m).value).toBe(ASK)
      expect([box(m).selectionStart, box(m).selectionEnd]).toEqual([ASK.length, ASK.length])
      await pasteAtCaret(m, '오늘 회의에서 정한 내용을 공유드립니다.')
      expect(box(m).value).toBe(`${ASK}오늘 회의에서 정한 내용을 공유드립니다.`)
      expect(box(m).value.startsWith('/humanizer ')).toBe(true)
    } finally { await m.unmount() }
  })

  test('a phone does not take focus by itself (the keyboard stays down), and nothing without autoFocus', async () => {
    pointer(false)
    let m = await open({ text: ASK, autoFocus: true })
    try {
      expect(doc().activeElement).not.toBe(box(m))
    } finally { await m.unmount() }
    pointer(true)
    m = await open({ text: ASK })
    try {
      expect(doc().activeElement).not.toBe(box(m))
    } finally { await m.unmount() }
  })

  test('focusAtEnd: focus, the caret after the text, the end in view; nothing for no box', async () => {
    const m = await open({ text: 'a\nb\nc' })
    try {
      const b = box(m)
      b.setSelectionRange(0, 0)
      focusAtEnd(b as unknown as HTMLTextAreaElement)
      expect(doc().activeElement).toBe(b)
      expect([b.selectionStart, b.selectionEnd]).toEqual([5, 5])
      expect(() => focusAtEnd(null)).not.toThrow()
    } finally { await m.unmount() }
  })
})

describe('a request that needs the person\'s own text', () => {
  test('only the request: send waits (the button, Enter) and the line says what to add; text after it: the line goes and it sends', async () => {
    pointer(true)
    const m = await open({ text: ASK, autoFocus: true, waitsFor: { text: ASK, hint: HINT } })
    try {
      expect(m.get('send').getAttribute('disabled')).not.toBeNull()
      expect(m.get('composer-waits').textContent).toBe('다듬을 글을 붙여 넣어 주세요')
      expect(m.get('composer-waits').getAttribute('role')).toBe('status')
      // Enter does not send it either
      await act(async () => { box(m).dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })) })
      await m.click('send')
      await m.settle()
      expect(m.sent).toEqual([])
      // spaces and new lines after it are still nothing
      await m.type(box(m), `${ASK}  \n`)
      expect(m.find('composer-waits')).not.toBeNull()
      // the person's text after it
      await m.type(box(m), `${ASK}회의 결과를 공유드립니다.`)
      expect(m.find('composer-waits')).toBeNull()
      expect(m.get('send').getAttribute('disabled')).toBeNull()
      await m.click('send')
      await m.settle()
      expect(m.sent).toEqual([`${ASK}회의 결과를 공유드립니다.`])
    } finally { await m.unmount() }
  })

  test('a box without it (a whole question) sends as it is', async () => {
    pointer(true)
    const q = translate('ko', 'home.prepared.startAsk')
    const m = await open({ text: q, autoFocus: true })
    try {
      expect(m.find('composer-waits')).toBeNull()
      expect(m.get('send').getAttribute('disabled')).toBeNull()
      await m.click('send')
      await m.settle()
      expect(m.sent).toEqual([q])
    } finally { await m.unmount() }
  })
})
