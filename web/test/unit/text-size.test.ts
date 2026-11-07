// The person's text size (lib/textSize.ts, Settings > Profile > 글자 크기): kept on this device and in the account like the
// theme, set as the page's root font size, and the account's choice winning when the person signs in.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Me, TextSize } from '@mycel/shared/api'
import { installDom, removeDom } from './dom-host'
import { applyTheme } from '../../src/lib/theme'
import { applyTextSize, currentTextSize, rootFontSize, storedTextSize, storeTextSize, TEXT_SIZE_PERCENT, TEXT_SIZES } from '../../src/lib/textSize'
import { useSession } from '../../src/store/session'

class Mem {
  m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

describe('the steps', () => {
  test('five, smallest to largest, 기본 at 100% and each larger than the one before', () => {
    expect([...TEXT_SIZES]).toEqual(['small', 'default', 'large', 'larger', 'largest'])
    expect(TEXT_SIZE_PERCENT.default).toBe(100)
    const pct = TEXT_SIZES.map((s) => TEXT_SIZE_PERCENT[s])
    for (let i = 1; i < pct.length; i++) expect(pct[i]!).toBeGreaterThan(pct[i - 1]!)
  })

  test('the root font size: none of its own at 기본, a percentage of the browser\'s own size otherwise', () => {
    expect(rootFontSize('default')).toBe('')
    expect(rootFontSize('small')).toBe('90%')
    expect(rootFontSize('largest')).toBe('140%')
  })
})

describe('this device', () => {
  test('nothing kept, something unknown or storage blocked: 기본', () => {
    const s = new Mem()
    expect(storedTextSize(s)).toBe('default')
    s.setItem('mycel.textSize', 'huge')
    expect(storedTextSize(s)).toBe('default')
    expect(storedTextSize({ getItem: () => { throw new Error('blocked') } })).toBe('default')
  })

  test('a browser that refuses localStorage itself (reading it throws): 기본, and keeping one is no error', () => {
    const was = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied') } })
    try {
      expect(storedTextSize()).toBe('default')
      expect(() => storeTextSize('large')).not.toThrow()
    } finally {
      if (was) Object.defineProperty(globalThis, 'localStorage', was)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  test('a step is kept; 기본 leaves nothing behind', () => {
    const s = new Mem()
    storeTextSize('largest', s)
    expect(s.getItem('mycel.textSize')).toBe('largest')
    expect(storedTextSize(s)).toBe('largest')
    storeTextSize('default', s)
    expect([...s.m.keys()]).toEqual([])
    // a full or blocked storage is no error
    expect(() => storeTextSize('large', { setItem: () => { throw new Error('full') }, removeItem: () => {} })).not.toThrow()
  })
})

describe('on the page and in the account', () => {
  const me = (textSize?: TextSize): Me => ({
    user: { id: 'alice', username: 'alice', name: 'Alice', email: null, role: 'member', locale: 'en', localeChoice: 'en', mustChangePassword: false, prefs: textSize ? { textSize } : {} },
    team: { name: 'Acme', defaultLocale: 'en' }, groups: [],
    session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: '2030-01-01T00:00:00.000Z' },
    server: { version: 'test', dev: true },
  } as Me)
  const root = () => document.documentElement.style.fontSize
  const originalFetch = globalThis.fetch
  let patches: unknown[]

  beforeEach(() => {
    installDom()
    // the theme, applied with it on sign-in, toggles a class the fake document has no list for
    const html = document.documentElement as unknown as { classList?: unknown }
    html.classList ??= { toggle() {} }
    patches = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prefs?: { textSize?: TextSize } }
      patches.push(body)
      return Response.json(me(body.prefs?.textSize))
    }) as typeof fetch
  })
  afterEach(() => {
    applyTextSize('default')
    // the theme lives in a module of its own that the next file shares: put it back as a fresh page has it
    applyTheme('system')
    useSession.setState({ status: { kind: 'loading' } })
    globalThis.fetch = originalFetch
    removeDom()
  })

  test('applying sets the root font size, and 기본 takes it away again', () => {
    applyTextSize('largest')
    expect(root()).toBe('140%')
    expect(currentTextSize()).toBe('largest')
    applyTextSize('default')
    expect(root()).toBe('')
    expect(currentTextSize()).toBe('default')
  })

  test('signing in: the account\'s size wins and is kept on this device; an account without one keeps this device\'s', () => {
    storeTextSize('small')
    useSession.getState().signedIn(me('larger'))
    expect(root()).toBe('125%')
    expect(storedTextSize()).toBe('larger')
    storeTextSize('small')
    useSession.getState().signedIn(me())
    expect(root()).toBe('90%')
    expect(storedTextSize()).toBe('small')
  })

  test('picking a size shows it before the server answers and saves it to the account with the other preferences', async () => {
    useSession.getState().signedIn({ ...me(), user: { ...me().user, prefs: { answerLocale: 'ko' } } })
    const saving = useSession.getState().setTextSize('largest')
    expect(root()).toBe('140%')
    expect(storedTextSize()).toBe('largest')
    await saving
    // only what changed: the server merges it, so a save of the theme close by cannot put an old size back
    expect(patches).toEqual([{ prefs: { textSize: 'largest' } }])
    const st = useSession.getState().status
    expect(st.kind === 'signed-in' && st.me.user.prefs.textSize).toBe('largest')
  })

  test('an account read that left the server before the save does not undo the size being saved', async () => {
    useSession.getState().signedIn(me('small'))
    let answer!: (r: Response) => void
    globalThis.fetch = (() => new Promise<Response>((r) => { answer = r })) as unknown as typeof fetch
    const saving = useSession.getState().setTextSize('largest')
    expect(root()).toBe('140%')
    // a reconnect's GET /api/me, answered with the old size while the save is on its way
    useSession.getState().signedIn(me('small'))
    expect(root()).toBe('140%')
    expect(storedTextSize()).toBe('largest')
    answer(Response.json(me('largest')))
    await saving
    // saved: the account's size counts again
    useSession.getState().signedIn(me('large'))
    expect(root()).toBe('112.5%')
  })
})
