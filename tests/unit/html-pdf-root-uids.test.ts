// trustedBrowser's idea of root inside the free-roam demo's per-instance bwrap (demo-gate/linux): a user namespace that
// does not map root, where root's files show as the kernel's overflow uid. Only with MYCEL_SANDBOX_ROOT_UNMAPPED=1 and
// only when "/" itself shows as that uid.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rootOwnerUids, trustedBrowser } from '../../server/src/files/html-pdf'

const overflow = (v = '65534\n') => (p: string) => {
  if (p === '/proc/sys/kernel/overflowuid') return v
  throw new Error('unexpected ' + p)
}
const ON = { MYCEL_SANDBOX_ROOT_UNMAPPED: '1' }

describe('rootOwnerUids', () => {
  test('without the variable: root only, nothing looked at', () => {
    const no = () => { throw new Error('looked') }
    expect(rootOwnerUids({}, no, no)).toEqual([0])
    expect(rootOwnerUids({ MYCEL_SANDBOX_ROOT_UNMAPPED: 'yes' }, no, no)).toEqual([0])
  })
  test('with it, where "/" shows as the overflow uid (a namespace that does not map root): root and that uid', () => {
    expect(rootOwnerUids(ON, overflow(), () => 65534)).toEqual([0, 65534])
    expect(rootOwnerUids(ON, overflow('65000\n'), () => 65000)).toEqual([0, 65000])
  })
  test('with it, where "/" is owned by root (the host, a namespace that maps root): root only', () => {
    expect(rootOwnerUids(ON, overflow(), () => 0)).toEqual([0])
    expect(rootOwnerUids(ON, overflow(), () => 1000)).toEqual([0])
  })
  test('unreadable or odd values: root only', () => {
    expect(rootOwnerUids(ON, () => { throw new Error('no proc') }, () => 65534)).toEqual([0])
    expect(rootOwnerUids(ON, overflow('x\n'), () => 65534)).toEqual([0])
    expect(rootOwnerUids(ON, overflow('0\n'), () => 0)).toEqual([0])
    expect(rootOwnerUids(ON, overflow(), () => { throw new Error('stat') })).toEqual([0])
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
