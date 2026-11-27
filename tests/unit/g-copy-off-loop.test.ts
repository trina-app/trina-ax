// Big file copies leave the server's event loop (docs/decisions/20261127-restart.md): the bootstrap's watchdog kills a
// server that does not answer /api/health for about 5 minutes, and on ext4 (no file clones) one fs.copyFileSync of a
// 20 GB team file held the event loop that long. Every copy of a file a person or the AI made now goes through
// files/copy-off-loop.ts (Bun's file threads), and a replace keeps its crash safety: the old version is copied first,
// then version row and rename in one synchronous step after a fresh check; a failed rename takes the version back; a
// reader never sees a half file.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { componentC } from '../../server/src/team-files/component'
import { copyOffLoop } from '../../server/src/files/copy-off-loop'
import { writeTemp } from '../../server/src/team-files/place'
import { makeCApp, sha256hex, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)

const ROOT = path.join(import.meta.dir, '..', '..')
const SRC = path.join(ROOT, 'server', 'src')

function serverFiles(dir = SRC): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...serverFiles(p))
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/')
function calls(re: RegExp): Map<string, number> {
  const m = new Map<string, number>()
  for (const f of serverFiles()) {
    const n = (fs.readFileSync(f, 'utf8').match(re) ?? []).length
    if (n) m.set(rel(f), n)
  }
  return m
}

/**
 * The only synchronous copies left in the server, each of a file of a known, small size that no person or AI chose.
 * A new one: copy with copyOffLoop (files/copy-off-loop.ts) instead, or add it here with why it is small.
 */
const SYNC_COPIES_ALLOWED: Record<string, { n: number; why: string }> = {
  'demo/fakes/banner.ts': { n: 1, why: 'a demo kit photo' },
  'tools/make-file.ts': { n: 1, why: 'pictures of a document, at most 20 MB each and 100 MB together' },
  'chat/fork.ts': { n: 2, why: 'thumbnails and the engine session file, inside the fork step' },
  'office/desktop.ts': { n: 1, why: 'an app installer added by the office CLI' },
  'office/update.ts': { n: 4, why: 'latest-*.yml update files (a few KB)' },
  'promo-video/render.ts': { n: 2, why: 'the bundled font and voice clips' },
  'files/hwp-engine.ts': { n: 1, why: 'the HWP worker script' },
  'rooms/files.ts': { n: 1, why: 'the one-time move of the first room-file layout, each at most ROOM_FILE_MAX' },
  'engine/codex.ts': { n: 1, why: "Codex's model catalog" },
  'engine/claude-json-guard.ts': { n: 1, why: "Claude Code's settings file" },
}

test('no synchronous copy of a team, chat, room or upload file: copyFileSync and cpSync only where listed', () => {
  const found = calls(/\b(?:copyFileSync|cpSync)\s*\(/g)
  const extra = [...found].filter(([f, n]) => n > (SYNC_COPIES_ALLOWED[f]?.n ?? 0)).map(([f, n]) => `${f}: ${n}`)
  expect(extra).toEqual([])
  // the team folder's own code never copies synchronously, whatever the list says
  expect([...found.keys()].filter((f) => /^(team-files|uploads)\//.test(f) || f === 'chat/chat-files.ts' || f === 'files/place-output.ts')).toEqual([])
  // a stale entry is removed with the copy it allowed
  expect(Object.keys(SYNC_COPIES_ALLOWED).filter((f) => !found.has(f))).toEqual([])
})

/** sha256Regular reads a whole file synchronously with no limit: only where the size is bounded first. */
const SYNC_HASHES_ALLOWED: Record<string, string> = {
  'files/store.ts': 'its definition',
  'chat/carried-reads.ts': 'readMaxBytes() first',
  'chat/shared-actions.ts': 'HASH_MAX (8 MiB) first',
  'chat/schedule-cover.ts': '64 MiB first',
  'chat/turn.ts': '64 MiB a file first',
  'safe-ops/quarantine.ts': 'only a file of a held artifact\'s exact size (32 MiB or less)',
  'rooms/file-moves.ts': 'a room file: ROOM_FILE_MAX first',
}

test('sha256Regular (a synchronous whole-file hash) only where the size is bounded first', () => {
  const found = [...calls(/\bsha256Regular\s*\(/g).keys()]
  expect(found.filter((f) => !(f in SYNC_HASHES_ALLOWED))).toEqual([])
})

// ---------------- behaviour ----------------

let A: CApp
beforeAll(async () => { A = await makeCApp('g-copy-off-loop') })
afterAll(async () => { await A.close() })

const realCopy = fs.promises.copyFile
/** Hold every copyOffLoop copy until `release()` (later ones are only counted by `onCopy`); `started` resolves when
 * the first one waits. `done()` puts the real copy back. */
function gateCopies(onCopy?: (src: string, dst: string) => void) {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let started!: () => void
  const first = new Promise<void>((r) => { started = r })
  ;(fs.promises as any).copyFile = async (src: string, dst: string, mode?: number) => {
    onCopy?.(String(src), String(dst))
    started()
    await gate
    return realCopy(src, dst, mode)
  }
  return { started: first, release, done: () => { (fs.promises as any).copyFile = realCopy } }
}

const temps = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(PRODUCT.tmpPrefix)) out.push(path.join(d, e.name))
      if (e.isDirectory()) walk(path.join(d, e.name))
    }
  }
  walk(dir)
  return out
}
const versionsOf = (p: string) => A.ctx.db.query("SELECT id, version, sha256, storage_path FROM file_versions WHERE path = ? AND kind <> 'conflict_copy' ORDER BY version").all(p) as { id: string; version: number; sha256: string; storage_path: string }[]
const blobOk = (v: { sha256: string; storage_path: string }) => sha256hex(fs.readFileSync(path.join(A.team, ...v.storage_path.split('/')))) === v.sha256

test('copyOffLoop copies, never over an existing file, and leaves nothing behind when it fails', async () => {
  const dir = path.join(A.data, 'cpl')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'a'), 'bytes of a')
  await copyOffLoop(path.join(dir, 'a'), path.join(dir, 'b'))
  expect(fs.readFileSync(path.join(dir, 'b'), 'utf8')).toBe('bytes of a')
  fs.writeFileSync(path.join(dir, 'c'), 'mine')
  await expect(copyOffLoop(path.join(dir, 'a'), path.join(dir, 'c'))).rejects.toMatchObject({ code: 'EEXIST' })
  expect(fs.readFileSync(path.join(dir, 'c'), 'utf8')).toBe('mine')
  await expect(copyOffLoop(path.join(dir, 'missing'), path.join(dir, 'd'))).rejects.toThrow()
  expect(fs.existsSync(path.join(dir, 'd'))).toBe(false)
})

test('copyOffLoop does not hold the event loop: a real copy (no clone where the disk has none, as ext4 in CI)', async () => {
  const dir = path.join(A.data, 'lag')
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(dir, 'big'), MB = 1024 * 1024
  const fd = fs.openSync(src, 'w')
  const chunk = Buffer.alloc(8 * MB, 7)
  try { for (let i = 0; i < 24; i++) fs.writeSync(fd, chunk) } finally { fs.closeSync(fd) }
  let max = 0, last = performance.now()
  const iv = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n }, 2)
  const t0 = performance.now()
  try { await copyOffLoop(src, path.join(dir, 'copy')) } finally { clearInterval(iv) }
  const took = performance.now() - t0
  expect(fs.statSync(path.join(dir, 'copy')).size).toBe(24 * 8 * MB)
  // a clone (APFS) takes no time and proves nothing; a copy that took long must have let the timer run meanwhile (a
  // synchronous copy gives one gap as long as the copy)
  if (took > 500) expect(max).toBeLessThan(took * 0.6)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a replace upload: the event loop runs while the old version is copied, readers see the old file whole, then the new one', async () => {
  const files = componentC(A.ctx).files
  const p = 'shared/loop.txt', abs = path.join(A.team, p)
  const old = 'old '.repeat(100_000), neu = 'new '.repeat(120_000)
  fs.writeFileSync(abs, old)
  const up = await writeTemp(path.join(A.data, 'up'), new TextEncoder().encode(neu))
  const g = gateCopies()
  const placing = files.placeUpload('alice', 'shared', 'loop.txt', up, 'replace', sha256hex(neu))
  await g.started
  // the copy waits: timers, requests and readers still run (a synchronous copy would hold them all)
  let ticked = false
  await new Promise<void>((r) => setTimeout(() => { ticked = true; r() }, 5))
  expect(ticked).toBe(true)
  expect(fs.readFileSync(abs, 'utf8')).toBe(old)
  expect((await files.content('bob', p)).content).toBe(old)
  g.release()
  try { await placing } finally { g.done() }
  expect(fs.readFileSync(abs, 'utf8')).toBe(neu)
  const v = versionsOf(p)
  expect(v).toHaveLength(1)
  expect(v[0]!.sha256).toBe(sha256hex(old))
  expect(blobOk(v[0]!)).toBe(true)
  expect(temps(A.team)).toEqual([])
})

test('a file changed while its old version was copied: looked at again, every version holds the bytes its row names', async () => {
  const files = componentC(A.ctx).files
  const p = 'shared/changed.txt', abs = path.join(A.team, p)
  const orig = 'original '.repeat(10_000), outside = 'written from outside '.repeat(9_000), neu = 'the upload '.repeat(11_000)
  fs.writeFileSync(abs, orig)
  const up = await writeTemp(path.join(A.data, 'up'), new TextEncoder().encode(neu))
  let wrote = false
  const dsts: string[] = []
  const g = gateCopies((_src, dst) => {
    dsts.push(dst)
    // someone saves the file (a new inode, as an editor does) while the first copy of the old version waits
    if (wrote) return
    wrote = true
    const t = abs + '.outside'
    fs.writeFileSync(t, outside)
    fs.renameSync(t, abs)
  })
  const placing = files.placeUpload('alice', 'shared', 'changed.txt', up, 'replace', sha256hex(neu))
  await g.started
  g.release()
  try { await placing } finally { g.done() }
  expect(fs.readFileSync(abs, 'utf8')).toBe(neu)
  const v = versionsOf(p)
  // the copy taken of the original is dropped (the file changed under it); what was replaced is what was kept
  expect(v.map((x) => x.sha256)).toEqual([sha256hex(outside)])
  for (const x of v) expect(blobOk(x)).toBe(true)
  // the copy that waited was the old version's (in .system/history), after the hash: not the upload's
  expect(dsts[0]!.startsWith(path.join(A.team, PRODUCT.systemDir, 'history') + path.sep)).toBe(true)
  expect(temps(A.team)).toEqual([])
})

test('the rename of the new content fails: no version of a replace that did not happen, the old file stays, the upload goes back', async () => {
  const files = componentC(A.ctx).files
  const p = 'shared/rollback.txt', abs = path.join(A.team, p)
  fs.writeFileSync(abs, 'keep me')
  const up = await writeTemp(path.join(A.data, 'up'), new TextEncoder().encode('never placed'))
  const before = versionsOf(p).length
  const orig = fs.renameSync
  let failed = false
  ;(fs as any).renameSync = (a: fs.PathLike, b: fs.PathLike) => {
    if (!failed && String(b) === abs && String(a).includes(PRODUCT.tmpPrefix)) { failed = true; const e = new Error('EIO') as NodeJS.ErrnoException; e.code = 'EIO'; throw e }
    return orig(a, b)
  }
  try { await expect(files.placeUpload('alice', 'shared', 'rollback.txt', up, 'replace', sha256hex('never placed'))).rejects.toThrow() } finally { (fs as any).renameSync = orig }
  expect(failed).toBe(true)
  expect(fs.readFileSync(abs, 'utf8')).toBe('keep me')
  expect(versionsOf(p).length).toBe(before)
  // the upload was renamed next to the file; it is back where it came from (it may be the only copy of the bytes)
  expect(fs.readFileSync(up, 'utf8')).toBe('never placed')
  expect(temps(A.team)).toEqual([])
})

test('a copy onto a file that changed since the caller saw it: the conflict copy is the staged copy, no version, no temp left', async () => {
  const files = componentC(A.ctx).files
  fs.writeFileSync(path.join(A.team, 'shared', 'from.txt'), 'the source')
  fs.writeFileSync(path.join(A.team, 'shared', 'to.txt'), 'theirs now')
  const r = await files.copy('alice', 'shared/from.txt', 'shared/to.txt', { onExists: 'replace', baseSha256: sha256hex('what alice saw') })
  expect('path' in r && r.path).not.toBe('shared/to.txt')
  expect(fs.readFileSync(path.join(A.team, 'shared', 'to.txt'), 'utf8')).toBe('theirs now')
  expect('path' in r && fs.readFileSync(path.join(A.team, ...r.path.split('/')), 'utf8')).toBe('the source')
  expect(versionsOf('shared/to.txt')).toEqual([])
  expect(temps(A.team)).toEqual([])
})

test('restoring a version: copied off the event loop, kept as a version, and nothing is copied when the file already holds it', async () => {
  const files = componentC(A.ctx).files
  const p = 'shared/restore.txt', abs = path.join(A.team, p)
  fs.writeFileSync(abs, 'first')
  const up = await writeTemp(path.join(A.data, 'up'), new TextEncoder().encode('second'))
  await files.placeUpload('alice', 'shared', 'restore.txt', up, 'replace', sha256hex('second'))
  const first = versionsOf(p)[0]!
  let copies = 0
  const g = gateCopies(() => { copies++ })
  const restoring = files.restoreVersion('alice', p, first.id)
  await g.started
  expect(fs.readFileSync(abs, 'utf8')).toBe('second')
  g.release()
  try { await restoring } finally { g.done() }
  expect(fs.readFileSync(abs, 'utf8')).toBe('first')
  expect(copies).toBe(2) // the version's bytes next to the file, and the replaced file's bytes for its version
  expect(versionsOf(p).map((v) => v.sha256)).toEqual([sha256hex('first'), sha256hex('second')])
  for (const v of versionsOf(p)) expect(blobOk(v)).toBe(true)
  // the same version again: the file holds it already, nothing is copied
  copies = 0
  ;(fs.promises as any).copyFile = async (a: string, b: string, m?: number) => { copies++; return realCopy(a, b, m) }
  try { await files.restoreVersion('alice', p, first.id) } finally { (fs.promises as any).copyFile = realCopy }
  expect(copies).toBe(0)
  expect(versionsOf(p)).toHaveLength(2)
  expect(temps(A.team)).toEqual([])
})
