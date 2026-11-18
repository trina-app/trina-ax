// The in-app browser always has its toolbar (desktop/src/common/pane-chrome.ts): the toolbar's own page loads again after
// it failed, a few times at most, then the browser closes; ↗ opens only web addresses. The views themselves are checked
// in the desktop e2e (desktop/e2e/pane-close.spec.ts).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHROME_RELOAD_WINDOW_MS, CHROME_RELOADS, chromeRecovery, externalUrl } from '../../desktop/src/common/pane-chrome'
import { STRINGS } from '../../desktop/src/common/i18n'

describe('the toolbar loads again', () => {
  test('a few times within a minute, then the browser closes', () => {
    let failures: number[] = []
    const actions: string[] = []
    for (let i = 0; i <= CHROME_RELOADS; i++) {
      const r = chromeRecovery(failures, 1_000 + i * 1_000)
      failures = r.failures
      actions.push(r.action)
    }
    expect(actions).toEqual([...Array(CHROME_RELOADS).fill('reload'), 'close'])
  })

  test('failures older than the window no longer count', () => {
    const old = [0, 1, 2, 3, 4]
    const r = chromeRecovery(old, CHROME_RELOAD_WINDOW_MS + 10)
    expect(r).toEqual({ action: 'reload', failures: [CHROME_RELOAD_WINDOW_MS + 10] })
  })
})

describe('open in your browser', () => {
  test('web addresses only', () => {
    expect(externalUrl('https://drive.google.com/file/d/x/view')).toBe('https://drive.google.com/file/d/x/view')
    expect(externalUrl('http://shop.test:19153/')).toBe('http://shop.test:19153/')
    for (const u of ['about:blank', 'file:///etc/passwd', 'mycel-ui://app/pane.html', 'javascript:alert(1)', 'chrome://gpu', '', undefined, 'not a url'])
      expect(externalUrl(u)).toBeNull()
  })

  test('every language names the button', () => {
    for (const [lang, s] of Object.entries(STRINGS)) expect((s as Record<string, string>)['pane.openExternal'], lang).toBeTruthy()
  })

  test('the window wires the toolbar recovery and the button', () => {
    const read = (f: string) => readFileSync(join(import.meta.dir, '../../desktop/src', f), 'utf8')
    const win = read('main/app-window.ts')
    expect(win).toContain("on('render-process-gone'")
    expect(win).toContain('chromeRecovery(')
    // the browser is drawn only under a live toolbar
    expect(win).toContain('!this.chromeDown')
    expect(read('main/main.ts')).toContain("'ui:pane-open-external'")
    expect(read('ui/pane.ts')).toContain('ui.pane.openExternal()')
  })
})
