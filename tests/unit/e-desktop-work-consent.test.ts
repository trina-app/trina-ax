// "Find work files on this computer": the app's own consent window (desktop/src/common/work-consent.ts,
// desktop/src/main/work-consent-window.ts; docs/DECISIONS.md "Find work files: the app's own consent window"). What it
// lists is what the look goes through; only that window, from its own address, can answer; a yes counts once and not
// before the window has been seen without typing; the team page has no way to read or answer it.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONSENT_ARM_MS, CONSENT_REMEMBER_MS, CONSENT_URL, ConsentGate, consentSender, consentView, covered, memoryKey, parseMemory, PERSON_INPUT_MS, placeKeys } from '../../desktop/src/common/work-consent'
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
    // that early yes started the wait again
    c.go(CONSENT_ARM_MS - 1)
    expect(g.answer(true)).toBeNull()
    c.go(CONSENT_ARM_MS)
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
  test('an early yes starts the wait again: clicking or tapping Enter on and on never gets through', () => {
    const c = clock()
    const g = new ConsentGate(c.now)
    g.shown()
    for (let i = 0; i < 20; i++) {
      c.go(CONSENT_ARM_MS / 2)
      expect(g.answer(true)).toBeNull()
    }
    c.go(CONSENT_ARM_MS)
    expect(g.answer(true)).toBe(true)
  })
  test('Space presses the focused button like Enter (its keydown does not hold the yes back)', () => {
    const c = clock()
    const g = new ConsentGate(c.now)
    g.shown()
    c.go(2000)
    g.key(' ')
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
    expect(ctl).toContain('const yes = remembered || (await this.consent(win, roots, wide ? places : null))')
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

describe('asked once per team and person (owner, 2026-11-15)', () => {
  const now = Date.UTC(2026, 10, 15)
  test('the places as stable words: folders (OneDrive marked), then each place and the recent files for a wide look', () => {
    expect(placeKeys(roots, null)).toEqual(['folder:desktop', 'folder:documents', 'folder:downloads'])
    expect(placeKeys([{ ...roots[0]!, oneDrive: true }], places)).toEqual(['cloud:OneDrive – Acme', 'folder:Acme', 'folder:documents:onedrive', 'messenger:KakaoTalk', 'recent'])
  })
  test('a yes covers the same places or fewer, for 90 days; a new place (Full Disk Access on) asks again', () => {
    const narrow = placeKeys(roots, null)
    const wide = placeKeys(roots, places)
    const yes = { at: now, places: narrow }
    expect(covered(yes, narrow, now + 1000)).toBe(true)
    expect(covered(yes, narrow.slice(0, 2), now)).toBe(true)
    expect(covered(yes, wide, now)).toBe(false)
    expect(covered({ at: now, places: wide }, narrow, now)).toBe(true)
    expect(covered(yes, narrow, now + CONSENT_REMEMBER_MS + 1)).toBe(false)
    expect(covered(yes, narrow, now - 1)).toBe(false)
    expect(covered(undefined, narrow, now)).toBe(false)
  })
  test('per team and person; a broken or old file remembers nothing', () => {
    expect(memoryKey('https://acme.trina.app', 'u-alex')).not.toBe(memoryKey('https://acme.trina.app', 'u-bo'))
    expect(parseMemory('nope', now)).toEqual({})
    expect(parseMemory({ a: { at: 'x', places: [] }, b: { at: now - CONSENT_REMEMBER_MS - 1, places: [] }, c: { at: now, places: ['folder:documents'] } }, now)).toEqual({ c: { at: now, places: ['folder:documents'] } })
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, { at: now - i, places: [] }]))
    expect(Object.keys(parseMemory(many, now))).toHaveLength(50)
  })
  test('without the window, the person\'s own press counts for 2 s', () => {
    expect(PERSON_INPUT_MS).toBe(2000)
  })
})

describe('reads only what the person added, right as they press Add (TC-3300)', () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, '../..', p), 'utf8')
  const ctl = read('desktop/src/main/work-files.ts')
  const win = read('desktop/src/main/app-window.ts')
  const main = read('desktop/src/main/main.ts')
  const preload = read('desktop/src/preload/app.ts')
  test('add: the team page\'s top frame only, ids only; the person\'s press within 2 s, then the session\'s own checks', () => {
    const line = main.split('\n').find((l) => l.includes("'bridge:work-files-add'"))!
    expect(line).toContain('fromApp(e) && e.senderFrame')
    expect(line).toContain('win!.workFiles.add(e.senderFrame.origin,')
    expect(preload).toContain("add: (ids: string[]) => ipcRenderer.invoke('bridge:work-files-add'")
    const add = ctl.slice(ctl.indexOf('  add(origin: string, ids: string[])'), ctl.indexOf('  /** the files added and not read yet'))
    expect(add.indexOf('Date.now() - this.o.lastInput() > PERSON_INPUT_MS')).toBeGreaterThan(-1)
    expect(add.indexOf('Date.now() - this.o.lastInput() > PERSON_INPUT_MS')).toBeLessThan(add.indexOf('this.sessions.allow(origin, ids)'))
    expect(add).toContain('this.sessions.toAdd(origin, ids)')
  })
  test('the person\'s press: Electron\'s key and mouse events on the team page\'s own view (no page script makes them)', () => {
    expect(win).toContain("if (i.type === 'keyDown' && view === this.app) this.appInputAt = Date.now()")
    expect(win).toContain('if (view === this.app) this.appInputAt = Date.now()')
    expect(win).toContain('lastInput: () => this.appInputAt')
    expect(win).not.toMatch(/appInputAt = Date\.now\(\)[^\n]*ipc/)
  })
  test('a remembered yes skips the window only with the person\'s press just now; Not now remembers nothing', () => {
    expect(ctl).toContain('const remembered = !!key && covered(memory[key], keys, Date.now()) && Date.now() - this.o.lastInput() <= PERSON_INPUT_MS')
    expect(ctl).toContain('const yes = remembered || (await this.consent(win, roots, wide ? places : null))')
    expect(ctl).toContain('if (yes && !remembered && key && generation === this.generation)')
  })
  test('the reading strip is the app\'s own (the host strip\'s view), never the page\'s', () => {
    expect(win).toContain('const top = this.hostLine() || this.reading ? HOSTBAR_HEIGHT : 0')
    expect(read('desktop/src/ui/hostbar.ts')).toContain("tr('workFiles.reading', { n: String(reading) })")
  })
})
