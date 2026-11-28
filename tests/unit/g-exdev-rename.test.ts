// A rename between the data folder and the team folder may fail with EXDEV even when both report one st_dev: the
// server unit's ReadWritePaths (systemd) bind-mounts each folder onto itself, and Linux refuses a rename between two
// mounts of one file system. Windows QA 2026-11-28 (WSL2 Debian 13, 0.20.4): every AI file save failed with EXDEV;
// reproduced on a native Debian 13 server in the service's mount namespace. onTeamVolume (team-files/place.ts) took
// one st_dev for one volume and never copied.
//
// Here the data and the team folder are on one disk, with one st_dev, and fs.renameSync refuses every rename from one
// to the other with EXDEV, as the kernel does there. Every move from the data folder into the team folder must still
// work: a copy off the event loop, flushed, then the source goes.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { makeCApp, sha256hex, type CApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'
import { installRenamed, onTeamVolume, stageInstall, commitStaged, writeTemp } from '../../server/src/team-files/place'
import { moveOffLoop, renameOrCopy } from '../../server/src/files/copy-off-loop'
import { placeProduced } from '../../server/src/tools/make-file'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'

setDefaultTimeout(60_000)

let A: CApp
let dataRoots: string[] = []
let teamRoots: string[] = []
beforeAll(async () => {
  A = await makeCApp('g-exdev-rename')
  dataRoots = [A.data, fs.realpathSync(A.data)]
  teamRoots = [A.team, fs.realpathSync(A.team)]
})
afterAll(async () => { await A.close() })

const under = (roots: string[], p: string) => roots.some((r) => p === r || p.startsWith(r + path.sep))
const realRename = fs.renameSync
let crossings = 0
/** Two mounts of one disk: a rename between the data and the team folder fails with EXDEV, inside either one works. */
function twoMounts() {
  crossings = 0
  ;(fs as any).renameSync = (a: fs.PathLike, b: fs.PathLike) => {
    const x = path.resolve(String(a)), y = path.resolve(String(b))
    if (under(dataRoots, x) !== under(dataRoots, y) || under(teamRoots, x) !== under(teamRoots, y)) {
      crossings++
      throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${x}' -> '${y}'`), { code: 'EXDEV', errno: -18, syscall: 'rename' })
    }
    return realRename(a, b)
  }
}
afterEach(() => { (fs as any).renameSync = realRename })

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
const produced = (bytes: string) => {
  const dir = path.join(A.data, 'work', `made-${crypto.randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'out.docx')
  fs.writeFileSync(p, bytes)
  return p
}

test('the simulation: one st_dev for both folders, and a rename between them is refused', () => {
  expect(fs.lstatSync(A.data).dev).toBe(fs.lstatSync(A.team).dev)
  twoMounts()
  const p = produced('x')
  expect(() => fs.renameSync(p, path.join(A.team, 'x'))).toThrow(expect.objectContaining({ code: 'EXDEV' }))
  expect(fs.existsSync(p)).toBe(true)
})

test('renameOrCopy: a rename where it works; on EXDEV a whole, flushed copy and the source kept; never through a link', async () => {
  const a = produced('same mount'), b = path.join(path.dirname(a), 'b')
  expect(await renameOrCopy(a, b)).toBe('renamed')
  expect(fs.existsSync(a)).toBe(false)
  twoMounts()
  const c = produced('across mounts'), d = path.join(A.team, PRODUCT.systemDir, 'exdev-copy')
  fs.mkdirSync(path.dirname(d), { recursive: true })
  expect(await renameOrCopy(c, d)).toBe('copied')
  expect(fs.readFileSync(d, 'utf8')).toBe('across mounts')
  expect(fs.readFileSync(c, 'utf8')).toBe('across mounts')
  fs.rmSync(d)
  // a link is refused before anything is copied (a copy would follow it)
  const target = produced('secret'), link = path.join(path.dirname(target), 'link')
  fs.symlinkSync(target, link)
  await expect(renameOrCopy(link, d)).rejects.toThrow('not a regular file')
  expect(fs.existsSync(d)).toBe(false)
  // any other rename error is not a reason to copy
  ;(fs as any).renameSync = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
  await expect(renameOrCopy(c, path.join(path.dirname(c), 'e'))).rejects.toMatchObject({ code: 'EACCES' })
  expect(fs.existsSync(path.join(path.dirname(c), 'e'))).toBe(false)
})

test('moveOffLoop across two mounts: the copy in place, the source gone', async () => {
  twoMounts()
  const a = produced('moved'), dst = path.join(A.team, PRODUCT.systemDir, 'exdev-moved')
  await moveOffLoop(a, dst)
  expect(crossings).toBe(1)
  expect(fs.readFileSync(dst, 'utf8')).toBe('moved')
  expect(fs.existsSync(a)).toBe(false)
  fs.rmSync(dst)
})

test('onTeamVolume + installRenamed across two mounts with one st_dev (the 0.20.4 bug): placed; a failed placement keeps the source', async () => {
  twoMounts()
  const src = produced('report v1')
  const vol = await onTeamVolume(A.team, src, path.join(A.team, 'shared'))
  expect(vol.file).not.toBe(src)
  expect(under(teamRoots, vol.file)).toBe(true)
  installRenamed(A.team, ['shared', 'exdev-report.docx'], vol.file)
  vol.finish(true)
  expect(fs.readFileSync(path.join(A.team, 'shared', 'exdev-report.docx'), 'utf8')).toBe('report v1')
  expect(fs.existsSync(src)).toBe(false)
  // not placed: the copy goes, the caller's file stays
  const src2 = produced('report v2')
  const vol2 = await onTeamVolume(A.team, src2, path.join(A.team, 'shared'))
  vol2.finish(false)
  expect(fs.existsSync(vol2.file)).toBe(false)
  expect(fs.readFileSync(src2, 'utf8')).toBe('report v2')
  expect(temps(A.team)).toEqual([])
})

test('onTeamVolume on one mount: a rename; not placed, the file goes back to the caller\'s name', async () => {
  const src = produced('one mount')
  const vol = await onTeamVolume(A.team, src, path.join(A.team, 'shared'))
  expect(fs.existsSync(src)).toBe(false)
  vol.finish(false)
  expect(fs.readFileSync(src, 'utf8')).toBe('one mount')
  expect(temps(A.team)).toEqual([])
})

test('stageInstall (uploads) across two mounts: a copy, placed, the upload gone', async () => {
  twoMounts()
  const up = await writeTemp(path.join(A.data, 'up'), new TextEncoder().encode('an upload'))
  const s = await stageInstall(A.team, ['shared'], up)
  expect(s.copied).toBe(true)
  commitStaged(s, ['shared', 'exdev-upload.txt'])
  expect(fs.readFileSync(path.join(A.team, 'shared', 'exdev-upload.txt'), 'utf8')).toBe('an upload')
  expect(fs.existsSync(up)).toBe(false)
})

test('an AI file save (placeProduced, as make_file) across two mounts: saved, the produced file gone, no temp left', async () => {
  twoMounts()
  const files = componentC(A.ctx).files
  const ctx: ToolCtx = { user: A.ctx.files.principal('alice'), turnId: null, files: new TurnFiles() }
  const src = produced('the weekly report')
  const made = await placeProduced(A.ctx, files, ctx, ['shared', 'exdev-weekly.txt'], src, 'make_file')
  expect(made.conflictCopyOf).toBeUndefined()
  expect(crossings).toBeGreaterThan(0)
  const abs = path.join(A.team, 'shared', 'exdev-weekly.txt')
  expect(sha256hex(fs.readFileSync(abs))).toBe(sha256hex('the weekly report'))
  expect(fs.existsSync(src)).toBe(false)
  expect(temps(A.team)).toEqual([])
})

test('place.ts never chooses rename or copy from st_dev alone', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'server', 'src', 'team-files', 'place.ts'), 'utf8')
  // the one st_dev comparison that took "one st_dev" for "a rename works" (onTeamVolume before 0.20.5)
  expect(src).not.toMatch(/lstatSync\(src\)\.dev\s*===/)
  expect(src).not.toMatch(/return \{ file: src, finish/)
})
