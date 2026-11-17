// The desktop app saved a download straight into Downloads (lib/desktopDownloads.ts, QA TC-4638): the page's usual
// notice says so with one action that names the download by its number; a failed one says so; a browser, the Mac App
// Store build and an older desktop app (no bridge.downloads) get nothing.
import { beforeEach, expect, test } from 'bun:test'
import type { DesktopBridge, DesktopDownloadDone } from '@mycel/shared'
import { initDesktopDownloads } from '../../src/lib/desktopDownloads'
import { useUi } from '../../src/store/ui'
import { translate } from '../../src/i18n'

beforeEach(() => useUi.setState({ toasts: [] }))

function fakeBridge() {
  let cb: ((d: DesktopDownloadDone) => void) | null = null
  const shown: number[] = []
  const bridge = { bridgeVersion: 1, downloads: { onDone: (f: (d: DesktopDownloadDone) => void) => { cb = f; return () => { cb = null } }, show: (id: number) => { shown.push(id) } } } as unknown as DesktopBridge
  return { bridge, shown, done: (d: DesktopDownloadDone) => cb?.(d), listening: () => cb !== null }
}

test('a saved download: "Saved to Downloads", the name, and Show in folder by its number', () => {
  const f = fakeBridge()
  const off = initDesktopDownloads(f.bridge)
  expect(f.listening()).toBe(true)
  f.done({ id: 7, name: 'report (1).pdf', ok: true })
  const [toast] = useUi.getState().toasts
  expect(toast!.text).toBe(translate('en', 'desktopDownload.saved'))
  expect(toast!.detail).toBe('report (1).pdf')
  expect(toast!.level).toBe('info')
  expect(toast!.action!.label).toBe(translate('en', 'desktopDownload.show'))
  toast!.action!.run()
  expect(f.shown).toEqual([7])
  off()
  expect(f.listening()).toBe(false)
})

test('a failed download says so, with the name and no action', () => {
  const f = fakeBridge()
  initDesktopDownloads(f.bridge)
  f.done({ id: 8, name: 'big.zip', ok: false })
  const [toast] = useUi.getState().toasts
  expect(toast!.level).toBe('error')
  expect(toast!.text).toBe(translate('en', 'desktopDownload.failed', { name: 'big.zip' }))
  expect(toast!.action).toBeUndefined()
})

test('no bridge, or one without downloads: nothing listens', () => {
  initDesktopDownloads(null)()
  initDesktopDownloads({ bridgeVersion: 1 } as unknown as DesktopBridge)()
  expect(useUi.getState().toasts).toEqual([])
})
