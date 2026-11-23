// The landing page's Start: a press before Turnstile finishes waits and starts by itself, exactly once, and no request
// ever leaves without a token. The page's real script runs here against a small fake page.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { LANGUAGE_NAMES, PAGE_CSP, WORDS, renderPage } from '../src/pages.ts'
import { CHECK_WAIT_MS, START_SCRIPT, START_SCRIPT_HASH } from '../src/start-script.ts'
import { LOCALES } from '../src/config.ts'

const links = { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing' }

function fakePage() {
  const attrs = (init: Record<string, string> = {}) => {
    const a = new Map(Object.entries(init))
    return { getAttribute: (k: string) => a.get(k) ?? null, setAttribute: (k: string, v: string) => void a.set(k, v), removeAttribute: (k: string) => void a.delete(k) }
  }
  const button = { ...attrs(), textContent: 'Start' }
  const error = { textContent: '' }, wait = { textContent: '' }
  const input: { value: string; type?: string; name?: string } = { value: '' }
  const sends: string[] = []
  let hasInput = false
  const form = {
    ...attrs({ 'data-label': 'Start', 'data-checking': 'Checking…', 'data-retry': 'Try again', 'data-failed': "We couldn't finish the browser check" }),
    querySelector: (s: string) => s.includes('button') ? button : s === '.check-error' ? error : s === '.check-wait' ? wait : hasInput ? input : null,
    appendChild: () => { hasInput = true },
    submit: () => { sends.push(input.value) },
  }
  const listeners: Record<string, (e: unknown) => void> = {}
  const timers = new Map<number, () => void>()
  let nextTimer = 1, resets = 0, reloads = 0, widget = true
  const summary = { focused: false, focus() { this.focused = true } }
  let menu: { open: boolean; querySelector: () => typeof summary } | null = null
  const win: Record<string, any> = {
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[`win:${t}`] = f },
    turnstile: { reset: () => { if (!widget) throw new Error('no widget'); resets++ } },
  }
  const doc = {
    querySelector: (s: string) => s.includes('details') ? menu : form,
    createElement: () => input,
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f },
  }
  new Function('window', 'document', 'location', 'setTimeout', 'clearTimeout', START_SCRIPT)(
    win, doc, { reload: () => { reloads++ } },
    (f: () => void) => { timers.set(nextTimer, f); return nextTimer++ },
    (id: number) => { timers.delete(id) },
  )
  return {
    win, button, error, wait, sends,
    press: () => { let prevented = false; listeners.submit!({ target: form, preventDefault: () => { prevented = true } }); return prevented },
    runTimers: () => { const due = [...timers.values()]; timers.clear(); for (const f of due) f() },
    timerCount: () => timers.size,
    summary,
    openMenu: () => { menu = { open: true, querySelector: () => summary }; return menu },
    key: (key: string) => listeners.keydown!({ key }),
    chooseLanguage: (mods: Record<string, boolean> = {}) => { let prevented = false; const link = {}; listeners.click!({ ...mods, target: { closest: (s: string) => s.includes('data-lang-link') ? link : link }, preventDefault: () => { prevented = true } }); return prevented },
    pageshow: (persisted: boolean) => listeners['win:pageshow']!({ persisted }),
    dropWidget: () => { widget = false; delete win.turnstile },
    get resets() { return resets },
    get reloads() { return reloads },
  }
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

  test('Turnstile error, then retry: clear error, widget reset, starts once on the new token', () => {
    const p = fakePage()
    p.press()
    expect(p.win.demoCheckFailed('600010')).toBe(true) // true: handled, Turnstile does not throw
    expect(p.sends).toEqual([])
    expect(p.error.textContent).toBe("We couldn't finish the browser check")
    expect(p.button.textContent).toBe('Try again')
    expect(p.button.getAttribute('aria-busy')).toBeNull()
    expect(p.resets).toBe(0) // never a reset loop on its own
    p.press()
    expect(p.resets).toBe(1)
    expect(p.error.textContent).toBe('')
    expect(p.button.textContent).toBe('Checking…')
    expect(p.sends).toEqual([])
    p.win.demoCheckDone('tok-2')
    expect(p.sends).toEqual(['tok-2'])
  })

  test('an expired token is never sent: error shown, widget reset, the fresh token clears it', () => {
    const p = fakePage()
    p.win.demoCheckDone('old')
    p.win.demoCheckExpired()
    expect(p.resets).toBe(1)
    expect(p.error.textContent).not.toBe('')
    p.press() // pressed while the reset runs: no second reset, no request
    expect(p.resets).toBe(1)
    expect(p.sends).toEqual([])
    p.win.demoCheckDone('fresh')
    expect(p.sends).toEqual(['fresh'])
  })

  test('Turnstile that never answers: the wait ends in the error; retry reloads when there is no widget', () => {
    const p = fakePage()
    p.dropWidget()
    p.press()
    expect(p.timerCount()).toBe(1)
    p.runTimers()
    expect(p.button.textContent).toBe('Try again')
    expect(p.sends).toEqual([])
    p.press()
    expect(p.reloads).toBe(1)
    expect(p.sends).toEqual([])
  })

  test('an interactive challenge is not cut off by the wait', () => {
    const p = fakePage()
    p.press()
    p.win.demoCheckInteractive()
    expect(p.timerCount()).toBe(0)
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
    expect(p.button.textContent).toBe('Start')
    expect(p.button.getAttribute('aria-busy')).toBeNull()
    p.press()
    expect(p.sends).toEqual(['used'])
    p.win.demoCheckDone('new')
    expect(p.sends).toEqual(['used', 'new'])
  })
})

describe('switching language during the check', () => {
  test('during the wait: the button is free again and the late token starts nothing in the old language', () => {
    const p = fakePage()
    p.press()
    expect(p.chooseLanguage()).toBe(false) // the link navigates
    expect(p.button.getAttribute('aria-busy')).toBeNull()
    expect(p.button.textContent).toBe('Start')
    expect(p.timerCount()).toBe(1) // only the short "still here" timer, not the check's wait
    p.win.demoCheckDone('late')
    p.press()
    expect(p.sends).toEqual([])
  })

  test('a link that failed to navigate leaves Start working', () => {
    const p = fakePage()
    p.press()
    p.chooseLanguage()
    p.win.demoCheckDone('tok-1')
    p.runTimers()
    p.press()
    expect(p.sends).toEqual(['tok-1'])
  })

  test('once the start is on its way, a language click cannot race it', () => {
    const p = fakePage()
    p.win.demoCheckDone('tok-1')
    p.press()
    expect(p.chooseLanguage()).toBe(true)
    expect(p.sends).toEqual(['tok-1'])
  })

  test('a link opened in a new tab leaves this page waiting', () => {
    const p = fakePage()
    p.press()
    p.chooseLanguage({ metaKey: true })
    expect(p.button.getAttribute('aria-busy')).toBe('true')
    p.win.demoCheckDone('tok-1')
    expect(p.sends).toEqual(['tok-1'])
  })

  test('Escape closes the menu and returns focus to it', () => {
    const p = fakePage()
    const menu = p.openMenu()
    p.key('Escape')
    expect(menu.open).toBe(false)
    expect(p.summary.focused).toBe(true)
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

  test('offers only the languages this gate runs, and nothing with one language or off the landing', () => {
    const two = renderPage('landing', 'en', { siteKey: 'k', links, locales: ['en', 'ko'] })
    expect(two.match(/data-lang-link href/g)?.length).toBe(2)
    expect(two).not.toContain('/?lang=ja')
    expect(renderPage('landing', 'en', { siteKey: 'k', links, locales: ['en'] })).not.toContain('class="lang"')
    for (const k of ['busy', 'limit', 'check', 'ended', 'error'] as const) expect(renderPage(k, 'en', { siteKey: 'k', links })).not.toContain('class="lang"')
  })

  test('sits outside the page flow, so opening it moves nothing', () => {
    const html = renderPage('landing', 'en', { siteKey: 'k', links })
    expect(html).toMatch(/\.lang \{ position:absolute;/)
    expect(html).toMatch(/\.lang ul \{ position:absolute;/)
  })
})

describe('the page around it', () => {
  test('the CSP allows exactly this script, by hash, and no inline script in general', () => {
    const digest = crypto.createHash('sha256').update(START_SCRIPT, 'utf8').digest('base64')
    expect(START_SCRIPT_HASH).toBe(`sha256-${digest}`)
    const scriptSrc = PAGE_CSP.split(';').find((d) => d.trim().startsWith('script-src'))!
    expect(scriptSrc.trim()).toBe(`script-src '${START_SCRIPT_HASH}' https://challenges.cloudflare.com`)
    expect(PAGE_CSP).not.toContain('unsafe-eval')
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(START_SCRIPT).not.toContain('</script')
    expect(CHECK_WAIT_MS).toBeGreaterThan(15_000) // longer than a slow, normal check
  })

  test('every language has the waiting word, and each Start page wires the widget to the script', () => {
    for (const l of LOCALES) {
      expect(WORDS[l].checking.length, l).toBeGreaterThan(1)
      for (const k of ['landing', 'check', 'ended'] as const) {
        const html = renderPage(k, l, { siteKey: 'k', links })
        expect(html, `${l} ${k}`).toContain(`<script data-start>${START_SCRIPT}</script>`)
        expect(html.indexOf(START_SCRIPT), `${l} ${k}: callbacks exist before Turnstile loads`).toBeLessThan(html.indexOf('turnstile/v0/api.js'))
        for (const cb of ['data-callback="demoCheckDone"', 'data-error-callback="demoCheckFailed"', 'data-expired-callback="demoCheckExpired"', 'data-timeout-callback="demoCheckFailed"']) expect(html, `${l} ${k}`).toContain(cb)
        expect(html, `${l} ${k}`).toContain(`data-checking="${WORDS[l].checking}"`)
        expect(html, `${l} ${k}`).toContain('role="alert"')
        expect(html, `${l} ${k}`).toContain('role="status"')
      }
    }
  })

  test('pages without Start carry no script', () => {
    for (const k of ['busy', 'limit', 'error'] as const) expect(renderPage(k, 'en', { siteKey: 'k', links })).not.toContain('<script')
  })
})
