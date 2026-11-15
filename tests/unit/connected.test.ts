// Connected folders (server/src/team-files/connected.ts): which source folders may be connected, the one-way mirror
// into connected/<name> (new, changed, deleted), and that the mirror never overwrites or deletes what people put or
// changed there. Runs on the B harness (real DB, folder rules, team folder).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkName, checkSource, ConnectedError, ConnectedFolders } from '../../server/src/team-files/connected'
import { visiblePath } from '../../server/src/policy/authorize'
import { startHarness, type Harness } from '../lib/b-harness'

let h: Harness
let cf: ConnectedFolders
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-home-')))
const src = path.join(home, 'NAS-share')
const put = (rel: string, text: string, mtime?: number) => {
  const p = path.join(src, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text)
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000)
}
const team = (rel: string) => path.join(h.team, 'connected', 'nas', rel)
// the mirror's sources live in a temporary folder: on macOS any visible folder in the home may be connected; on Linux
// only folders below the mount roots (/mnt, /media, /srv), so here the temporary folder stands for such a root
beforeAll(async () => { h = await startHarness({ name: 'connected' }); cf = new ConnectedFolders(h.ctx, { home, linuxRoots: [home] }) })
afterAll(async () => { await h.close(); fs.rmSync(home, { recursive: true, force: true }) })

describe('what may be connected', () => {
  // the macOS rules (home, ~/Library, cloud folders) on every host; the Linux rules (mount roots, outside the install):
  // g-cloud-deployment.test.ts
  const o = () => ({ home, teamRoot: h.team, dataDir: h.dataDir, platform: 'darwin' as const })
  test('a visible folder in the home, /Volumes shares and cloud folders; not the home itself, hidden or Library', () => {
    fs.mkdirSync(path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-a@b.com', 'My Drive'), { recursive: true })
    fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true })
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    fs.mkdirSync(src, { recursive: true })
    expect(checkSource(src, o())).toBe(src)
    expect(checkSource(path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-a@b.com', 'My Drive'), o())).toContain('My Drive')
    for (const [p, code] of [[home, 'not_allowed'], [path.join(home, '.ssh'), 'hidden'], [path.join(home, 'Library', 'Keychains'), 'not_allowed'], ['relative/path', 'not_absolute'], [path.join(home, 'nope'), 'not_found'], [h.team, 'team_folder']] as const) {
      expect(() => checkSource(p, o())).toThrow(ConnectedError)
      try { checkSource(p, o()) } catch (e) { expect((e as Error).message).toBe(code) }
    }
    expect(() => checkName('../x')).toThrow(ConnectedError)
    expect(checkName(' 문서함 ')).toBe('문서함')
  })
})

describe('mirror', () => {
  test('connect: folder made, everyone can read it, files copied (hidden / links / bad names skipped)', async () => {
    put('회의록/2026-10-20.md', '주간 회의: 환불 규정 확정')
    put('price.csv', 'item,price\nA,100')
    put('.DS_Store', 'x')
    fs.symlinkSync('/etc/hosts', path.join(src, 'link-to-hosts'))
    const c = cf.add({ name: 'nas', source: src, actor: 'dion' })
    const r = await cf.sync(c.id)
    expect(r).toMatchObject({ copied: 2, updated: 0, removed: 0, files: 2 })
    expect(fs.readFileSync(team('회의록/2026-10-20.md'), 'utf8')).toBe('주간 회의: 환불 규정 확정')
    expect(fs.existsSync(team('.DS_Store'))).toBe(false)
    expect(fs.existsSync(team('link-to-hosts'))).toBe(false)
    const files = h.ctx.files
    expect(!!visiblePath(files.fx, files.rules(), files.principal('bob'), 'connected/nas/price.csv')).toBe(true)
    expect((await cf.sync(c.id))).toMatchObject({ copied: 0, updated: 0, removed: 0 })
  })
  test('changed and deleted at the source follow; what people changed or added here is kept', async () => {
    const c = cf.list()[0]!
    put('price.csv', 'item,price\nA,120', Date.now() + 5000)
    fs.rmSync(path.join(src, '회의록/2026-10-20.md'))
    fs.writeFileSync(team('my-note.md'), 'saved here by a person')
    put('kept.md', 'v1')
    await cf.sync(c.id)
    fs.writeFileSync(team('kept.md'), 'changed here')
    put('kept.md', 'v2 at the source', Date.now() + 10000)
    fs.rmSync(path.join(src, 'kept.md'), { force: true }); put('kept.md', 'v2 at the source', Date.now() + 10000)
    const r = await cf.sync(c.id)
    expect(fs.readFileSync(team('price.csv'), 'utf8')).toBe('item,price\nA,120')
    expect(fs.existsSync(team('회의록/2026-10-20.md'))).toBe(false)
    expect(fs.readFileSync(team('my-note.md'), 'utf8')).toBe('saved here by a person')
    expect(fs.readFileSync(team('kept.md'), 'utf8')).toBe('changed here')
    expect(r.kept).toBeGreaterThanOrEqual(1)
  })
  test('an unreadable source marks the folder as failed; disconnect removes only mirrored files', async () => {
    const c = cf.list()[0]!
    const moved = src + '-gone'
    fs.renameSync(src, moved)
    await expect(cf.sync(c.id)).rejects.toThrow('not_found')
    expect(cf.get(c.id)!.last_status).toBe('error')
    fs.renameSync(moved, src)
    await cf.sync(c.id)
    expect(cf.remove(c.id, 'dion')).toBe(true)
    expect(fs.existsSync(team('price.csv'))).toBe(false)
    expect(fs.readFileSync(team('my-note.md'), 'utf8')).toBe('saved here by a person')
    // the folder still holds a person's file: it and its rules stay
    expect(h.ctx.db.query("SELECT 1 AS x FROM folders WHERE path = 'connected/nas'").get()).toEqual({ x: 1 })
  })
  test('a Mac share keeps Korean names decomposed (NFD): folders and files are copied under composed (NFC) names', async () => {
    const mac = path.join(home, 'MacShare')
    const dir = '견적서 모음'.normalize('NFD'), file = '한글 견적_1.txt'.normalize('NFD')
    fs.mkdirSync(path.join(mac, dir), { recursive: true }); fs.writeFileSync(path.join(mac, dir, file), 'content NFD')
    const c = cf.add({ name: 'macshare', source: mac, actor: 'dion' })
    const r = await cf.sync(c.id)
    expect(r).toMatchObject({ copied: 1, files: 1 })
    const top = fs.readdirSync(path.join(h.team, 'connected', 'macshare'))
    expect(top).toEqual(['견적서 모음'.normalize('NFC')])
    expect(top[0]).toBe(top[0]!.normalize('NFC'))
    const inner = fs.readdirSync(path.join(h.team, 'connected', 'macshare', top[0]!))
    expect(inner).toEqual(['한글 견적_1.txt'.normalize('NFC')])
    expect(inner[0]).toBe(inner[0]!.normalize('NFC'))
    expect(await cf.sync(c.id)).toMatchObject({ copied: 0, updated: 0, removed: 0, files: 1 })
    // a mirror from before this change: its manifest row has the decomposed folder name; the next sync moves it to the
    // composed spelling and neither drops nor re-copies the file
    const old = ('견적서 모음'.normalize('NFD') + '/' + '한글 견적_1.txt'.normalize('NFC'))
    h.ctx.db.query('UPDATE connected_files SET path = ? WHERE folder_id = ?').run(old, c.id)
    expect(await cf.sync(c.id)).toMatchObject({ copied: 0, updated: 0, removed: 0, kept: 0, files: 1 })
    expect(fs.readdirSync(path.join(h.team, 'connected', 'macshare', '견적서 모음'.normalize('NFC')))).toEqual(['한글 견적_1.txt'.normalize('NFC')])
    expect((h.ctx.db.query('SELECT path FROM connected_files WHERE folder_id = ?').all(c.id) as { path: string }[]).map((r) => r.path)).toEqual(['견적서 모음/한글 견적_1.txt'.normalize('NFC')])
    expect(cf.remove(c.id, 'dion')).toBe(true)
  })
  test('a mirror left empty on disconnect disappears with its rules row', async () => {
    const other = path.join(home, 'Other')
    fs.mkdirSync(path.join(other, 'sub'), { recursive: true }); fs.writeFileSync(path.join(other, 'sub', 'a.txt'), 'a')
    const c = cf.add({ name: 'other', source: other, actor: 'dion' })
    await cf.sync(c.id)
    expect(cf.remove(c.id, 'dion')).toBe(true)
    expect(fs.existsSync(path.join(h.team, 'connected', 'other'))).toBe(false)
    expect(h.ctx.db.query("SELECT 1 FROM folders WHERE path = 'connected/other'").get()).toBeNull()
  })
})

// The source is checked again at every sync, and a sync never follows a link out of it: someone who can write to a
// share could otherwise point the source, or a file or folder in it, at the server's own data or a closed folder.
describe('links planted after connecting', () => {
  const secret = 'server-secret-do-not-copy'
  const plant = () => {
    fs.mkdirSync(path.join(h.dataDir, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(h.dataDir, 'secrets', 'credentials.key'), secret)
    fs.mkdirSync(path.join(h.team, 'groups', 'finance'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'groups', 'finance', 'pay.csv'), secret)
  }
  const mirrored = (name: string) => {
    const out: string[] = []
    const walk = (d: string) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.lstatSync(p).isDirectory()) walk(p); else out.push(fs.readFileSync(p, 'utf8')) } }
    walk(path.join(h.team, 'connected', name))
    return out
  }

  test('the source replaced by a link to the server data or the team folder: the sync refuses and copies nothing', async () => {
    plant()
    const s = path.join(home, 'Share-A')
    fs.mkdirSync(s, { recursive: true }); fs.writeFileSync(path.join(s, 'ok.txt'), 'normal')
    const c = cf.add({ name: 'share-a', source: s, actor: 'dion' })
    expect(await cf.sync(c.id)).toMatchObject({ copied: 1 })
    for (const target of [h.dataDir, path.join(h.team, 'groups', 'finance'), path.join(home, 'Other-allowed')]) {
      fs.mkdirSync(target, { recursive: true })
      fs.rmSync(s, { recursive: true, force: true })
      fs.symlinkSync(target, s)
      await expect(cf.sync(c.id)).rejects.toThrow('moved')
      expect(cf.get(c.id)).toMatchObject({ last_status: 'error', last_error: 'moved' })
      expect(mirrored('share-a')).toEqual(['normal'])
      fs.rmSync(s)
    }
    // a folder above the source swapped for a link: the source no longer resolves to the checked path
    const deep = path.join(home, 'Outer', 'Share-B')
    fs.mkdirSync(deep, { recursive: true }); fs.writeFileSync(path.join(deep, 'ok.txt'), 'normal')
    const d = cf.add({ name: 'share-b', source: deep, actor: 'dion' })
    await cf.sync(d.id)
    fs.renameSync(path.join(home, 'Outer'), path.join(home, 'Outer-real'))
    fs.mkdirSync(path.join(h.dataDir, 'Share-B'), { recursive: true }); fs.writeFileSync(path.join(h.dataDir, 'Share-B', 'x'), secret)
    fs.symlinkSync(h.dataDir, path.join(home, 'Outer'))
    await expect(cf.sync(d.id)).rejects.toThrow('moved')
    expect(mirrored('share-b')).toEqual(['normal'])
    // the real folder back: it syncs again
    fs.rmSync(path.join(home, 'Outer')); fs.renameSync(path.join(home, 'Outer-real'), path.join(home, 'Outer'))
    expect(await cf.sync(d.id)).toMatchObject({ copied: 0 })
    expect(cf.get(d.id)!.last_status).toBe('ok')
  })

  test('a file or a folder swapped for a link between listing and copying is never copied; the rest still syncs', async () => {
    plant()
    const s = path.join(home, 'Share-C')
    fs.mkdirSync(path.join(s, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(s, 'keep.txt'), 'normal')
    fs.writeFileSync(path.join(s, 'swap.txt'), 'normal file')
    fs.writeFileSync(path.join(s, 'sub', 'pay.csv'), 'normal sub file')
    fs.writeFileSync(path.join(s, 'sub', 'other.txt'), 'normal')
    const c = cf.add({ name: 'share-c', source: s, actor: 'dion' })
    // the race, made certain: the listing runs as usual, then the links are put in before any file is copied
    const real = (cf as unknown as { listSource: (src: string) => unknown }).listSource.bind(cf)
    ;(cf as unknown as { listSource: (src: string) => unknown }).listSource = (src: string) => {
      const listed = real(src)
      fs.rmSync(path.join(s, 'swap.txt')); fs.symlinkSync(path.join(h.dataDir, 'secrets', 'credentials.key'), path.join(s, 'swap.txt'))
      fs.renameSync(path.join(s, 'sub'), path.join(home, 'sub-moved'))
      fs.symlinkSync(path.join(h.team, 'groups', 'finance'), path.join(s, 'sub'))
      return listed
    }
    try {
      const r = await cf.sync(c.id)
      expect(r.copied).toBe(1)
      expect(r.skipped).toBeGreaterThanOrEqual(3)
    } finally { delete (cf as unknown as { listSource?: unknown }).listSource }
    expect(mirrored('share-c')).toEqual(['normal'])
    expect(fs.existsSync(path.join(h.team, 'connected', 'share-c', 'swap.txt'))).toBe(false)
    expect(fs.existsSync(path.join(h.team, 'connected', 'share-c', 'sub', 'pay.csv'))).toBe(false)
    // links already there when listing: skipped, never entered
    const r2 = await cf.sync(c.id)
    expect(r2.copied).toBe(0)
    expect(mirrored('share-c')).toEqual(['normal'])
    // back to real files: they sync
    fs.rmSync(path.join(s, 'sub')); fs.renameSync(path.join(home, 'sub-moved'), path.join(s, 'sub'))
    fs.rmSync(path.join(s, 'swap.txt')); fs.writeFileSync(path.join(s, 'swap.txt'), 'normal file')
    expect(await cf.sync(c.id)).toMatchObject({ copied: 3 })
    expect(mirrored('share-c').sort()).toEqual(['normal', 'normal', 'normal file', 'normal sub file'])
  })

  // root ignores folder permissions (CI containers run as root): these need an ordinary user
  const asUser = process.getuid?.() !== 0
  test.if(asUser)('a source nobody may read says "permission", not "not found"', async () => {
    const s = path.join(home, 'Share-D')
    fs.mkdirSync(s, { recursive: true }); fs.writeFileSync(path.join(s, 'ok.txt'), 'normal')
    const c = cf.add({ name: 'share-d', source: s, actor: 'dion' })
    await cf.sync(c.id)
    fs.chmodSync(s, 0o000)
    try {
      await expect(cf.sync(c.id)).rejects.toThrow('permission')
      expect(cf.get(c.id)).toMatchObject({ last_status: 'error', last_error: 'permission' })
    } finally { fs.chmodSync(s, 0o755) }
    expect(mirrored('share-d')).toEqual(['normal'])
  })

  test.if(asUser)('a subfolder nobody may read stops the sync with "permission"; its mirrored files stay', async () => {
    const s = path.join(home, 'Share-E')
    fs.mkdirSync(path.join(s, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(s, 'ok.txt'), 'normal'); fs.writeFileSync(path.join(s, 'sub', 'a.txt'), 'normal sub')
    const c = cf.add({ name: 'share-e', source: s, actor: 'dion' })
    expect(await cf.sync(c.id)).toMatchObject({ copied: 2 })
    fs.chmodSync(path.join(s, 'sub'), 0o000)
    try {
      await expect(cf.sync(c.id)).rejects.toThrow('permission')
      expect(cf.get(c.id)!.last_error).toBe('permission')
    } finally { fs.chmodSync(path.join(s, 'sub'), 0o755) }
    expect(mirrored('share-e').sort()).toEqual(['normal', 'normal sub'])
  })

  test('the source swapped for a link right after the check: the sync stops, the mirror is not emptied', async () => {
    plant()
    const s = path.join(home, 'Share-F')
    fs.mkdirSync(s, { recursive: true }); fs.writeFileSync(path.join(s, 'ok.txt'), 'normal')
    const c = cf.add({ name: 'share-f', source: s, actor: 'dion' })
    await cf.sync(c.id)
    const real = (cf as unknown as { listSource: (src: string) => unknown }).listSource.bind(cf)
    ;(cf as unknown as { listSource: (src: string) => unknown }).listSource = (src: string) => {
      fs.renameSync(s, s + '-real'); fs.symlinkSync(h.dataDir, s)
      return real(src)
    }
    try { await expect(cf.sync(c.id)).rejects.toThrow('moved') } finally {
      delete (cf as unknown as { listSource?: unknown }).listSource
      fs.rmSync(s); fs.renameSync(s + '-real', s)
    }
    expect(cf.get(c.id)!.last_error).toBe('moved')
    expect(mirrored('share-f')).toEqual(['normal'])
    expect(await cf.sync(c.id)).toMatchObject({ copied: 0, removed: 0, files: 1 })
  })
})
