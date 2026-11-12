// Posting my private preview of a room AI answer (components/rooms/RoomMessages.tsx PreviewLine, QA TC-329): it always
// asks the server first (`ask`), and its "confirm" opens the card of "대화방에 보내기" (chat/ShareToRoom.tsx ShareConfirm,
// the same words: how many people cannot see it and where it came from, never who), with the files it used as rows that
// leave the posted copy's list, and lines of its own: everyone will see it when nothing is at stake, the web or a
// connected service, an earlier hidden answer. Nothing is posted before its yes, which sends the key.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { type Me } from '@mycel/shared/api'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { translate, useLocaleStore } from '../../src/i18n'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type Mounted } from './dom-host'
import { BEN, CY, ME, message, room } from './rooms-fixtures'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRooms.getState().reset()
  useUi.setState({ toasts: [] })
})
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

const team = room({ name: 'Design review', memberCount: 3 })
const signIn = () => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { allChatsConfidential: false } } as unknown as Me } })
const body = (m: Mounted) => m.container.ownerDocument!.body
const card = (m: Mounted) => body(m).querySelector('[data-testid="share-room-confirm"]')
const byTest = (m: Mounted, id: string) => body(m).querySelector(`[data-testid="${id}"]`)

let calls: { body: unknown }[] = []
function serve(answers: unknown[]) {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
    if (init?.method === 'POST' && path.endsWith('/share')) {
      calls.push({ body: JSON.parse(String(init.body ?? '{}')) })
      return json(answers[Math.min(calls.length - 1, answers.length - 1)])
    }
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
}

const preview = (p: NonNullable<Parameters<typeof message>[0]['preview']>) => message({ roomId: team.id, seq: 5, authorKind: 'ai', author: null, askedBy: ME, visibility: 'private', body: 'FALCON numbers: 42', preview: p })
const posted = (id: string) => ({ status: 'sent', message: message({ id, roomId: team.id, seq: 9, authorKind: 'ai', author: null, askedBy: ME, body: 'FALCON numbers: 42' }) })

async function show(m: ReturnType<typeof preview>) {
  signIn()
  useRooms.setState({ rooms: [team], loaded: true })
  return mount(
    <MemoryRouter>
      <RoomMessages roomId={team.id} messages={[m]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />
    </MemoryRouter>,
  )
}

test('material some people here cannot see: the server is asked first; its card has the side chat\'s words; yes posts with the key', async () => {
  const p = preview({ folders: ['projects/falcon'], unable: { 'projects/falcon': 1 }, personal: false, outside: false, joinedLater: [] })
  const confirm = {
    status: 'confirm', people: 1, places: [{ kind: 'folder', path: 'projects/falcon' }], otherPlaces: false,
    files: [{ name: 'plan.md', path: 'projects/falcon/plan.md', missing: false, attach: 'no', unable: 1 }],
    provenance: { people: 1, places: [{ kind: 'folder', path: 'projects/falcon' }], otherPlaces: false }, confirmKey: 'k1',
  }
  serve([confirm, posted(p.id)])
  const m = await show(p)
  try {
    await m.click('room-ai-share')
    await m.until(() => card(m), 'the confirm card')
    // the server's step is the only one
    expect(calls).toEqual([{ body: { ask: true } }])
    // the side chat's words: where it came from and how many cannot see it, never who
    expect(byTest(m, 'share-room-provenance')!.textContent).toBe(en('shareRoom.provenance', { n: 1, places: 'projects/falcon/' }))
    expect(byTest(m, 'share-room-to')!.textContent).toContain('Design review')
    // the file it used: a row of its own, under "Files it used", left out of the posted copy (no attach switch)
    expect(byTest(m, 'share-room-files')!.textContent).toContain('plan.md')
    expect(card(m)!.textContent).toContain(en('shareRoom.sourcesHead'))
    expect(byTest(m, 'share-room-file-caption')!.textContent).toBe(en('shareRoom.sourceLeftOut'))
    expect(byTest(m, 'share-room-attach')).toBeNull()
    expect(card(m)!.textContent).not.toMatch(/Ben|Cy Park/)
    // yes: the same call with the key; the card goes
    await m.click(byTest(m, 'share-room-confirm-send') as never)
    await m.until(() => !card(m), 'the card closed')
    expect(calls[1]).toEqual({ body: { confirmKey: 'k1' } })
  } finally {
    await m.unmount()
  }
})

test('cancel on the card posts nothing and leaves the preview private', async () => {
  const p = preview({ folders: [], personal: true, outside: false, joinedLater: [] })
  serve([{ status: 'confirm', people: 2, places: [{ kind: 'mine' }], otherPlaces: false, files: [], provenance: { people: 2, places: [{ kind: 'mine' }], otherPlaces: false }, confirmKey: 'k2' }])
  const m = await show(p)
  try {
    await m.click('room-ai-share')
    await m.until(() => card(m), 'the confirm card')
    expect(byTest(m, 'share-room-provenance')!.textContent).toBe(en('shareRoom.provenance', { n: 2, places: en('shareRoom.placeMine') }))
    await m.click(byTest(m, 'share-room-back') as never)
    expect(card(m)).toBeNull()
    expect(calls).toHaveLength(1)
    expect(m.find('room-ai-share')).not.toBeNull()
  } finally {
    await m.unmount()
  }
})

test('the web alone: still one card first (everyone will see it, and the web line); yes posts with the key', async () => {
  const p = preview({ folders: [], personal: false, outside: true, joinedLater: [] })
  serve([{ status: 'confirm', people: 0, places: [], otherPlaces: false, files: [], provenance: null, confirmKey: 'k3', outside: true }, posted(p.id)])
  const m = await show(p)
  try {
    await m.click('room-ai-share')
    await m.until(() => card(m), 'the confirm card')
    expect(byTest(m, 'room-ai-post-all')!.textContent).toBe(en('rooms.aiPrivateAll'))
    expect(byTest(m, 'room-ai-post-outside')!.textContent).toBe(en('rooms.aiPostOutside'))
    expect(byTest(m, 'share-room-provenance')).toBeNull()
    expect(calls).toHaveLength(1)
    await m.click(byTest(m, 'share-room-confirm-send') as never)
    await m.until(() => !card(m), 'the card closed')
    expect(calls[1]).toEqual({ body: { confirmKey: 'k3' } })
  } finally {
    await m.unmount()
  }
})

test('only an earlier hidden answer behind it: the card says so, and nothing goes before the yes', async () => {
  const p = preview({ folders: [], personal: false, outside: false, joinedLater: [], earlier: true })
  serve([{ status: 'confirm', people: 0, places: [], otherPlaces: false, files: [], provenance: null, confirmKey: 'k4', earlier: true }])
  const m = await show(p)
  try {
    await m.click('room-ai-share')
    await m.until(() => card(m), 'the confirm card')
    expect(byTest(m, 'room-ai-post-earlier')!.textContent).toBe(en('rooms.aiPostEarlierNone'))
    await m.settle(20)
    expect(calls).toEqual([{ body: { ask: true } }])
  } finally {
    await m.unmount()
  }
})
