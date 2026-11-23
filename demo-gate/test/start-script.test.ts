// The landing page's Start: a press before Turnstile finishes waits and starts by itself, exactly once, and no request
// ever leaves without a token. The page's real scripts run here against a small fake page.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { LANGUAGE_NAMES, PAGE_CSP, WORDS, renderPage } from '../src/pages.ts'
import {
  CHECK_MAX_ERRORS, CHECK_WAIT_MS, LANGUAGE_MENU_SCRIPT, LANGUAGE_MENU_SCRIPT_HASH, START_SCRIPT, START_SCRIPT_HASH, START_WAIT_MS,
} from '../src/start-script.ts'
import { LOCALES } from '../src/config.ts'

const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }
const CHECK_ERROR = "We couldn't finish the browser check"
const START_ERROR = "The demo couldn't start"
const KO_URL = 'https://demo.trina.app/?lang=ko'

function fakePage() {
  const attrs = (init: Record<string, string> = {}) => {
    const a = new Map(Object.entries(init))
    return { getAttribute: (k: string) => a.get(k) ?? null, setAttribute: (k: string, v: string) => void a.set(k, v), removeAttribute: (k: string) => void a.delete(k) }
  }
  const button = { ...attrs(), textContent: 'Start' }
  const error = { textContent: '' }, wait = { textContent: '' }
  const input: { value: string; type?: string; name?: string } = { value: '' }
  const sends: string[] = [], replaced: string[] = [], assigned: string[] = []
  let hasInput = false
  const form = {
    ...attrs({ 'data-label': 'Start', 'data-checking': 'Checking…', 'data-retry': 'Try again', 'data-failed': CHECK_ERROR, 'data-stalled': START_ERROR, 'data-home': '/?lang=en' }),
    querySelector: (s: string) => s.includes('button') ? button : s === '.check-error' ? error : s === '.check-wait' ? wait : hasInput ? input : null,
    appendChild: () => { hasInput = true },
    submit: () => { sends.push(input.value) },
  }
  const listeners: Record<string, (e: unknown) => void> = {}
  const timers = new Map<number, { f: () => void; ms: number }>()
  let nextTimer = 1, resets = 0, widget = true
  const win: Record<string, any> = {
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[`win:${t}`] = f },
    turnstile: { reset: () => { if (!widget) throw new Error('no widget'); resets++ } },
  }
  const doc = {
    querySelector: () => form,
    createElement: () => input,
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f },
  }
  new Function('window', 'document', 'location', 'setTimeout', 'clearTimeout', START_SCRIPT)(
    win, doc, { replace: (u: string) => { replaced.push(u) }, assign: (u: string) => { assigned.push(u) } },
    (f: () => void, ms: number) => { timers.set(nextTimer, { f, ms }); return nextTimer++ },
    (id: number) => { timers.delete(id) },
  )
  return {
    win, button, error, wait, sends, replaced, assigned,
    press: () => { let prevented = false; listeners.submit!({ target: form, preventDefault: () => { prevented = true } }); return prevented },
    runTimers: () => { const due = [...timers.values()]; timers.clear(); for (const t of due) t.f() },
    timerMs: () => [...timers.values()].map((t) => t.ms),
    chooseLanguage: (mods: Record<string, boolean> = {}) => {
      let prevented = false
      listeners.click!({ ...mods, target: { closest: () => ({ href: KO_URL }) }, preventDefault: () => { prevented = true } })
      return prevented
    },
    pageshow: (persisted: boolean) => listeners['win:pageshow']!({ persisted }),
    dropWidget: () => { widget = false; delete win.turnstile },
    get resets() { return resets },
  }
}

function fakeMenu() {
  const summary = { focused: false, focus() { this.focused = true } }
  const inside = new Set<unknown>([summary, 'link'])
  const menu = { open: true, querySelector: () => summary, contains: (x: unknown) => inside.has(x) }
  const listeners: Record<string, (e: unknown) => void> = {}
  const doc = {
    querySelector: () => (menu.open ? menu : null),
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f },
  }
  new Function('document', LANGUAGE_MENU_SCRIPT)(doc)
  return { menu, summary, fire: (t: string, e: unknown) => listeners[t]!(e) }
}

describe('Start and the browser check', () => {
  test('press before the token: waits, then starts by itself with exactly one request', () => {
    const p = fakePage()
    expect(p.press()).toBe(true) // the browser's own submit is always held
    expect(p.sends).toEqual([])
    expect(p.button.textContent).toBe('Checking…')
    expect(p.button.getAttribute('aria-busy')).toBe('true')
    expect(p.button.getAttribute('aria-disabled')).toBe('true')
    expect(p.wait.textContent).toBe('Checking…')
    p.win.demoCheckDone('tok-1')
    expect(p.sends).toEqual(['tok-1'])
    p.win.demoCheckDone('tok-2') // a late second token sends nothing
    expect(p.sends).toEqual(['tok-1'])
  })

  test('press after the token: one request at once', () => {
    const p = fakePage()
    p.win.demoCheckDone('tok-1')
    expect(p.sends).toEqual([])
    p.press()
    expect(p.sends).toEqual(['tok-1'])
  })

  test('double press, before and after the token: one request', () => {
    const early = fakePage()
    early.press(); early.press()
    early.win.demoCheckDone('tok-1')
    early.press()
    expect(early.sends).toEqual(['tok-1'])
    const late = fakePage()
    late.win.demoCheckDone('tok-1')
    late.press(); late.press()
    expect(late.sends).toEqual(['tok-1'])
  })

  test('a brief error leaves Turnstile to retry by itself: no red error, and its token starts the demo', () => {
    const p = fakePage()
    p.press()
    expect(p.win.demoCheckFailed('300010')).toBe(true) // true: handled
    expect(p.error.textContent).toBe('')
    expect(p.button.textContent).toBe('Checking…')
    expect(p.resets).toBe(0)
    p.win.demoCheckDone('tok-1')
    expect(p.sends).toEqual(['tok-1'])
  })

  test('errors that keep coming: clear error, then Try again resets the widget and starts once', () => {
    const p = fakePage()
    p.press()
    for (let i = 0; i < CHECK_MAX_ERRORS; i++) expect(p.win.demoCheckFailed('600010')).toBe(true)
    expect(p.sends).toEqual([])
    expect(p.error.textContent).toBe(CHECK_ERROR)
    expect(p.button.textContent).toBe('Try again')
    expect(p.button.getAttribute('aria-busy')).toBeNull()
    expect(p.resets).toBe(0) // never a reset loop on its own
    p.press()
    expect(p.resets).toBe(1)
    expect(p.error.textContent).toBe('')
    expect(p.button.textContent).toBe('Checking…')
    p.win.demoCheckFailed('600010') // the count started again
    expect(p.error.textContent).toBe('')
    p.win.demoCheckDone('tok-2')
    expect(p.sends).toEqual(['tok-2'])
  })

  test('a configuration error, which a retry cannot fix, shows at once', () => {
    const p = fakePage()
    p.press()
    p.win.demoCheckFailed('110200')
    expect(p.error.textContent).toBe(CHECK_ERROR)
  })

  test('an idle token expiry resets quietly: no error, and the old token is never sent', () => {
    const p = fakePage()
    p.win.demoCheckDone('old')
    p.win.demoCheckExpired()
    expect(p.resets).toBe(1)
    expect(p.error.textContent).toBe('')
    expect(p.button.textContent).toBe('Start')
    p.press() // pressed while the reset runs: no second reset, no request
    expect(p.resets).toBe(1)
    expect(p.sends).toEqual([])
    p.win.demoCheckDone('fresh')
    expect(p.sends).toEqual(['fresh'])
  })

  test('an expiry with no widget left shows the error', () => {
    const p = fakePage()
    p.win.demoCheckDone('old')
    p.dropWidget()
    p.win.demoCheckExpired()
    expect(p.error.textContent).toBe(CHECK_ERROR)
  })

  test('Turnstile that never answers: the wait ends in the error; retry opens a fresh page when there is no widget', () => {
    const p = fakePage()
    p.dropWidget()
    p.press()
    expect(p.timerMs()).toEqual([CHECK_WAIT_MS])
    p.runTimers()
    expect(p.button.textContent).toBe('Try again')
    expect(p.sends).toEqual([])
    p.press()
    expect(p.replaced).toEqual(['/?lang=en']) // a GET: reloading the check page would post the form again
    expect(p.sends).toEqual([])
  })

  test('an interactive challenge is not cut off by the wait', () => {
    const p = fakePage()
    p.press()
    p.win.demoCheckInteractive()
    expect(p.timerMs()).toEqual([])
    p.win.demoCheckDone('tok-1')
    expect(p.sends).toEqual(['tok-1'])
  })

  test('back to the page after a send: the used token is dropped and Start works again', () => {
    const p = fakePage()
    p.win.demoCheckDone('used')
    p.press()
    p.pageshow(false)
    expect(p.resets).toBe(0)
    p.pageshow(true)
    expect(p.resets).toBe(1)
    expect(p.timerMs()).toEqual([])
    expect(p.button.textContent).toBe('Start')
    expect(p.button.getAttribute('aria-busy')).toBeNull()
    p.press()
    expect(p.sends).toEqual(['used'])
    p.win.demoCheckDone('new')
    expect(p.sends).toEqual(['used', 'new'])
  })
})

describe('a start that never comes back (stopped or hung load)', () => {
  const stalledPage = () => {
    const p = fakePage()
    p.win.demoCheckDone('used')
    p.press()
    expect(p.timerMs()).toEqual([START_WAIT_MS])
    p.runTimers()
    return p
  }

  test('the limit is longer than the slowest normal start', () => {
    expect(START_WAIT_MS).toBeGreaterThan(10_000 + 15_000)
  })

  test('after the limit: Try again, a clear error, and the button is free', () => {
    const p = stalledPage()
    expect(p.button.textContent).toBe('Try again')
    expect(p.button.getAttribute('aria-busy')).toBeNull()
    expect(p.button.getAttribute('aria-disabled')).toBeNull()
    expect(p.error.textContent).toBe(START_ERROR)
  })

  test('Try again opens a fresh page and never sends the used token again', () => {
    const p = stalledPage()
    p.press()
    p.press()
    expect(p.replaced.every((u) => u === '/?lang=en')).toBe(true)
    expect(p.replaced.length).toBeGreaterThan(0)
    expect(p.sends).toEqual(['used'])
  })

  test('a late Turnstile callback cannot bring the used page back to life', () => {
    const p = stalledPage()
    p.win.demoCheckDone('late')
    p.win.demoCheckFailed('600010')
    p.win.demoCheckExpired()
    expect(p.error.textContent).toBe(START_ERROR)
    p.press()
    expect(p.sends).toEqual(['used'])
    expect(p.replaced).toEqual(['/?lang=en'])
  })

  test('the language links are blocked while the form is on its way, and free after the limit', () => {
    const p = fakePage()
    p.win.demoCheckDone('used')
    p.press()
    expect(p.chooseLanguage()).toBe(true)
    p.runTimers()
    expect(p.chooseLanguage()).toBe(false)
    p.press()
    expect(p.assigned).toEqual([KO_URL])
    expect(p.sends).toEqual(['used'])
  })
})

describe('switching language during the check', () => {
  test('during the wait: the button is free again and the late token starts nothing in the old language', () => {
    const p = fakePage()
    p.press()
    expect(p.chooseLanguage()).toBe(false) // the link navigates
    expect(p.button.getAttribute('aria-busy')).toBeNull()
    expect(p.button.textContent).toBe('Start')
    expect(p.timerMs()).toEqual([])
    p.win.demoCheckDone('late')
    expect(p.sends).toEqual([])
  })

  test('however long the switch takes, Start goes to the chosen language and never posts the old one', () => {
    const p = fakePage()
    p.win.demoCheckDone('tok-1')
    p.chooseLanguage()
    p.runTimers()
    p.press()
    p.press()
    expect(p.sends).toEqual([])
    expect(p.assigned).toEqual([KO_URL, KO_URL])
  })

  test('a link opened in a new tab leaves this page waiting', () => {
    const p = fakePage()
    p.press()
    p.chooseLanguage({ metaKey: true })
    expect(p.button.getAttribute('aria-busy')).toBe('true')
    p.win.demoCheckDone('tok-1')
    expect(p.sends).toEqual(['tok-1'])
  })
})

describe('the language menu closing', () => {
  test('Escape closes it and returns focus', () => {
    const m = fakeMenu()
    m.fire('keydown', { key: 'Escape' })
    expect(m.menu.open).toBe(false)
    expect(m.summary.focused).toBe(true)
  })

  test('focus moving out closes it; focus moving inside does not', () => {
    const m = fakeMenu()
    m.fire('focusout', { target: m.summary, relatedTarget: 'link' })
    expect(m.menu.open).toBe(true)
    m.fire('focusout', { target: 'link', relatedTarget: 'start button' })
    expect(m.menu.open).toBe(false)
  })

  test('no focus target (a tap in Safari, the window losing focus) keeps it open, so a link can still be tapped', () => {
    const m = fakeMenu()
    m.fire('focusout', { target: 'link', relatedTarget: null })
    expect(m.menu.open).toBe(true)
  })

  test('a click outside closes it; a click inside does not', () => {
    const m = fakeMenu()
    m.fire('click', { target: 'link' })
    expect(m.menu.open).toBe(true)
    m.fire('click', { target: 'page' })
    expect(m.menu.open).toBe(false)
  })
})

describe('the language picker', () => {
  test('lists all six in their own names, links only to the allow-list, no flags', () => {
    const html = renderPage('landing', 'en', { siteKey: 'k', links })
    const names = ['English', '한국어', '日本語', '中文', 'Español', 'Bahasa Indonesia']
    LOCALES.forEach((l, i) => {
      expect(LANGUAGE_NAMES[l]).toBe(names[i]!)
      expect(html).toContain(`<a data-lang-link href="/?lang=${l}" lang="${l}" hreflang="${l}"`)
    })
    expect(html.match(/data-lang-link href/g)?.length).toBe(6)
    expect(html).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u)
    expect(html.match(/aria-current="true"/g)?.length).toBe(1)
    expect(html).toContain('<a data-lang-link href="/?lang=en" lang="en" hreflang="en" aria-current="true">')
  })

  test('offers only the languages this gate runs, and nothing with one language', () => {
    for (const k of ['landing', 'busy'] as const) {
      const two = renderPage(k, 'en', { siteKey: 'k', links, locales: ['en', 'ko'] })
      expect(two.match(/data-lang-link href/g)?.length).toBe(2)
      expect(two).not.toContain('/?lang=ja')
      expect(renderPage(k, 'en', { siteKey: 'k', links, locales: ['en'] })).not.toContain('class="lang"')
    }
  })

  test('is on the landing and busy pages only: from busy, a visitor can reach a language with a free copy', () => {
    for (const k of ['landing', 'busy'] as const) {
      const html = renderPage(k, 'en', { siteKey: 'k', links })
      expect(html, k).toContain('<details class="lang">')
      expect(html, k).toContain(`<script data-lang-menu>${LANGUAGE_MENU_SCRIPT}</script>`)
    }
    for (const k of ['limit', 'check', 'ended', 'error'] as const) {
      const html = renderPage(k, 'en', { siteKey: 'k', links })
      expect(html, k).not.toContain('<details class="lang">')
      expect(html, k).not.toContain('data-lang-menu')
    }
  })

  test('busy and error keep the chosen language on Try again', () => {
    for (const l of LOCALES) for (const k of ['busy', 'error'] as const) {
      const html = renderPage(k, l, { siteKey: 'k', links })
      expect(html, `${l} ${k}`).toContain(`<a class="secondary" href="/?lang=${l}">${WORDS[l].retry}</a>`)
      expect(html, `${l} ${k}`).not.toContain('href="/"')
    }
  })

  test('sits outside the page flow, so opening it moves nothing; 44 px targets on phones', () => {
    const html = renderPage('landing', 'en', { siteKey: 'k', links })
    expect(html).toMatch(/\.lang \{ position:absolute;/)
    expect(html).toMatch(/\.lang ul \{ position:absolute;/)
    expect(html).toMatch(/@media \(max-width:480px\), \(pointer:coarse\) \{[^\n]*\.lang summary, \.lang a \{ min-height:44px; \}/)
  })
})

describe('the page around it', () => {
  test('the CSP allows exactly these two scripts, by hash, and no inline script in general', () => {
    const hash = (s: string) => `sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}`
    expect(START_SCRIPT_HASH).toBe(hash(START_SCRIPT))
    expect(LANGUAGE_MENU_SCRIPT_HASH).toBe(hash(LANGUAGE_MENU_SCRIPT))
    const scriptSrc = PAGE_CSP.split(';').find((d) => d.trim().startsWith('script-src'))!
    expect(scriptSrc.trim()).toBe(`script-src '${START_SCRIPT_HASH}' '${LANGUAGE_MENU_SCRIPT_HASH}' https://challenges.cloudflare.com`)
    expect(PAGE_CSP).not.toContain('unsafe-eval')
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(START_SCRIPT).not.toContain('</script')
    expect(LANGUAGE_MENU_SCRIPT).not.toContain('</script')
    expect(CHECK_WAIT_MS).toBeGreaterThan(15_000) // longer than a slow, normal check
  })

  test('every language has the waiting word, and each Start page wires the widget to the script', () => {
    for (const l of LOCALES) {
      expect(WORDS[l].checking.length, l).toBeGreaterThan(1)
      for (const k of ['landing', 'check', 'ended'] as const) {
        const html = renderPage(k, l, { siteKey: 'k', links })
        expect(html, `${l} ${k}`).toContain(`<script data-start>${START_SCRIPT}</script>`)
        expect(html.indexOf(START_SCRIPT), `${l} ${k}: callbacks exist before Turnstile loads`).toBeLessThan(html.indexOf('turnstile/v0/api.js'))
        for (const cb of ['data-callback="demoCheckDone"', 'data-error-callback="demoCheckFailed"', 'data-expired-callback="demoCheckExpired"', 'data-timeout-callback="demoCheckStopped"', 'data-unsupported-callback="demoCheckStopped"']) expect(html, `${l} ${k}`).toContain(cb)
        expect(html, `${l} ${k}`).not.toContain('data-retry="never"') // Turnstile's own retry covers brief network errors
        expect(html, `${l} ${k}`).toContain(`data-checking="${WORDS[l].checking}"`)
        expect(html, `${l} ${k}`).toContain(`data-home="/?lang=${l}"`)
        expect(html, `${l} ${k}`).toContain('role="alert"')
        expect(html, `${l} ${k}`).toContain('role="status"')
      }
    }
  })

  test('the error line has room for two lines on narrow phones, so it does not move Start', () => {
    const html = renderPage('landing', 'es', { siteKey: 'k', links })
    expect(html).toMatch(/@media \(max-width:420px\) \{ \.check-error \{ min-height:2\.9em; \} \}/)
  })

  test('pages without Start carry no Start script; limit and error carry none at all', () => {
    expect(renderPage('busy', 'en', { siteKey: 'k', links })).not.toContain('data-start')
    for (const k of ['limit', 'error'] as const) expect(renderPage(k, 'en', { siteKey: 'k', links })).not.toContain('<script')
  })
})
