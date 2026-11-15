// A stand-in for the desktop app's workFiles (shared/src/desktop-bridge.ts) for the web e2e: it answers like the real main
// process (desktop/src/main/work-files.ts). scan() waits for "the app's own dialog" (answer() says look or cancel), then
// gives the list set with look(), with an id per file; read() gives bytes only for ids of its latest look and logs each
// read; openSettings() is counted. Used by find-work-files.spec.ts and shots-find-work-files.spec.ts.
import type { Page } from '@playwright/test'

export type Meta = { name: string; root?: 'documents' | 'desktop' | 'downloads'; folder?: string; size?: number }
export type Root = { id: 'documents' | 'desktop' | 'downloads'; state: string; cut?: boolean; tooBig?: number; oneDrive?: boolean }

/** Installed before the app's scripts: a desktop bridge whose workFiles answers like the app's main process. */
export async function fakeApp(page: Page, o: { version?: number; refuse?: string[]; pick?: boolean } = {}) {
  await page.addInitScript((opts) => {
    type D = { picks: number; pickFiles: unknown[]; answer: 'look' | 'cancel' | null; scans: number; reads: string[]; files: { id: string; name: string; root: string; folder: string; ext: string; size: number; modified: number }[]; roots: unknown[]; settings: number; latest: Set<string> }
    const w = window as unknown as { mycelDesktop: unknown; __app: D; __look: (files: unknown[], roots: unknown[]) => void }
    const d: D = { picks: 0, pickFiles: [], answer: null, scans: 0, reads: [], files: [], roots: [], settings: 0, latest: new Set() }
    w.__app = d
    w.__look = (files, roots) => { d.files = files as D['files']; d.roots = roots }
    ;(w as unknown as { __pick: (f: unknown[]) => void }).__pick = (f) => { d.pickFiles = f }
    const noop = () => {}
    const progress: ((p: unknown) => void)[] = []
    w.mycelDesktop = {
      bridgeVersion: 1,
      appVersion: '0.5.6',
      platform: 'darwin',
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
      notify: noop,
      openTeams: noop,
      workFiles: {
        version: opts.version ?? 1,
        scan: async () => {
          d.scans++
          // the app's own dialog is up until the test answers it
          while (!d.answer) await new Promise((r) => setTimeout(r, 50))
          const a = d.answer
          d.answer = null
          if (a === 'cancel') return { state: 'cancelled' }
          for (const f of progress) f({ root: 'documents', checked: 1240, docs: 12 })
          await new Promise((r) => setTimeout(r, 400))
          d.latest = new Set(d.files.map((f) => f.id))
          return { state: 'done', stopped: false, roots: d.roots, files: d.files }
        },
        stop: noop,
        onProgress: (cb: (p: unknown) => void) => { progress.push(cb); return noop },
        read: async (id: string) => {
          d.reads.push(id)
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
      },
    }
  }, o)
}
export const files = (list: Meta[]) => list.map((m, i) => ({ id: `id${i}`, name: m.name, root: m.root ?? 'documents', folder: m.folder ?? '', ext: m.name.split('.').pop()!, size: m.size ?? 40, modified: Date.parse('2026-11-03T12:00:00Z') }))
export const roots = (...rs: Root[]) => rs.map((r) => ({ cut: false, tooBig: 0, checked: 100, oneDrive: false, ...r }))
export const OK3 = roots({ id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok' }, { id: 'downloads', state: 'ok' })
export const look = (page: Page, f: Meta[], r = OK3) => page.evaluate(([a, b]) => (window as unknown as { __look: (f: unknown[], r: unknown[]) => void }).__look(a as unknown[], b as unknown[]), [files(f), r] as const)
export const answer = (page: Page, a: 'look' | 'cancel') => page.evaluate((x) => { (window as unknown as { __app: { answer: string } }).__app.answer = x }, a)
export const app = (page: Page) => page.evaluate(() => { const d = (window as unknown as { __app: { scans: number; reads: string[]; settings: number; picks: number } }).__app; return { scans: d.scans, reads: [...d.reads], settings: d.settings, picks: d.picks } })
export const pickHolds = (page: Page, f: Meta[], first = 100) => page.evaluate((x) => (window as unknown as { __pick: (f: unknown[]) => void }).__pick(x), files(f).map((x, i) => ({ ...x, id: `p${first + i}` })))
