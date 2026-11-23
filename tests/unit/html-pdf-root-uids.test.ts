// trustedBrowser's idea of root inside the free-roam demo's per-instance bwrap (demo-gate/linux): a user namespace that
// does not map root, where root's files show as the kernel's overflow uid. Only for the explicit MYCEL_HTML_PDF_BROWSER
// inside the folder MYCEL_SANDBOX_ROOT_UNMAPPED names, and only when "/" itself shows as that uid.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rootOwnerUids, trustedBrowser } from '../../server/src/files/html-pdf'

const overflow = (v = '65534\n') => (p: string) => {
  if (p === '/proc/sys/kernel/overflowuid') return v
  throw new Error('unexpected ' + p)
}
const BIN = '/opt/trina-demo/chrome-headless-shell/157/chrome-headless-shell-linux64/chrome-headless-shell'
const ON = { MYCEL_SANDBOX_ROOT_UNMAPPED: '/opt/trina-demo', MYCEL_HTML_PDF_BROWSER: '/opt/trina-demo/chrome-headless-shell/current/chrome-headless-shell' }
// the "current" link resolves to the versioned folder; everything else is its own real path
const real = (p: string) => p.replace('/current/', '/157/chrome-headless-shell-linux64/')
const uids = (bin: string, env: Record<string, string>, o: { ov?: string; rootOwner?: number } = {}) =>
  rootOwnerUids(bin, env, overflow(o.ov), () => o.rootOwner ?? 65534, real)

describe('rootOwnerUids', () => {
  test('the explicit browser inside the operator\'s folder, "/" seen as the overflow uid: root and that uid', () => {
    expect(uids(BIN, ON)).toEqual([0, 65534])
    expect(uids(ON.MYCEL_HTML_PDF_BROWSER, ON)).toEqual([0, 65534])
    expect(uids(BIN, { ...ON, MYCEL_SANDBOX_ROOT_UNMAPPED: '/opt/trina-demo/' })).toEqual([0, 65534])
    expect(uids(BIN, ON, { ov: '65000\n', rootOwner: 65000 })).toEqual([0, 65000])
  })
  test('never for a browser of the fallback list, nor one other than the explicit one', () => {
    for (const other of ['/opt/trina/chrome-headless-shell/current/chrome-headless-shell', '/usr/lib/chromium/chromium-headless-shell', '/home/x/.cache/hyperframes/chrome/chrome-headless-shell/linux64/chrome-headless-shell', '/opt/trina-demo/bin/bun']) {
      expect(uids(other, ON)).toEqual([0])
    }
    const { MYCEL_HTML_PDF_BROWSER: _, ...noExplicit } = ON
    expect(uids(BIN, noExplicit)).toEqual([0])
    expect(uids(BIN, { ...ON, MYCEL_HTML_PDF_BROWSER: 'none' })).toEqual([0])
  })
  test('the explicit browser outside the operator\'s folder, or a folder that is not a plain absolute path: root only', () => {
    expect(uids('/usr/lib/chromium/chromium', { ...ON, MYCEL_HTML_PDF_BROWSER: '/usr/lib/chromium/chromium' })).toEqual([0])
    expect(uids('/opt/trina-demo-evil/chrome', { ...ON, MYCEL_HTML_PDF_BROWSER: '/opt/trina-demo-evil/chrome' })).toEqual([0])
    for (const dir of ['1', 'opt/trina-demo', '/opt/x/../trina-demo', '/', '']) expect(uids(BIN, { ...ON, MYCEL_SANDBOX_ROOT_UNMAPPED: dir })).toEqual([0])
    expect(uids(BIN, { MYCEL_HTML_PDF_BROWSER: ON.MYCEL_HTML_PDF_BROWSER })).toEqual([0])
  })
  test('"/" seen as owned by root or another uid, or odd values: root only', () => {
    expect(uids(BIN, ON, { rootOwner: 0 })).toEqual([0])
    expect(uids(BIN, ON, { rootOwner: 1000 })).toEqual([0])
    expect(uids(BIN, ON, { ov: 'x\n' })).toEqual([0])
    expect(rootOwnerUids(BIN, ON, () => { throw new Error('no proc') }, () => 65534, real)).toEqual([0])
    expect(rootOwnerUids(BIN, ON, overflow(), () => { throw new Error('stat') }, real)).toEqual([0])
    expect(rootOwnerUids(BIN, ON, overflow(), () => 65534, () => { throw new Error('missing') })).toEqual([0])
  })
})

describe('trustedBrowser with the given root uids', () => {
  test('a folder owned by a uid that is neither root nor the server: trusted only when that uid stands for root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'))
    const home = path.join(dir, 'chrome'); fs.mkdirSync(home, { mode: 0o755 })
    const bin = path.join(home, 'chrome-headless-shell'); fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    fs.chmodSync(dir, 0o755)
    try {
      const me = process.getuid!()
      // stand-in: the files are ours; told our uid is not the server's, they count only when ours stands for root
      expect(trustedBrowser(bin, me, [0])).toBe(true)
      expect(trustedBrowser(bin, -1, [0])).toBe(false)
      const rootsWithMe = [0, me]
      // the temp folders above ours belong to root or to us (or are sticky): with us as "root" it is trusted
      expect(trustedBrowser(bin, -1, rootsWithMe)).toBe(true)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
