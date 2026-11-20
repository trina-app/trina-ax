// A stand-in for the desktop app's workFiles (shared/src/desktop-bridge.ts) for the web e2e: it answers like the real main
// process (desktop/src/main/work-files.ts). scan() waits for "the app's own dialog" (answer() says look or cancel), then
// gives the list set with look(), with an id per file; read() gives bytes only for ids of its latest look and logs each
// read; openSettings() is counted. Part 5: `wide` offers the wide look (scan logs what it was asked), and `fullDisk`
// (a Mac) answers Full Disk Access as the test sets it (setFullDisk), counting Open Settings and Reopen. Version 2
// (the default, TC-3300): add(ids) records what the page named at Add, and read() gives only those. `refuse` ids read as
// changed since the look, `missing` ids as deleted since it (TC-219). Used by
// find-work-files.spec.ts and shots-find-work-files.spec.ts.
import { expect, type Page } from '@playwright/test'

export type Meta = { name: string; root?: 'documents' | 'desktop' | 'downloads' | 'cloud' | 'folder' | 'messenger' | 'home' | 'drive'; place?: string; cloud?: boolean; folder?: string; size?: number; modified?: number }
export type Root = { id: 'documents' | 'desktop' | 'downloads' | 'cloud' | 'folder' | 'messenger' | 'home' | 'drive'; place?: string; state: string; cut?: boolean; tooBig?: number; oneDrive?: boolean }

/** Installed before the app's scripts: a desktop bridge whose workFiles answers like the app's main process. */
export async function fakeApp(page: Page, o: { version?: number; refuse?: string[]; missing?: string[]; pick?: boolean; pickFolder?: string; wide?: boolean; fullDisk?: 'granted' | 'denied'; platform?: 'darwin' | 'win32' } = {}) {
  await page.addInitScript((opts) => {
    type D = { picks: number; pickFiles: unknown[]; answer: 'look' | 'cancel' | null; scans: number; asks: unknown[]; reads: string[]; adds: string[][]; added: Set<string>; files: { id: string; name: string; root: string; folder: string; ext: string; size: number; modified: number }[]; roots: unknown[]; settings: number; latest: Set<string>; fullDisk: string; fdSettings: number; fdRelaunch: number; fdChecks: number }
    const w = window as unknown as { mycelDesktop: unknown; __app: D; __look: (files: unknown[], roots: unknown[]) => void }
    const d: D = { picks: 0, pickFiles: [], answer: null, scans: 0, asks: [], reads: [], adds: [], added: new Set(), files: [], roots: [], settings: 0, latest: new Set(), fullDisk: opts.fullDisk ?? 'denied', fdSettings: 0, fdRelaunch: 0, fdChecks: 0 }
    w.__app = d
    w.__look = (files, roots) => { d.files = files as D['files']; d.roots = roots }
    ;(w as unknown as { __pick: (f: unknown[]) => void }).__pick = (f) => { d.pickFiles = f }
    const noop = () => {}
    const progress: ((p: unknown) => void)[] = []
    w.mycelDesktop = {
      bridgeVersion: 1,
      appVersion: '0.5.6',
      platform: opts.platform ?? 'darwin',
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
      notify: noop,
      openTeams: noop,
      workFiles: {
        version: opts.version ?? 2,
        ...(opts.wide ? { wide: 1 } : {}),
        ...(opts.wide && opts.fullDisk ? { fullDisk: {
          state: async () => { d.fdChecks++; return d.fullDisk },
          openSettings: () => { d.fdSettings++ },
          relaunch: () => { d.fdRelaunch++ },
        } } : {}),
        scan: async (ask?: unknown) => {
          d.scans++
          d.asks.push(ask ?? null)
          // the app's own dialog is up until the test answers it
          while (!d.answer) await new Promise((r) => setTimeout(r, 50))
          const a = d.answer
          d.answer = null
          if (a === 'cancel') return { state: 'cancelled' }
          for (const f of progress) f({ root: 'documents', checked: 1240, docs: 12 })
          await new Promise((r) => setTimeout(r, 400))
          d.latest = new Set(d.files.map((f) => f.id))
          d.added = new Set()
          return { state: 'done', stopped: false, roots: d.roots, files: d.files }
        },
        stop: noop,
        onProgress: (cb: (p: unknown) => void) => { progress.push(cb); return noop },
        ...((opts.version ?? 2) >= 2 ? { add: async (ids: string[]) => {
          d.adds.push([...ids])
          if (!ids.every((id) => d.latest.has(id))) return { state: 'refused' }
          for (const id of ids) d.added.add(id)
          return { state: 'added' }
        } } : {}),
        read: async (id: string) => {
          d.reads.push(id)
          // version 2: only what the page named at Add (the app refuses every other id)
          if ((opts.version ?? 2) >= 2 && !d.added.has(id)) return { ok: false, reason: 'unknown' }
          // refuse: changed on disk since the look; missing: deleted since the look (TC-219)
          if (d.latest.has(id) && (opts.missing ?? []).includes(id)) return { ok: false, reason: 'missing' }
          if (!d.latest.has(id) || (opts.refuse ?? []).includes(id)) return { ok: false, reason: d.latest.has(id) ? 'changed' : 'unknown' }
          const f = d.files.find((x) => x.id === id)!
          return { ok: true, bytes: new TextEncoder().encode(`content of ${f.name}`.padEnd(f.size, '.')) }
        },
        openSettings: () => { d.settings++ },
        // "Choose it yourself": the system's folder window, picked (the test sets what it holds)
        ...(opts.pick ? { pickRoot: async (id: string) => {
          d.picks++
          for (const f of d.pickFiles as { id: string }[]) d.latest.add(f.id)
          d.files = [...d.files, ...(d.pickFiles as D['files'])]
          return { state: 'done', stopped: false, roots: [{ id, state: 'ok', oneDrive: false, cut: false, tooBig: 0, checked: 1, how: 'index' }], files: d.pickFiles }
        } } : {}),
        // "Choose a folder…" (MAN-057): any folder, picked in the system's window; the test sets what it holds and its name
        ...(opts.pickFolder ? { pickFolder: async () => {
          d.picks++
          for (const f of d.pickFiles as { id: string }[]) d.latest.add(f.id)
          d.files = [...d.files, ...(d.pickFiles as D['files'])]
          const first = (d.pickFiles as { root?: string; place?: string }[])[0]
          return { state: 'done', stopped: false, roots: [{ id: first?.root ?? 'folder', place: opts.pickFolder, state: 'ok', oneDrive: false, cut: false, tooBig: 0, checked: d.pickFiles.length, how: 'walk' }], files: d.pickFiles }
        } } : {}),
      },
    }
  }, o)
}
export const files = (list: Meta[]) => list.map((m, i) => ({ id: `id${i}`, name: m.name, root: m.root ?? 'documents', ...(m.place !== undefined ? { place: m.place } : {}), ...(m.cloud ? { cloud: true } : {}), folder: m.folder ?? '', ext: m.name.split('.').pop()!, size: m.size ?? 40_000, modified: m.modified ?? Date.parse('2026-11-03T12:00:00Z') }))
export const roots = (...rs: Root[]) => rs.map((r) => ({ cut: false, tooBig: 0, checked: 100, oneDrive: false, ...r }))
export const OK3 = roots({ id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok' }, { id: 'downloads', state: 'ok' })
export const look = (page: Page, f: Meta[], r = OK3) => page.evaluate(([a, b]) => (window as unknown as { __look: (f: unknown[], r: unknown[]) => void }).__look(a as unknown[], b as unknown[]), [files(f), r] as const)
export const answer = (page: Page, a: 'look' | 'cancel') => page.evaluate((x) => { (window as unknown as { __app: { answer: string } }).__app.answer = x }, a)
export const app = (page: Page) => page.evaluate(() => { const d = (window as unknown as { __app: { scans: number; asks: unknown[]; reads: string[]; adds: string[][]; settings: number; picks: number; fdSettings: number; fdRelaunch: number; fdChecks: number } }).__app; return { scans: d.scans, asks: [...d.asks], reads: [...d.reads], adds: d.adds.map((a) => [...a]), settings: d.settings, picks: d.picks, fdSettings: d.fdSettings, fdRelaunch: d.fdRelaunch, fdChecks: d.fdChecks } })
/** Full Disk Access as the app will answer next (the person turned it on in Settings, or not). */
export const setFullDisk = (page: Page, v: 'granted' | 'denied') => page.evaluate((x) => { (window as unknown as { __app: { fullDisk: string } }).__app.fullDisk = x }, v)
export const pickHolds = (page: Page, f: Meta[], first = 100) => page.evaluate((x) => (window as unknown as { __pick: (f: unknown[]) => void }).__pick(x), files(f).map((x, i) => ({ ...x, id: `p${first + i}` })))

/** After an add the share step comes first (ShareFoundFiles.tsx): Not now, to the run's result (Undo, Open, Close). */
export async function notNow(page: Page) {
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'share', { timeout: 15_000 })
  await page.getByTestId('find-work-share-skip').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'result')
}
