// "Find work files on this computer": the app's own consent window (desktop/src/common/work-consent.ts,
// desktop/src/main/work-consent-window.ts; docs/DECISIONS.md "Find work files: the app's own consent window"). What it
// lists is what the look goes through; only that window, from its own address, can answer; a yes counts once and not
// before the window has been seen without typing; the team page has no way to read or answer it.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONSENT_ARM_MS, CONSENT_URL, ConsentGate, consentSender, consentView } from '../../desktop/src/common/work-consent'
import { UI_LOCALES } from '../../desktop/src/common/i18n'
import type { WorkRoot } from '../../desktop/src/common/work-files'
import type { Place } from '../../desktop/src/common/work-places'

const roots: WorkRoot[] = [
  { id: 'documents', path: '/h/Documents', oneDrive: false },
  { id: 'desktop', path: '/h/Desktop', oneDrive: false },
  { id: 'downloads', path: '/h/Downloads', oneDrive: false },
]
const places: Place[] = [
  { kind: 'messenger', path: '/h/Downloads/KakaoTalk', label: 'KakaoTalk' },
  { kind: 'folder', path: '/h/Acme', label: 'Acme' },
  { kind: 'cloud', path: '/h/Library/CloudStorage/OneDrive-Acme', label: 'OneDrive – Acme' },
]

describe('what the window says', () => {
  test('the three folders, by the roots the look goes through (a folder the app cannot find is not listed)', () => {
    const v = consentView('en', 'darwin', roots, null)
    expect(v.places).toEqual([
      { icon: 'documents', name: 'Documents' },
      { icon: 'desktop', name: 'Desktop' },
      { icon: 'downloads', name: 'Downloads' },
    ])
    expect(consentView('en', 'darwin', roots.slice(0, 2), null).places.map((p) => p.name)).toEqual(['Documents', 'Desktop'])
    expect(v.fine).toContain('macOS asks once for each folder')
    expect([v.yes, v.no]).toEqual(['Find work files', 'Not now'])
  })
  test('a wide look lists every place, then the recent files and where they are; OneDrive is named', () => {
    const v = consentView('en', 'win32', [{ ...roots[0]!, oneDrive: true }, ...roots.slice(1)], places)
    expect(v.places).toEqual([
      { icon: 'cloud', name: 'Documents', note: 'OneDrive' },
      { icon: 'desktop', name: 'Desktop' },
      { icon: 'downloads', name: 'Downloads' },
      { icon: 'messenger', name: 'KakaoTalk downloads' },
      { icon: 'folder', name: 'Acme' },
      { icon: 'cloud', name: 'OneDrive – Acme' },
      { icon: 'recent', name: 'Recently opened files', note: 'this PC and network drives' },
    ])
    expect(v.fine).toContain("Cloud-only files aren't downloaded")
    expect(consentView('en', 'darwin', roots, places).fine).toContain('Mail, Messages, Photos, Safari')
  })
  test('every language says plainly that file names may go to the team\'s AI, with no word left unfilled', () => {
    for (const { id } of UI_LOCALES) {
      for (const [platform, wide] of [['darwin', null], ['darwin', places], ['win32', null], ['win32', places]] as const) {
        const v = consentView(id, platform, roots, wide)
        const all = [v.title, v.sub, v.placesLabel, v.fine, v.yes, v.no, ...v.promises.map((p) => p.text), ...v.places.flatMap((p) => [p.name, p.note ?? ''])]
        for (const s of all) expect(s, `${id} ${platform}`).not.toMatch(/\{\w+\}/)
        expect(v.promises.map((p) => p.icon), id).toEqual(['check', 'check', 'ai'])
        expect(v.promises[2]!.text, id).toMatch(/AI|IA/)
        expect(v.yes.length, id).toBeGreaterThan(0)
      }
    }
  })
})

describe('a yes counts only when the person could have meant it', () => {
  const clock = () => {
    let now = 1000
    return { now: () => now, go: (ms: number) => (now += ms) }
  }
  test('not before the window is shown, not in its first moment; then once', () => {
    const c = clock()
    const g = new ConsentGate(c.now)
    expect(g.answer(true)).toBeNull()
    g.shown()
    c.go(CONSENT_ARM_MS - 1)
    expect(g.answer(true)).toBeNull()
    c.go(1)
    expect(g.answer(true)).toBe(true)
    expect(g.answer(true)).toBeNull()
    expect(g.answer(false)).toBeNull()
    expect(g.close()).toBeNull()
  })
  test('typing into the window (the person did not see it) holds the yes back; Tab, Enter and Escape do not', () => {
    const c = clock()
    const g = new ConsentGate(c.now)
    g.shown()
    c.go(2000)
    g.key('h')
    g.key('i')
    c.go(100)
    g.key('Enter')
    expect(g.answer(true)).toBeNull()
    c.go(CONSENT_ARM_MS)
    g.key('Tab')
    g.key('Enter')
    expect(g.answer(true)).toBe(true)
  })
  test('a held Enter (key repeat) counts as typing', () => {
    const c = clock()
    const g = new ConsentGate(c.now)
    g.shown()
    c.go(2000)
    g.key('Enter', true)
    expect(g.answer(true)).toBeNull()
  })
  test('no is never held back; closing is a no; anything but true is a no', () => {
    const c = clock()
    expect(new ConsentGate(c.now).answer(false)).toBe(false)
    expect(new ConsentGate(c.now).answer('yes')).toBe(false)
    expect(new ConsentGate(c.now).close()).toBe(false)
  })
})

describe('only the consent window answers', () => {
  const page = { id: 'consent' }
  const open = new Set([page])
  const top = (url: string) => ({ url, parent: null })
  test('its own top frame at its own address', () => {
    expect(consentSender({ sender: page, senderFrame: top(CONSENT_URL) }, open)).toBe(true)
  })
  test('the team page, another of the app\'s screens, a frame, or a closed window: refused', () => {
    expect(consentSender({ sender: { id: 'team' }, senderFrame: top('https://acme.trina.app/files') }, open)).toBe(false)
    expect(consentSender({ sender: { id: 'team' }, senderFrame: top(CONSENT_URL) }, open)).toBe(false)
    expect(consentSender({ sender: page, senderFrame: top('https://acme.trina.app/consent.html') }, open)).toBe(false)
    expect(consentSender({ sender: page, senderFrame: top(CONSENT_URL.replace('consent', 'welcome')) }, open)).toBe(false)
    expect(consentSender({ sender: page, senderFrame: { url: CONSENT_URL, parent: {} } }, open)).toBe(false)
    expect(consentSender({ sender: page, senderFrame: null }, open)).toBe(false)
    expect(consentSender({ sender: page, senderFrame: top(CONSENT_URL) }, new Set())).toBe(false)
  })
})

describe('the wiring', () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, '../../desktop', p), 'utf8')
  const ctl = read('src/main/work-files.ts')
  const win = read('src/main/work-consent-window.ts')
  const appPreload = read('src/preload/app.ts')
  const consentPreload = read('src/preload/consent.ts')
  const main = read('src/main/main.ts')
  test('the look waits for the app\'s own window; no native alert, nothing the page can reach', () => {
    expect(ctl).not.toContain('showMessageBox')
    expect(ctl.indexOf('await this.consent(')).toBeLessThan(ctl.indexOf('await this.look(roots'))
    // the same roots and places the look then uses
    expect(ctl).toContain('const yes = await this.consent(win, roots, wide ? places : null)')
    expect(ctl).toContain('consentView(this.o.locale(), process.platform, roots, places)')
    // another person or team closes it as a no
    expect(ctl).toMatch(/forget\(\) \{\s*this\.asking\?\.close\(\)/)
  })
  test('the window: a modal child of the app window, the app\'s own page and session, sandboxed, no navigation', () => {
    expect(win).toContain('parent: o.parent')
    expect(win).toContain('modal: true')
    expect(win).toContain("webPreferences: { preload: o.preload, ...APP_WEB_PREFERENCES, partition: 'mycel-ui' }")
    expect(win).toContain('guardUiView(wc)')
    expect(win).toContain('void wc.loadURL(CONSENT_URL)')
    // both channels check the sender; a yes goes through the gate
    expect(win).toContain("e.returnValue = consentSender(e, open) ?")
    expect(win).toMatch(/'consent:answer'[\s\S]*?if \(!consentSender\(e, open\)\) return[\s\S]*?o\.gate\.answer\(yes === true\)/)
    expect(win).toContain("closed', () => {")
  })
  test('the team page\'s preload has no consent channel; the window\'s preload gives back only yes or no', () => {
    expect(appPreload).not.toContain('consent:')
    expect(main).not.toContain('consent:')
    expect(consentPreload.match(/ipcRenderer\.\w+\(/g)).toEqual(['ipcRenderer.sendSync(', 'ipcRenderer.send('])
    expect(consentPreload).toContain("ipcRenderer.send('consent:answer', yes === true)")
  })
})
