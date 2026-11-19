// The scripted demo's end (web/demo/end.tsx, web/demo/live.ts; docs/decisions/20261119-demo-free-roam-web.md): "Now try
// it yourself" is offered only after the live demo's gate said `{ available: true }` in time; a failure, a slow answer or
// `available: false` keeps only the plans link with the busy line. In the end line and in the end popup.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { useLocaleStore } from '../../src/i18n'
import { EndLineLinks, EndPopupBusy, EndPopupButtons, type EndLinks } from '../../demo/end'
import { liveAvailable, statusUrl, useLiveDemo } from '../../demo/live'
import { en as minaEn } from '../../../scripts/demo/mina/strings/en'
import { es as minaEs } from '../../../scripts/demo/mina/strings/es'
import { id as minaId } from '../../../scripts/demo/mina/strings/id'
import { ja as minaJa } from '../../../scripts/demo/mina/strings/ja'
import { ko as minaKo } from '../../../scripts/demo/mina/strings/ko'
import { zh as minaZh } from '../../../scripts/demo/mina/strings/zh'
import { installDom, mount, removeDom } from './dom-host'

const LIVE = { label: 'Now try it yourself', busy: 'The live demo is busy right now', retry: 'Try again', url: 'https://demo.trina.app/?lang=en' }
const SIGNUP = { label: 'See plans', url: 'https://ax.trina.app/pricing' }
const links = (state: EndLinks['state']): EndLinks => ({ signup: SIGNUP, live: LIVE, state })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let localeBefore = useLocaleStore.getState().locale
beforeAll(() => { installDom(); localeBefore = useLocaleStore.getState().locale; useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { useLocaleStore.setState({ locale: localeBefore }); removeDom() })

describe('the live demo\'s status', () => {
  test('its address: the gate\'s origin, the story\'s language', () => {
    expect(statusUrl('https://demo.trina.app/?lang=ko')).toBe('https://demo.trina.app/__demo/status?lang=ko')
    expect(statusUrl('https://demo.trina.app/')).toBe('https://demo.trina.app/__demo/status')
    expect(statusUrl('javascript:alert(1)')).toBeNull()
    expect(statusUrl('not a url')).toBeNull()
  })

  test('only a quick { available: true } is yes', async () => {
    const asked: string[] = []
    const answer = (r: Response | Error | 'hang') => (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input))
      if (r === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      if (r instanceof Error) throw r
      return r
    }) as typeof fetch
    expect(await liveAvailable(LIVE.url, { fetch: answer(json(200, { available: true })) })).toBe(true)
    expect(asked).toEqual(['https://demo.trina.app/__demo/status?lang=en'])
    expect(await liveAvailable(LIVE.url, { fetch: answer(json(200, { available: false })) })).toBe(false)
    expect(await liveAvailable(LIVE.url, { fetch: answer(json(200, { available: 'yes' })) })).toBe(false)
    expect(await liveAvailable(LIVE.url, { fetch: answer(json(503, { available: true })) })).toBe(false)
    expect(await liveAvailable(LIVE.url, { fetch: answer(new TypeError('Failed to fetch')) })).toBe(false)
    expect(await liveAvailable(LIVE.url, { fetch: answer(new Response('<html>', { status: 200 })) })).toBe(false)
    const t0 = Date.now()
    expect(await liveAvailable(LIVE.url, { fetch: answer('hang'), timeoutMs: 50 })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('the end line', () => {
  test('available: "Now try it yourself" first, to the live demo; the plans link beside it, in a new tab', async () => {
    const m = await mount(<EndLineLinks {...links('available')} />)
    try {
      expect(m.get('demo-try-live').getAttribute('href')).toBe(LIVE.url)
      expect(m.get('demo-try-live').textContent).toBe('Now try it yourself →')
      expect(m.get('demo-signup').getAttribute('href')).toBe(SIGNUP.url)
      expect(m.get('demo-signup').getAttribute('target')).toBe('_blank')
      expect(m.find('demo-live-busy')).toBeNull()
    } finally { await m.unmount() }
  })

  test('busy: the line that it is busy and only the plans link, as the primary', async () => {
    const m = await mount(<EndLineLinks {...links('busy')} />)
    try {
      expect(m.get('demo-live-busy').textContent).toBe('The live demo is busy right now')
      expect(m.find('demo-try-live')).toBeNull()
      expect(m.get('demo-signup').className).toContain('demo-next')
    } finally { await m.unmount() }
  })

  test('while it is asked: the button waits, never a link that may lead nowhere', async () => {
    const m = await mount(<EndLineLinks {...links('checking')} />)
    try {
      expect(m.find('demo-try-live')).toBeNull()
      expect(m.get('demo-try-live-checking').getAttribute('aria-busy')).toBe('true')
    } finally { await m.unmount() }
  })

  test('a story without a live demo: the plans link as before, no busy line', async () => {
    const m = await mount(<EndLineLinks signup={SIGNUP} state="busy" />)
    try {
      expect(m.find('demo-live-busy')).toBeNull()
      expect(m.get('demo-signup').getAttribute('href')).toBe(SIGNUP.url)
    } finally { await m.unmount() }
  })
})

describe('the end popup', () => {
  const buttons = (state: EndLinks['state'], went: string[], opened: string[]) => (
    <EndPopupButtons {...links(state)} close="Look around" restart="Start over" onClose={() => {}} onRestart={() => {}} go={(u) => went.push(u)} open={(u) => opened.push(u)} />
  )
  test('available: Look around, See plans, and "Now try it yourself" as the primary', async () => {
    const went: string[] = []
    const opened: string[] = []
    const m = await mount(<>{buttons('available', went, opened)}<EndPopupBusy {...links('available')} /></>)
    try {
      expect(m.container.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Look around', 'See plans', 'Now try it yourself'])
      expect(m.get('demo-popup-try-live').className).toContain('bg-accent')
      await m.click('demo-popup-try-live')
      await m.click('demo-popup-signup')
      expect(went).toEqual([LIVE.url])
      expect(opened).toEqual([SIGNUP.url])
      expect(m.find('demo-popup-live-busy')).toBeNull()
    } finally { await m.unmount() }
  })

  test('busy: the popup as before (plans as the primary) and the busy line', async () => {
    const m = await mount(<>{buttons('busy', [], [])}<EndPopupBusy {...links('busy')} /></>)
    try {
      expect(m.container.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Start over', 'Look around', 'See plans'])
      expect(m.get('demo-popup-signup').className).toContain('bg-accent')
      expect(m.get('demo-popup-live-busy').textContent).toBe('The live demo is busy right now')
    } finally { await m.unmount() }
  })
})

test('the story: every language has the button and the busy line (the address with the story\'s language: scripts/demo/mina/story.ts)', () => {
  expect([minaEn.end.tryLive, minaEn.end.liveBusy]).toEqual(['Now try it yourself', 'The live demo is busy right now'])
  expect(minaKo.end.tryLive).toBe('이제 직접 써 보세요')
  for (const s of [minaEn, minaKo, minaJa, minaEs, minaId, minaZh]) {
    expect(s.end.tryLive.trim().length).toBeGreaterThan(0)
    expect(s.end.liveBusy.trim().length).toBeGreaterThan(0)
  }
  // translated, not left in English
  for (const s of [minaKo, minaJa, minaEs, minaId, minaZh]) expect(s.end.tryLive).not.toBe(minaEn.end.tryLive)
})

describe('"Try again" after the busy line', () => {
  test('the end line and the popup: a small Try again that reads the gate\'s status again', async () => {
    let asked = 0
    const m = await mount(<><EndLineLinks {...links('busy')} onRetry={() => asked++} /><EndPopupBusy {...links('busy')} onRetry={() => asked++} /></>)
    try {
      expect(m.get('demo-live-busy').textContent).toBe('The live demo is busy right now')
      expect(m.get('demo-live-retry').textContent).toBe('Try again')
      await m.click('demo-live-retry')
      await m.click('demo-popup-live-retry')
      expect(asked).toBe(2)
    } finally { await m.unmount() }
    // available, or no way to ask again: no Try again
    const n = await mount(<><EndLineLinks {...links('available')} onRetry={() => asked++} /><EndLineLinks {...links('busy')} /></>)
    try { expect(n.find('demo-live-retry')).toBeNull() } finally { await n.unmount() }
  })

  test('useLiveDemo: busy, then Try again asks the gate again and offers the live demo once it can take a visitor', async () => {
    const answers = [false, true]
    let calls = 0
    const fake = (async () => { calls++; return json(200, { available: answers.shift() ?? false }) }) as unknown as typeof fetch
    function Probe() {
      const [state, recheck] = useLiveDemo(LIVE.url, true, { fetch: fake })
      return <><p data-testid="state">{state}</p><EndLineLinks {...links(state)} onRetry={recheck} /></>
    }
    const m = await mount(<Probe />)
    try {
      await m.until(() => m.get('state').textContent === 'busy', 'busy')
      expect(calls).toBe(1)
      await m.click('demo-live-retry')
      await m.until(() => m.get('state').textContent === 'available', 'available')
      expect(calls).toBe(2)
      expect(m.get('demo-try-live').getAttribute('href')).toBe(LIVE.url)
    } finally { await m.unmount() }
  })
})

test('every story language has the busy line\'s Try again', () => {
  for (const s of [minaEn, minaKo, minaEs, minaId, minaJa, minaZh]) expect(s.end.liveRetry.trim().length).toBeGreaterThan(0)
  expect(minaEn.end.liveRetry).toBe('Try again')
})
