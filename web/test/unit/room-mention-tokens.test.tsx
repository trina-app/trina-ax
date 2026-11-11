// Mentions in a room's message box (components/rooms/RoomComposer.tsx, useMentionMenu, components/TokenTextarea.tsx): a
// name picked from the "@" list is a token at once (it stands out in the layer under the box), a deletion at its edge
// takes all of it (a key, or a phone keyboard's edit), an edit inside it makes it text, a pasted "@name" is no mention,
// an IME writing next to it changes nothing, and what is sent mentions exactly the people whose tokens stand out.
// The browser's own part of a key (the deletion after Backspace) is played here by the test; e2e room-mentions.spec.ts
// does the same in Chromium.
//
// Every edit is played the way both of React's change detections see it: the box got "focusin" first (React loaded
// before a DOM existed, which another test file can cause when all files share one process, watches the focused field
// and reports a change on keyup/keydown only), then beforeinput, the new value, input and keyup. Waits fail well inside
// bun's own 5 s, so a failing test ends here and cleans up instead of running on into the next ones; afterEach unmounts
// whatever is still mounted and puts back every global and store these tests touch.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { RoomComposer } from '../../src/components/rooms/RoomComposer'
import { isBusy } from '../../src/lib/busy'
import { reloadWouldLose } from '../../src/lib/reload-guard'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { roomDraftMentions, useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { FakeElement, FakeEvent, installDom, mount as mountInDom, removeDom, type Mounted } from './dom-host'
import { BEN, CY, ME, message, room } from './rooms-fixtures'

const MJ = { id: 'minjae', name: 'Minjaelee' }
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
let sent: { mentions: string[]; body: string }[] = []
/** what is mounted and not unmounted yet */
const live = new Set<Mounted>()
/** a wait for something the page does (never a fixed time): long enough for a slow, busy machine, and still well inside
 * each test's own time (DOM_TEST_MS), so a failing wait ends inside its test and cleans up */
const WAIT = 4000
/** each test's time here: a full suite on a loaded CI machine renders slowly, and bun's default (5 s) is no budget for
 * the waits above */
const DOM_TEST_MS = 20_000

beforeAll(() => { installDom() })
beforeEach(() => { useLocaleStore.setState({ locale: 'ko' }) })
afterEach(async () => {
  for (const m of [...live].reverse()) await m.unmount()
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRooms.getState().reset()
  useLocaleStore.setState({ locale })
})
afterAll(() => { removeDom() })

async function mount(ui: Parameters<typeof mountInDom>[0]): Promise<Mounted> {
  const m = await mountInDom(ui)
  live.add(m)
  const unmount = m.unmount
  m.unmount = async () => {
    if (!live.delete(m)) return
    await unmount()
  }
  return m
}

/** focus as a person's tap or click does: the field gets "focusin" too */
async function focus(box: FakeElement) {
  await act(async () => {
    box.focus()
    box.dispatchEvent(new FakeEvent('focusin', { bubbles: true }))
  })
}

const setValue = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!

async function open() {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { roomAiMentions: true } } as unknown as Me } })
  const r = room()
  sent = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    if (init?.method === 'POST' && path === `/api/rooms/${r.id}/messages`) {
      const b = JSON.parse(String(init.body))
      sent.push(b)
      return new Response(JSON.stringify(message({ roomId: r.id, seq: 9, author: ME, body: b.body, mentions: b.mentions })), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
  const m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN, CY, MJ]} meId={ME.id} onSent={() => {}} />)
  const box = m.get('room-input') as FakeElement & { value: string; selectionStart: number; selectionEnd: number }
  await focus(box)
  return { m, box, roomId: r.id }
}

type Box = Awaited<ReturnType<typeof open>>['box']

/** an edit as the browser makes it: beforeinput with the selection it applies to (`sel`: the caret there, or that
 * selection; none: the edited range), the new text, the caret after it, input */
async function edit(box: Box, from: number, to: number, insert: string, inputType: string, sel?: number | [number, number]) {
  await act(async () => {
    if (sel === undefined) box.setSelectionRange(from, to)
    else if (typeof sel === 'number') box.setSelectionRange(sel, sel)
    else box.setSelectionRange(sel[0], sel[1])
    const b = new FakeEvent('beforeinput', { bubbles: true, cancelable: true }) as FakeEvent & { inputType: string }
    b.inputType = inputType
    box.dispatchEvent(b)
    setValue.call(box, box.value.slice(0, from) + insert + box.value.slice(to))
    box.setSelectionRange(from + insert.length, from + insert.length)
    box.dispatchEvent(new FakeEvent('input', { bubbles: true }))
    box.dispatchEvent(new FakeEvent('keyup', { bubbles: true }))
  })
}
const typeText = (box: Box, s: string) => edit(box, box.selectionEnd ?? box.value.length, box.selectionEnd ?? box.value.length, s, 'insertText')

/** a key on the box; returns whether the page let the browser act (not prevented) */
async function key(box: Box, k: string, o: { composing?: boolean } = {}) {
  let ok = true
  await act(async () => {
    const e = new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })
    if (o.composing) Object.assign(e, { isComposing: true, keyCode: 229 })
    ok = box.dispatchEvent(e)
  })
  return ok
}
/** Backspace as a computer does it: the page's keydown, then the browser deletes the selection or the letter before */
async function backspace(box: Box) {
  if (!(await key(box, 'Backspace'))) return
  const s = box.selectionStart, e = box.selectionEnd
  if (s !== e) await edit(box, s, e, '', 'deleteContentBackward')
  else if (s > 0) await edit(box, s - 1, s, '', 'deleteContentBackward', s)
}
async function composition(box: Box, type: 'compositionstart' | 'compositionend') {
  await act(async () => { box.dispatchEvent(new FakeEvent(type, { bubbles: true })) })
}

/** the tokens standing out in the layer: their kind and text */
const tokens = (m: Mounted) => m.get('token-layer').querySelectorAll('[data-token]').map((el) => `${el.getAttribute('data-token')}:${el.textContent}`)
const layerText = (m: Mounted) => m.get('token-layer').textContent.replace(/​$/, '')

/** A message's edit form, opened as a mouse does it: its ⋯ menu (the hover bar's), then 수정. Each step waits for what
 * the page shows, never for time: no long press (its 500 ms timer and the menu's 400 ms guard against the finger
 * lifting made a fixed wait miss under load), and the box is used once React has put the message's text in it. */
async function openEdit(m: Mounted, text: string): Promise<Box> {
  await m.click('message-more')
  await m.until(() => m.find('message-edit'), 'the message menu', WAIT)
  await m.click('message-edit')
  const box = (await m.until(() => m.find('room-edit-input'), 'the edit form', WAIT)) as Box
  await focus(box)
  await m.until(() => box.value === text && layerText(m) === text, 'the message text in the edit box', WAIT)
  return box
}

async function pick(m: Mounted, box: Box, query: string) {
  await typeText(box, '@' + query)
  await m.until(() => m.find('mention-menu'), 'the @ list', WAIT)
  expect(await key(box, 'Enter')).toBe(false)
  await m.settle()
}

async function send(m: Mounted) {
  await m.click('room-send')
  await m.until(() => sent.length > 0, 'the send', WAIT)
  return sent.at(-1)!
}

test('a name picked from the list is a token at once; what is sent mentions exactly the tokens', async () => {
  const { m, box } = await open()
  try {
    await pick(m, box, 'Minj')
    expect(box.value).toBe('@Minjaelee ')
    expect(box.selectionStart).toBe(11)
    expect(tokens(m)).toEqual(['person:@Minjaelee'])
    expect(layerText(m)).toBe(box.value)
    await typeText(box, '민재님 좀 ')
    await pick(m, box, '트리')
    await typeText(box, '봐 줘')
    expect(box.value).toBe('@Minjaelee 민재님 좀 @트리나 봐 줘')
    expect(tokens(m)).toEqual(['person:@Minjaelee', 'ai:@트리나'])
    // the layer draws the same text as the box
    expect(layerText(m)).toBe(box.value)
    const body = await send(m)
    expect(body).toMatchObject({ body: '@Minjaelee 민재님 좀 @트리나 봐 줘', mentions: [MJ.id] })
    // the box is empty again, and so is the draft's list of mentions
    expect(box.value).toBe('')
    expect(tokens(m)).toEqual([])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('Backspace at the end of a token takes all of it, and the list does not open on it', async () => {
  const { m, box } = await open()
  try {
    await typeText(box, 'hi ')
    await pick(m, box, 'Cy')
    expect(box.value).toBe('hi @Cy Park ')
    await backspace(box) // the space
    expect(box.value).toBe('hi @Cy Park')
    expect(tokens(m)).toEqual(['person:@Cy Park'])
    // the caret right after a token: no list for it
    expect(m.find('mention-menu')).toBeNull()
    await backspace(box)
    expect(box.value).toBe('hi ')
    expect(tokens(m)).toEqual([])
    await typeText(box, 'there')
    expect((await send(m)).mentions).toEqual([])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test("a phone keyboard's deletion into a token (an edit, no key) takes all of it, also while its IME holds the word", async () => {
  const { m, box } = await open()
  try {
    await pick(m, box, 'Minj')
    await backspace(box) // the space
    // Android: no Backspace key, only the edit (the letter before the caret gone)
    await edit(box, 9, 10, '', 'deleteContentBackward', 10)
    expect(box.value).toBe('')
    expect(tokens(m)).toEqual([])
    // Gboard takes the word back into its IME first: the deletion comes as the IME's edit
    await pick(m, box, 'Minj')
    await backspace(box)
    await composition(box, 'compositionstart')
    await edit(box, 9, 10, '', 'insertCompositionText', 10)
    await composition(box, 'compositionend')
    expect(box.value).toBe('')
    expect(tokens(m)).toEqual([])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('a keyboard that answers Backspace with a deletion of its own (one letter, or the one before) still takes the token', async () => {
  const { m, box } = await open()
  try {
    await typeText(box, 'hi ')
    await pick(m, box, 'Minj')
    await backspace(box) // the space
    // the page selects the token for the browser; this keyboard deletes one letter of it instead
    expect(await key(box, 'Backspace')).toBe(true)
    expect([box.selectionStart, box.selectionEnd]).toEqual([3, 13])
    await edit(box, 12, 13, '', 'deleteContentBackward', [3, 13])
    expect(box.value).toBe('hi ')
    expect(tokens(m)).toEqual([])
    // or the letter before the selection
    await pick(m, box, 'Minj')
    await backspace(box)
    expect(await key(box, 'Backspace')).toBe(true)
    await edit(box, 2, 3, '', 'deleteContentBackward', [3, 13])
    expect(box.value).toBe('hi ')
    expect(tokens(m)).toEqual([])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('a letter of a token replaced through a selection makes it plain text, and no mention', async () => {
  const { m, box } = await open()
  try {
    await pick(m, box, 'Minj')
    await typeText(box, '안녕')
    // "@Min|j|aelee": the j selected and replaced
    await edit(box, 4, 5, 'J', 'insertText')
    expect(box.value).toBe('@MinJaelee 안녕')
    expect(tokens(m)).toEqual([])
    expect(layerText(m)).toBe(box.value)
    expect((await send(m)).mentions).toEqual([])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('a pasted "@name" is text, not a mention; "@트리나" pasted calls the AI as the server will, and stands out', async () => {
  const { m, box } = await open()
  try {
    await pick(m, box, 'Cy')
    await edit(box, box.value.length, box.value.length, '@Minjaelee @Cy Park @트리나 요약', 'insertFromPaste')
    expect(box.value).toBe('@Cy Park @Minjaelee @Cy Park @트리나 요약')
    expect(tokens(m)).toEqual(['person:@Cy Park', 'ai:@트리나'])
    const body = await send(m)
    expect(body.mentions).toEqual([CY.id])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('typing right before a token, or pasting right after it, keeps it whole and in its place', async () => {
  const { m, box } = await open()
  try {
    await pick(m, box, 'Ben')
    await edit(box, 0, 0, '안녕 ', 'insertText')
    expect(box.value).toBe('안녕 @Ben ')
    expect(tokens(m)).toEqual(['person:@Ben'])
    // a letter glued before the "@": the message would show it as text, so it is no mention while it is there
    await edit(box, 3, 3, 'x', 'insertText')
    expect(tokens(m)).toEqual([])
    await edit(box, 3, 4, '', 'deleteContentBackward', 4)
    expect(tokens(m)).toEqual(['person:@Ben'])
    expect((await send(m)).mentions).toEqual([BEN.id])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('a Korean IME writing next to a token: no caret moves, no deletion of the token, the layer shows each syllable', async () => {
  const { m, box } = await open()
  try {
    await pick(m, box, 'Minj')
    await backspace(box) // the space: the caret right at the token's end
    const moves: number[] = []
    const orig = box.setSelectionRange.bind(box)
    box.setSelectionRange = (s: number, e: number) => { moves.push(s); orig(s, e) }
    await composition(box, 'compositionstart')
    // ㅁ → 미 → 민, each an IME edit at the caret; the keys come as 229
    expect(await key(box, 'ㅁ', { composing: true })).toBe(true)
    let at = 10
    for (const [s, next] of [['', 'ㅁ'], ['ㅁ', '미'], ['미', '민']] as const) {
      const b = new FakeEvent('beforeinput', { bubbles: true }) as FakeEvent & { inputType: string }
      b.inputType = 'insertCompositionText'
      await act(async () => {
        box.dispatchEvent(new FakeEvent('compositionupdate', { bubbles: true }))
        box.dispatchEvent(b)
        setValue.call(box, box.value.slice(0, at - s.length) + next + box.value.slice(at))
        at = at - s.length + next.length
        Object.assign(box, { selectionStart: at, selectionEnd: at })
        box.dispatchEvent(new FakeEvent('input', { bubbles: true }))
        box.dispatchEvent(Object.assign(new FakeEvent('keyup', { bubbles: true }), { isComposing: true, keyCode: 229 }))
      })
      expect(layerText(m)).toBe(box.value)
    }
    // the IME's own Backspace (민 → 미) is not ours
    expect(await key(box, 'Backspace', { composing: true })).toBe(true)
    // meanwhile the box paints its own letters (index.css data-composing), until the IME is done
    expect(box.parentElement!.hasAttribute('data-composing')).toBe(true)
    await composition(box, 'compositionend')
    expect(box.parentElement!.hasAttribute('data-composing')).toBe(false)
    expect(moves).toEqual([])
    expect(box.value).toBe('@Minjaelee민')
    expect(tokens(m)).toEqual(['person:@Minjaelee'])
    expect((await send(m)).mentions).toEqual([MJ.id])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test("a Japanese IME taking back its own kana is the IME's, even where it spells an AI name", async () => {
  const { m, box } = await open()
  try {
    await typeText(box, '@')
    await composition(box, 'compositionstart')
    await edit(box, 1, 1, 'トリナ', 'insertCompositionText')
    expect(tokens(m)).toEqual(['ai:@トリナ'])
    // Backspace inside the IME: ナ goes, not the whole "@トリナ"
    await edit(box, 3, 4, '', 'insertCompositionText', 4)
    await composition(box, 'compositionend')
    expect(box.value).toBe('@トリ')
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('a draft keeps its mentions when the box comes back', async () => {
  const first = await open()
  const roomId = first.roomId
  try {
    await pick(first.m, first.box, 'Minj')
    await typeText(first.box, '안녕')
    expect(roomDraftMentions.get(roomId)?.map((p) => p.id)).toEqual([MJ.id])
  } finally {
    await first.m.unmount()
  }
  const m = await mount(<RoomComposer roomId={roomId} members={[ME, BEN, CY, MJ]} meId={ME.id} onSent={() => {}} />)
  try {
    // (this DOM has no default text for a text area: the layer shows what the box holds)
    expect(layerText(m)).toBe('@Minjaelee 안녕')
    expect(tokens(m)).toEqual(['person:@Minjaelee'])
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('a reply typed in a room\'s box counts as a draft: the page does not reload by itself while it is there (QA TC-231)', async () => {
  const { m, box } = await open()
  try {
    expect(isBusy('draft')).toBe(false)
    await typeText(box, '내일 회의 자료 올려 주세요')
    expect(isBusy('draft')).toBe(true)
    expect(reloadWouldLose()).toBe(true)
    await edit(box, 0, box.value.length, '', 'deleteContentBackward')
    expect(isBusy('draft')).toBe(false)
  } finally {
    await m.unmount()
  }
  expect(isBusy('draft')).toBe(false)
}, DOM_TEST_MS)

test('the edit form: the mentions a message has stand out as on the message, and stay mentions while whole', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { roomAiMentions: true } } as unknown as Me } })
  const r = room()
  const mine = message({ roomId: r.id, seq: 1, author: ME, body: '@Cy Park 확인 부탁해요 @Ben', mentions: [CY.id] })
  const patches: { body: string; mentions: string[] }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    if (init?.method === 'PATCH' && path === `/api/rooms/${r.id}/messages/${mine.id}`) {
      const b = JSON.parse(String(init.body))
      patches.push(b)
      return new Response(JSON.stringify({ ...mine, body: b.body, mentions: b.mentions }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const m = await mount(<RoomMessages roomId={r.id} messages={[mine]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  try {
    const box = await openEdit(m, '@Cy Park 확인 부탁해요 @Ben')
    Object.assign(box, { selectionStart: box.value.length, selectionEnd: box.value.length })
    // "@Ben" was typed, not picked: it is not a mention there and is none here
    expect(tokens(m)).toEqual(['person:@Cy Park'])
    await typeText(box, ' 고마워요')
    // saved once the form has the new text (its state, which the layer draws)
    await m.until(() => layerText(m) === '@Cy Park 확인 부탁해요 @Ben 고마워요', 'the typed text in the form', WAIT)
    await m.click('room-edit-save')
    await m.until(() => patches.length > 0, 'the edit', WAIT)
    expect(patches[0]).toEqual({ body: '@Cy Park 확인 부탁해요 @Ben 고마워요', mentions: [CY.id] })
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)

test('the edit form: a message with "\\r\\n" line breaks (another app) keeps its mentions through an edit', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { roomAiMentions: true } } as unknown as Me } })
  const r = room()
  const mine = message({ roomId: r.id, seq: 1, author: ME, body: '안녕\r\n@Cy Park 확인', mentions: [CY.id] })
  const patches: { body: string; mentions: string[] }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    if (init?.method === 'PATCH' && path === `/api/rooms/${r.id}/messages/${mine.id}`) {
      const b = JSON.parse(String(init.body))
      patches.push(b)
      return new Response(JSON.stringify({ ...mine, body: b.body, mentions: b.mentions }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const m = await mount(<RoomMessages roomId={r.id} messages={[mine]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  try {
    // the text area hands back "\n"
    const box = await openEdit(m, '안녕\n@Cy Park 확인')
    expect(tokens(m)).toEqual(['person:@Cy Park'])
    Object.assign(box, { selectionStart: box.value.length, selectionEnd: box.value.length })
    await typeText(box, '!')
    await m.until(() => layerText(m) === '안녕\n@Cy Park 확인!', 'the typed text in the form', WAIT)
    expect(tokens(m)).toEqual(['person:@Cy Park'])
    await m.click('room-edit-save')
    await m.until(() => patches.length > 0, 'the edit', WAIT)
    expect(patches[0]).toEqual({ body: '안녕\n@Cy Park 확인!', mentions: [CY.id] })
  } finally {
    await m.unmount()
  }
}, DOM_TEST_MS)
