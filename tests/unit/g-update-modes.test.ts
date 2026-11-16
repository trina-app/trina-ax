// An app-only update (the server stages the release itself, as the server account, with umask 027) must leave the
// version folder readable by the launcher and the engine sandbox, which run as another account and bind
// app/current/native/mycel-bridge. 0.5.7 came out 0750 with files 0640/0750 on potenlab and every AI turn failed;
// start-up heals folders an older version staged like that.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { silentLogger } from '../../server/src/log'
import { packBundle, writeManifest } from '../../server/src/system/bundle'
import { repairVersionModes, setVersionModes, UpdateManager } from '../../server/src/system/update'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-update-modes')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })

const oldUmask = process.umask()
afterEach(() => { process.umask(oldUmask) })

/** a small version folder: two executables (bin/bun, native/mycel-bridge), plain files, nested folders */
async function versionDir(dir: string, v: string, modes: { dir: number; file: number; exe: number }) {
  for (const d of ['bin', 'native', 'server/src', 'web/assets']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'bin', 'bun'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(dir, 'native', 'mycel-bridge'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(dir, 'server', 'src', 'main.js'), '//\n')
  fs.writeFileSync(path.join(dir, 'web', 'assets', 'a.js'), '//\n')
  await writeManifest(dir, v)
  const walk = (p: string) => {
    for (const d of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, d.name)
      if (d.isDirectory()) { walk(q); fs.chmodSync(q, modes.dir) } else fs.chmodSync(q, /bun$|mycel-bridge$/.test(q) ? modes.exe : modes.file)
    }
  }
  walk(dir)
  fs.chmodSync(dir, modes.dir)
}

/** every entry under root (root itself as ".") with its permission bits */
function modes(root: string): Record<string, number> {
  const out: Record<string, number> = { '.': fs.lstatSync(root).mode & 0o7777 }
  const walk = (p: string) => {
    for (const d of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, d.name)
      out[path.relative(root, q)] = fs.lstatSync(q).mode & 0o7777
      if (d.isDirectory()) walk(q)
    }
  }
  walk(root)
  return out
}

function expectSharedModes(root: string) {
  const got = modes(root)
  expect(Object.keys(got).length).toBeGreaterThan(10)
  for (const [rel, m] of Object.entries(got)) {
    const st = fs.lstatSync(path.join(root, rel))
    const want = st.isDirectory() ? 0o755 : /^(bin\/bun|native\/mycel-bridge)$/.test(rel) ? 0o755 : 0o644
    expect([rel, m.toString(8)]).toEqual([rel, want.toString(8)])
    expect(m & 0o004).toBe(0o004) // others read (and enter, for folders: 0o001 below)
    if (st.isDirectory()) expect(m & 0o001).toBe(0o001)
  }
  expect(fs.statSync(path.join(root, 'native', 'mycel-bridge')).mode & 0o001).toBe(0o001)
}

async function stageWith(name: string, archiveModes: { dir: number; file: number; exe: number }, umask: number) {
  const base = path.join(W, name)
  const src = path.join(base, 'build', '2.0.0')
  await versionDir(src, '2.0.0', archiveModes)
  const archive = path.join(base, 'b.tar.zst')
  await packBundle(src, archive)
  const app = path.join(base, 'app')
  fs.mkdirSync(path.join(app, 'versions', '1.0.0'), { recursive: true })
  fs.symlinkSync('versions/1.0.0', path.join(app, 'current'))
  const u = new UpdateManager({ appDir: app, dataDir: path.join(base, 'data'), version: '1.0.0', channel: 'stable', feedUrl: null, log: silentLogger })
  process.umask(umask)
  await u.stage(archive)
  process.umask(oldUmask)
  return { u, dest: path.join(app, 'versions', '2.0.0'), archive }
}

describe('version folder modes', () => {
  test('stage under the server umask 027, release archive 0644/0755: the whole tree is o+rX', async () => {
    const { dest } = await stageWith('umask027', { dir: 0o755, file: 0o644, exe: 0o755 }, 0o027)
    expectSharedModes(dest)
  })

  test('stage under umask 077 of an archive that itself carries 0640 files, 0750 programs and folders', async () => {
    const { dest } = await stageWith('restrictive-archive', { dir: 0o750, file: 0o640, exe: 0o750 }, 0o077)
    expectSharedModes(dest)
  })

  test('staging a version that is already there (staged by older code) repairs its modes', async () => {
    const { u, dest, archive } = await stageWith('again', { dir: 0o755, file: 0o644, exe: 0o755 }, 0o027)
    fs.chmodSync(dest, 0o750)
    fs.chmodSync(path.join(dest, 'native', 'mycel-bridge'), 0o750)
    fs.chmodSync(path.join(dest, 'server', 'src', 'main.js'), 0o640)
    await u.stage(archive)
    expectSharedModes(dest)
  })

  test('start-up repair heals a 0750/0640 version tree, leaves staging folders and links alone, then changes nothing', async () => {
    const app = path.join(W, 'repair', 'app')
    const broken = path.join(app, 'versions', '0.5.7')
    await versionDir(broken, '0.5.7', { dir: 0o755, file: 0o644, exe: 0o755 })
    // as the 0.5.7 updater left it: the version folder 0750, the unpacked files 0640/0750, subfolders 0755
    const walk = (p: string) => {
      for (const d of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, d.name)
        if (d.isDirectory()) walk(q); else fs.chmodSync(q, /bun$|mycel-bridge$/.test(q) ? 0o750 : 0o640)
      }
    }
    walk(broken)
    fs.chmodSync(broken, 0o750)
    fs.chmodSync(path.join(broken, 'web'), 0o700)
    const other = path.join(app, 'versions', '0.5.5') // the version kept for Go back
    await versionDir(other, '0.5.5', { dir: 0o750, file: 0o640, exe: 0o750 })
    const staging = path.join(app, 'versions', '.staging-abc')
    fs.mkdirSync(staging, { mode: 0o700 })
    fs.chmodSync(staging, 0o700)
    const outside = path.join(W, 'repair', 'outside.txt')
    fs.writeFileSync(outside, 'x', { mode: 0o600 })
    fs.chmodSync(outside, 0o600)
    fs.symlinkSync(outside, path.join(app, 'versions', '0.0.1'))
    fs.symlinkSync('versions/0.5.7', path.join(app, 'current'))

    const warned: string[] = []
    const log = { ...silentLogger, warn: (m: string) => { warned.push(m) } }
    expect(repairVersionModes(app, log)).toBeGreaterThan(0)
    expect(warned).toContain('version folder modes repaired')
    expectSharedModes(broken)
    expectSharedModes(other)
    expect(fs.statSync(staging).mode & 0o777).toBe(0o700)
    expect(fs.statSync(outside).mode & 0o777).toBe(0o600) // a link is never followed
    expect(repairVersionModes(app, silentLogger)).toBe(0) // healthy: nothing to change
    // an office/dev server without app/ has nothing to repair
    expect(repairVersionModes(null, silentLogger)).toBe(0)
    expect(repairVersionModes(path.join(W, 'repair', 'none'), silentLogger)).toBe(0)
  })

  test('setVersionModes never follows a link inside the tree', async () => {
    const root = path.join(W, 'links', 'v')
    fs.mkdirSync(root, { recursive: true })
    const target = path.join(W, 'links', 'secret')
    fs.writeFileSync(target, 'x')
    fs.chmodSync(target, 0o600)
    fs.symlinkSync(target, path.join(root, 'l'))
    fs.chmodSync(root, 0o700)
    expect(setVersionModes(root)).toBe(1)
    expect(fs.statSync(root).mode & 0o777).toBe(0o755)
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
  })

  test('start-up repairs before migrations and before the server listens (the health check must not pass a broken tree)', () => {
    // a 0.5.7 server stages the next version with its old code, so that version starts with a broken tree: the repair
    // has to be done before /api/health can answer and before any turn, i.e. synchronously at the top of start()
    const src = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'server', 'src', 'main.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function start('))
    const repair = body.indexOf("if (process.platform === 'linux') repairVersionModes(resolveLayout(cfg).appDir, log)")
    expect(repair).toBeGreaterThan(0)
    for (const later of ['await migrateBeforeStart(', 'openDb(', 'buildApp(', 'Bun.serve(']) {
      expect([later, body.indexOf(later) > repair]).toEqual([later, true])
    }
    // synchronous: nothing to await, so nothing can run before it finishes
    expect(repairVersionModes(null, silentLogger)).toBe(0)
  })
})
