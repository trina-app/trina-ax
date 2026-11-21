// A safe write into a chat's work folder (server/src/devenv/work-write.ts; docs/AGENTS/plan/20261121-0648-work-safe-write.md):
// the server stages a checked copy, and a box command copies it in with the box's rights. The runner runs against a
// fake system that runs the box command with sh (no sandbox): the fence itself is tested on real srt in
// tests/linux/srt-work-write.ts (Linux) and tests/macos/srt-work-write-mac.ts (macOS). Here: what the server does
// before, around and after that command.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEV_ENV_DEFAULT_LIMITS } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { chatWork, devenvPaths, isStageFolder, settingsProblems, srtSettings } from '../../server/src/devenv/srt/config'
import { forgetChatWork, runCommand, setSrtSystem, spaceOf, workFolderAt, type SharedRun } from '../../server/src/devenv/srt/runner'
import type { SpawnSpec, SrtSystem } from '../../server/src/devenv/srt/system'
import { macSystem, type MacHost } from '../../server/src/devenv/srt/system-mac'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { copiedInOf, copyInScript, noteCopiedIn, validWorkRel, writeIntoWork, WORK_COPY_MAX_FILES, type WorkSource } from '../../server/src/devenv/work-write'
import { addCopiedIn, COPIED_GROUPS_MAX, copiedInFile, readCopiedIn } from '../../server/src/devenv/srt/copied-in'
import type { ReadSource } from '../../server/src/chat/read-scope'
import type { CopiedGroup } from '../../server/src/devenv/srt/copied-in'

setDefaultTimeout(30_000)

// ---- a fake system: the box command runs with sh in the run's cwd, after the run's settings are kept ----
interface Run { spec: SpawnSpec; settings: { filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[] } }; workBefore: string[] }
const runs: Run[] = []
/** what happens right before the box command runs (another command swaps a folder, for example) */
let beforeBox: (() => void) | null = null
const listAll = (d: string): string[] => { const out: string[] = []; const walk = (r: string) => { let l: fs.Dirent[] = []; try { l = fs.readdirSync(path.join(d, r), { withFileTypes: true }) } catch { return } for (const e of l) { const x = r ? `${r}/${e.name}` : e.name; out.push(x); if (e.isDirectory()) walk(x) } }; walk(''); return out.sort() }
const fake: SrtSystem = {
  spawn(spec) {
    const settings = JSON.parse(fs.readFileSync(spec.settingsFile, 'utf8'))
    runs.push({ spec, settings, workBefore: listAll(spec.cwd) })
    beforeBox?.()
    // the runner's first lines (the Linux entry guard) are the sandbox's: the copy script starts at "set -u"
    const cmd = spec.command.includes('set -u') ? spec.command.slice(spec.command.indexOf('set -u')) : spec.command
    const p = Bun.spawnSync(['/bin/sh', '-c', cmd], { cwd: spec.cwd, env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
    fs.appendFileSync(spec.stdoutFile, p.stdout); fs.appendFileSync(spec.stderrFile, p.stderr)
    fs.writeFileSync(spec.exitFile, `${p.exitCode}\n`)
    return { pid: 999_998, exited: Promise.resolve({ code: p.exitCode, signal: null }) }
  },
  async stop() {}, async unit() { return { state: '', result: '', memoryBytes: null } }, async units() { return [] }, async forget() {},
  oomKills() { return null }, cpuUsec() { return null }, procs() { return [] }, async selfTest() { return '' },
}

let h: Harness
let base = ''
const PLAN = { format: 1 as const, plan: 'team', maxRunning: 2, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' as const }
const chat = () => `c${Math.random().toString(36).slice(2, 12)}`
const personal = (chatId: string) => ({ userId: 'alice', chatId, project: null })
const w = (abs: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text) }
const team = (rel: string) => path.join(h.team, rel)
const stageLeft = () => { try { return fs.readdirSync(devenvPaths(base).stage) } catch { return [] } }

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'devenv-work-write' })
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'work-write-'))
  saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
  // a proposal: an HTML file and its images folder, in alice's own folder
  w(team('users/alice/proposal/proposal.html'), '<img src="images/a.png">')
  w(team('users/alice/proposal/images/a.png'), 'PNG-A')
  w(team('users/alice/proposal/images/b.png'), 'PNG-B')
  w(team('users/alice/secret/key.txt'), 'SECRET-OUTSIDE')
})
afterAll(async () => {
  setSrtSystem(null)
  delete process.env.MYCEL_DEV_ENV
  await h.close()
  fs.rmSync(base, { recursive: true, force: true })
})
beforeEach(() => { runs.length = 0; beforeBox = null; setSrtSystem(fake, { base, id: 'mycel', plan: PLAN }) })

describe('a file and a folder', () => {
  test('a team file lands in the work folder through one box command; the server wrote nothing there itself', async () => {
    const id = chat()
    const abs = team('users/alice/proposal/proposal.html')
    const r = await writeIntoWork(h.ctx, personal(id), 'in/', { kind: 'file', abs, seen: fs.lstatSync(abs) })
    expect(r).toMatchObject({ path: 'in/proposal.html', files: 1, bytes: 24, skipped: [] })
    const work = chatWork(base, id)
    expect(fs.readFileSync(path.join(work, 'in/proposal.html'), 'utf8')).toBe('<img src="images/a.png">')
    // the work folder was empty when the box command started: the copy is the box's, never the server's
    expect(runs).toHaveLength(1)
    // (only srt's empty mount points, placeholders.ts, are there)
    expect(runs[0]!.workBefore.filter((x) => !x.startsWith('.'))).toEqual([])
    // the stage folder: read-only in that run, gone afterwards
    const s = runs[0]!.settings.filesystem
    const stage = s.allowRead.find((r) => r.startsWith(devenvPaths(base).stage + '/'))!
    expect(isStageFolder(base, stage)).toBe(true)
    expect(s.allowWrite.some((x) => x.startsWith(devenvPaths(base).stage))).toBe(false)
    expect(s.allowWrite).toContain(work)
    expect(stageLeft()).toEqual([])
    // the copy is the box's to edit (0600 staged, not read-only)
    expect(fs.statSync(path.join(work, 'in/proposal.html')).mode & 0o200).toBe(0o200)
  })

  test('an HTML file and its images folder; never an overwrite (name (2))', async () => {
    const id = chat()
    const src: WorkSource = { kind: 'folder', abs: team('users/alice/proposal') }
    const a = await writeIntoWork(h.ctx, personal(id), 'in/', src)
    expect(a).toMatchObject({ path: 'in/proposal', files: 3, bytes: 34 })
    const b = await writeIntoWork(h.ctx, personal(id), 'in/proposal', src)
    expect(b.path).toBe('in/proposal (2)')
    const f1 = await writeIntoWork(h.ctx, personal(id), 'in/proposal/proposal.html', { kind: 'file', abs: team('users/alice/proposal/proposal.html') })
    expect(f1.path).toBe('in/proposal/proposal (2).html')
    expect(listAll(path.join(chatWork(base, id), 'in'))).toEqual(['proposal', 'proposal (2)', 'proposal (2)/images', 'proposal (2)/images/a.png', 'proposal (2)/images/b.png', 'proposal (2)/proposal.html',
      'proposal/images', 'proposal/images/a.png', 'proposal/images/b.png', 'proposal/proposal (2).html', 'proposal/proposal.html'])
  })

  test('a folder with an inner link, a pipe and a hard link: none of them is copied, and the result says so', async () => {
    const dir = team('users/alice/mixed')
    w(path.join(dir, 'page.html'), 'page')
    fs.symlinkSync(team('users/alice/secret/key.txt'), path.join(dir, 'key-link.txt'))
    fs.symlinkSync(team('users/alice/secret'), path.join(dir, 'images'))
    Bun.spawnSync(['mkfifo', path.join(dir, 'pipe')])
    w(path.join(dir, 'orig.txt'), 'orig'); fs.linkSync(path.join(dir, 'orig.txt'), path.join(dir, 'hard.txt'))
    const id = chat()
    const r = await writeIntoWork(h.ctx, personal(id), 'x', { kind: 'folder', abs: dir })
    expect(r.path).toBe('x')
    expect(r.skipped.map((s) => `${s.path}:${s.why}`).sort()).toEqual(['hard.txt:hard link', 'images:link', 'key-link.txt:link', 'orig.txt:hard link', 'pipe:not a regular file'])
    const got = listAll(path.join(chatWork(base, id), 'x'))
    expect(got).toEqual(['page.html'])
    const all = Bun.spawnSync(['grep', '-r', 'SECRET-OUTSIDE', chatWork(base, id)]).stdout.toString()
    expect(all).toBe('')
  })

  test('a file named by itself that is a link, a folder source that is a link: refused, nothing runs', async () => {
    fs.symlinkSync(team('users/alice/secret/key.txt'), team('users/alice/to-key'))
    fs.symlinkSync(team('users/alice/secret'), team('users/alice/to-secret'))
    await expect(writeIntoWork(h.ctx, personal(chat()), '', { kind: 'file', abs: team('users/alice/to-key') })).rejects.toThrow(/link/)
    await expect(writeIntoWork(h.ctx, personal(chat()), '', { kind: 'folder', abs: team('users/alice/to-secret') })).rejects.toThrow(/link/)
    expect(runs).toHaveLength(0)
    expect(stageLeft()).toEqual([])
  })

  test('the caller\'s check per entry leaves out a folder some may not read', async () => {
    const id = chat()
    const r = await writeIntoWork(h.ctx, personal(id), 'p', { kind: 'folder', abs: team('users/alice/proposal'), include: (rel) => rel !== 'images' })
    expect(r.files).toBe(1)
    expect(listAll(path.join(chatWork(base, id), 'p'))).toEqual(['proposal.html'])
  })
})

describe('swapped links in the source', () => {
  test('a folder on the way swapped for a link between the listing and the copy: the whole copy is refused', async () => {
    const dir = team('users/alice/swap-mid')
    w(path.join(dir, 'page.html'), 'page'); w(path.join(dir, 'images/key.txt'), 'harmless')
    const id = chat()
    // the caller's check runs during the listing: the last one swaps images/ for a link to a folder with the same names
    const src: WorkSource = { kind: 'folder', abs: dir, include: (rel) => {
      if (rel === 'page.html') { fs.renameSync(path.join(dir, 'images'), path.join(dir, 'images.old')); fs.symlinkSync(team('users/alice/secret'), path.join(dir, 'images')) }
      return true
    } }
    await expect(writeIntoWork(h.ctx, personal(id), 'y', src)).rejects.toThrow(/changed while it was copied/)
    expect(runs).toHaveLength(0)
    expect(fs.existsSync(path.join(chatWork(base, id), 'y'))).toBe(false)
    expect(stageLeft()).toEqual([])
  })

  test('the source folder itself swapped at its root after the check: refused (the open file is not the one the walk expects)', async () => {
    const dir = team('users/alice/swap-root')
    w(path.join(dir, 'key.txt'), 'harmless')
    const real = fs.realpathSync(dir)
    const src: WorkSource = { kind: 'folder', abs: dir, include: (rel) => {
      if (rel === 'key.txt') { fs.renameSync(real, real + '.old'); fs.symlinkSync(team('users/alice/secret'), real) }
      return true
    } }
    await expect(writeIntoWork(h.ctx, personal(chat()), 'z', src)).rejects.toThrow(/changed while it was copied/)
    expect(runs).toHaveLength(0)
  })

  test('a team file that changed after its permission check: refused (openToRead with its lstat)', async () => {
    const abs = team('users/alice/checked.txt')
    w(abs, 'one')
    const seen = fs.lstatSync(abs)
    fs.renameSync(abs, abs + '.old'); w(abs, 'two')
    await expect(writeIntoWork(h.ctx, personal(chat()), '', { kind: 'file', abs, seen })).rejects.toThrow()
    expect(runs).toHaveLength(0)
  })
})

describe('the destination', () => {
  test('a path that leaves the work folder or is no plain name is refused before anything runs', async () => {
    for (const bad of ['../x', 'a/../../x', '/etc/x', '~/x', 'a//b', 'a/\u0001b', 'a\\b', `${'n'.repeat(256)}`, 'a/..']) {
      expect(() => validWorkRel(bad), bad).toThrow()
      await expect(writeIntoWork(h.ctx, personal(chat()), bad, { kind: 'file', abs: team('users/alice/proposal/proposal.html') }), bad).rejects.toThrow()
    }
    expect(validWorkRel('./in/x.html')).toBe('in/x.html')
    expect(validWorkRel('in/')).toBe('in')
    expect(validWorkRel('')).toBe('')
    expect(runs).toHaveLength(0)
  })

  test('a link a command left at the destination\'s root or mid-path: the server does not follow it; the box command gets it, with only the work folder writable', async () => {
    const id = chat()
    const work = chatWork(base, id)
    fs.mkdirSync(work, { recursive: true })
    fs.symlinkSync(team('shared'), path.join(work, 'in'))
    // and one swapped in right before the box command runs
    beforeBox = () => { beforeBox = null; fs.mkdirSync(path.join(work, 'deep'), { recursive: true }); fs.symlinkSync(h.ctx.config.dataDir, path.join(work, 'deep', 'mid')) }
    const before = listAll(team('shared'))
    // (this fake runs the box command with no sandbox, so the copy goes through the link; the result names it)
    const r = await writeIntoWork(h.ctx, personal(id), 'deep/mid/x.html', { kind: 'file', abs: team('users/alice/proposal/proposal.html') })
    expect(r).toMatchObject({ path: 'deep/mid/x.html', viaLink: 'deep/mid' })
    fs.rmSync(path.join(h.ctx.config.dataDir, 'x.html'), { force: true })
    const plain = await writeIntoWork(h.ctx, personal(id), 'plain/x.html', { kind: 'file', abs: team('users/alice/proposal/proposal.html') })
    expect(plain.viaLink).toBeUndefined()
    // the server staged it and handed it to the run: the run may write the work folder and the person's own folder, not
    // shared/ and not the data folder (srt refuses the write through the link: tests/linux/srt-work-write.ts)
    const s = runs[0]!.settings.filesystem
    expect(s.allowWrite).toContain(work)
    expect(s.allowWrite.some((x) => team('shared').startsWith(x) || x.startsWith(team('shared')))).toBe(false)
    expect(s.allowWrite.some((x) => x.startsWith(h.ctx.config.dataDir) || h.ctx.config.dataDir.startsWith(x + '/'))).toBe(false)
    expect(s.denyRead).toContain(base)
    expect(listAll(team('shared'))).toEqual(before)
  })
})

describe('limits', () => {
  test('more than 2,000 files: nothing is copied, and the error names the limit', async () => {
    const dir = team('users/alice/many')
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i <= WORK_COPY_MAX_FILES; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x')
    const id = chat()
    await expect(writeIntoWork(h.ctx, personal(id), 'm', { kind: 'folder', abs: dir })).rejects.toThrow(/more than 2000 files/)
    expect(runs).toHaveLength(0)
    expect(fs.existsSync(path.join(chatWork(base, id), 'm'))).toBe(false)
    expect(stageLeft()).toEqual([])
  })

  test('a file over 1 GB, a file over the read limit, over what the turn may still write', async () => {
    const big = team('users/alice/big.bin')
    fs.mkdirSync(path.dirname(big), { recursive: true })
    const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 1024 ** 3 + 1); fs.closeSync(fd)
    await expect(writeIntoWork(h.ctx, personal(chat()), '', { kind: 'file', abs: big })).rejects.toThrow(/too large .*at most 1024 MB a file/)
    fs.rmSync(big)
    const src: WorkSource = { kind: 'folder', abs: team('users/alice/proposal') }
    await expect(writeIntoWork(h.ctx, personal(chat()), 'p', src, { maxFileBytes: 10 })).rejects.toThrow(/at most 0 MB a file/)
    await expect(writeIntoWork(h.ctx, personal(chat()), 'p', src, { turnLeft: { bytes: 20, files: 100 } })).rejects.toThrow(/than this answer may still write/)
    await expect(writeIntoWork(h.ctx, personal(chat()), 'p', src, { turnLeft: { bytes: 1e9, files: 2 } })).rejects.toThrow(/more files than this answer may still write \(2\)/)
    expect(runs).toHaveLength(0)
  })

  test('a download-only artifact (quarantine hash) is not copied in', async () => {
    const abs = team('users/alice/deck.pptx')
    w(abs, 'QUARANTINED-BYTES')
    h.ctx.files.quarantine.add(Buffer.from('QUARANTINED-BYTES'), 'pptx')
    await expect(writeIntoWork(h.ctx, personal(chat()), '', { kind: 'file', abs })).rejects.toThrow(/download-only/)
    expect(runs).toHaveLength(0)
  })
})

describe('a shared chat: its key and what was copied in', () => {
  let audience = ['alice', 'bob']
  const noted: CopiedGroup[][] = []
  const shared = (o: { copied?: boolean } = {}): SharedRun => ({ within: null, audience: () => audience, noteReads: () => true, ...(o.copied === false ? {} : { noteCopied: (g: readonly CopiedGroup[]) => { noted.push([...g]); return true } }) })
  const SRC: ReadSource[] = [{ type: 'user', id: 'alice' }]
  beforeEach(() => { audience = ['alice', 'bob']; noted.length = 0 })

  test('the copy is recorded under its workspace key before it runs, and every later run on that key records it again', async () => {
    const id = chat()
    const target = { userId: 'alice', chatId: id, project: null, shared: shared() }
    const r = await writeIntoWork(h.ctx, target, 'in/', { kind: 'file', abs: team('users/alice/proposal/proposal.html') }, { sources: SRC })
    expect(r.path).toBe('in/proposal.html')
    const wf = workFolderAt(h.ctx, target)!
    expect(wf.path.startsWith(devenvPaths(base).workShared + '/')).toBe(true)
    expect(fs.existsSync(path.join(wf.path, 'in/proposal.html'))).toBe(true)
    // the record is server-only (in the base folder, never given to a run)
    const file = copiedInFile(base, id, wf.path)!
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(runs[0]!.settings.filesystem.allowRead.some((x) => file.startsWith(x + '/'))).toBe(false)
    expect(copiedInOf(id, wf.path)).toEqual([{ c: ['alice', 'bob'], s: SRC }])
    // the copy's own run recorded it into this answer
    expect(noted).toEqual([[{ c: ['alice', 'bob'], s: SRC }]])
    // a later command on the same key (a day later, another turn): recorded again into that answer
    noted.length = 0
    const space = spaceOf(h.ctx, { ...target, shared: shared() })!
    const later = await runCommand(h.ctx, { space, cwd: '.', command: 'set -u\nls in', timeoutMs: 10_000 })
    expect(later.ok).toBe(true)
    expect(noted).toEqual([[{ c: ['alice', 'bob'], s: SRC }]])
    // a read of the folder by the file tools (P1/P2)
    noted.length = 0
    expect(noteCopiedIn(h.ctx, { chatId: id, shared: shared(), workRoot: wf.path })).toBe(true)
    expect(noted).toHaveLength(1)
    // a run that cannot record it does not start; a read that cannot is refused
    const blind = spaceOf(h.ctx, { ...target, shared: shared({ copied: false }) })!
    const refused = await runCommand(h.ctx, { space: blind, cwd: '.', command: 'set -u\nls in', timeoutMs: 10_000 })
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('copied into this work folder could not be recorded') })
    expect(noteCopiedIn(h.ctx, { chatId: id, shared: shared({ copied: false }), workRoot: wf.path })).toBe(false)
    // a damaged record fails closed too
    fs.writeFileSync(file, '{not json')
    expect(noteCopiedIn(h.ctx, { chatId: id, shared: shared(), workRoot: wf.path })).toBe(false)
    // the record goes with the chat
    forgetChatWork(id)
    expect(fs.existsSync(file)).toBe(false)
  })

  test('the people change: the key the caller resolved refuses the copy; the new key is empty and carries no record', async () => {
    const id = chat()
    const target = { userId: 'alice', chatId: id, project: null, shared: shared() }
    await writeIntoWork(h.ctx, target, 'in/', { kind: 'file', abs: team('users/alice/proposal/proposal.html') }, { sources: SRC })
    const old = workFolderAt(h.ctx, target)!
    audience = ['alice', 'bob', 'erin']
    await expect(writeIntoWork(h.ctx, { ...target, expect: old }, 'in/', { kind: 'file', abs: team('users/alice/proposal/proposal.html') }, { sources: SRC })).rejects.toThrow(/people in this chat changed/)
    expect(runs).toHaveLength(1)
    // the new key's folder: none yet, no record; a command there records nothing copied
    expect(workFolderAt(h.ctx, target)).toBeNull()
    noted.length = 0
    const space = spaceOf(h.ctx, target)!
    expect(space.root).not.toBe(old.path)
    expect(copiedInOf(id, space.root)).toEqual([])
    const r = await runCommand(h.ctx, { space, cwd: '.', command: 'set -u\nls', timeoutMs: 10_000 })
    expect(r.ok).toBe(true)
    expect(noted).toEqual([])
    expect(fs.readdirSync(space.root)).toEqual([])
  })

  test('a shared chat\'s copy needs its sources (the caller\'s read card); a project chat has no work folder', async () => {
    await expect(writeIntoWork(h.ctx, { userId: 'alice', chatId: chat(), project: null, shared: shared() }, '', { kind: 'file', abs: team('users/alice/proposal/proposal.html') })).rejects.toThrow(/needs its sources/)
    fs.mkdirSync(team('projects/falcon'), { recursive: true })
    await expect(writeIntoWork(h.ctx, { userId: 'alice', chatId: chat(), project: null, shared: { ...shared(), within: 'projects/falcon' } }, '', { kind: 'file', abs: team('users/alice/proposal/proposal.html') }, { sources: SRC })).rejects.toThrow(/no work folder/)
    expect(runs).toHaveLength(0)
  })
})

describe('the settings of the copy run', () => {
  const input = (o: Partial<Parameters<typeof srtSettings>[0]> = {}) => ({
    base, id: 'mycel', teamRoot: h.team, userId: 'alice', view: { read: [], write: ['users/alice'], denyRead: [], denyWrite: [] }, start: null,
    work: chatWork(base, 'c1'), network: 'offline' as const, extraDomains: [], denyHosts: [], denyAddrs: [], runId: 'r'.repeat(16), ...o,
  })
  for (const platform of ['linux', 'darwin'] as const) {
    test(`${platform}: the stage folder is readable, never writable; a stage anywhere else is refused`, () => {
      const stage = path.join(devenvPaths(base).stage, 'abcdefghijklmnop')
      const i = input({ platform, stage })
      const s = srtSettings(i)
      expect(s.filesystem.allowRead).toContain(stage)
      expect(s.filesystem.allowWrite).not.toContain(stage)
      expect(s.filesystem.denyRead).toContain(base)
      expect(settingsProblems(s, i)).toEqual([])
      // a stage outside <base>/devenv/stage, or a writable one, is refused
      const odd = input({ platform, stage: path.join(base, 'devenv', 'abcdefghijklmnop') })
      expect(settingsProblems({ ...srtSettings(odd), filesystem: { ...srtSettings(odd).filesystem, allowRead: [...srtSettings(odd).filesystem.allowRead, odd.stage!] } }, odd).join('\n')).toMatch(/stage folder outside/)
      const writable = { ...s, filesystem: { ...s.filesystem, allowWrite: [...s.filesystem.allowWrite, stage] } }
      expect(settingsProblems(writable, i).join('\n')).toMatch(/stage folder is writable/)
    })
  }

  test('darwin: the copy run\'s settings, as on a Mac team server', async () => {
    setSrtSystem(fake, { base, id: 'mycel', plan: PLAN, platform: 'darwin' })
    const id = chat()
    await writeIntoWork(h.ctx, personal(id), '', { kind: 'file', abs: team('users/alice/proposal/proposal.html') })
    const s = runs[0]!.settings.filesystem
    expect(s.allowRead.some((r) => isStageFolder(base, r))).toBe(true)
    expect(s.allowWrite.some((r) => r.startsWith(devenvPaths(base).stage))).toBe(false)
    expect(runs[0]!.spec.readable?.length).toBe(1)
    expect(isStageFolder(base, runs[0]!.spec.readable![0])).toBe(true)
  })

  test('macOS: the stage folder gets the dev accounts\' ACL as the writable folders do', async () => {
    const calls: string[][] = []
    const host: MacHost = { procs: () => [], uid: () => 601, spawn: () => ({ pid: 4242, exited: new Promise(() => {}) }), run: async (argv) => { calls.push(argv); return { code: 0, out: '', err: '' } } }
    const mbase = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-stage-'))
    fs.mkdirSync(devenvPaths(mbase).run, { recursive: true })
    const sys = macSystem({ base: mbase, slots: ['_axdev1'], portBase: 47900, poolMiB: 1024, pidsMax: 256, acl: ['group:_axdev allow read,write,list,search'] }, host)
    const stage = path.join(devenvPaths(mbase).stage, 'abcdefghijklmnop'), work = path.join(devenvPaths(mbase).work, 'c1')
    const f = path.join(mbase, 'out')
    await sys.spawn({ runId: 'abcdefghijklmnop', id: 'mycel', cwd: mbase, env: {}, limits: { cpus: 1, memoryMiB: 512, pids: 64, runtimeMaxSec: 60 }, exitFile: f + '.exit', settingsFile: f + '.json', command: 'true', stdoutFile: f, stderrFile: f, writable: [work], readable: [stage] })
    const granted = calls.filter((a) => a[0] === '/bin/chmod').map((a) => a.at(-1))
    expect(granted).toEqual([work, stage])
    fs.rmSync(mbase, { recursive: true, force: true })
  })
})

describe('review fixes (#218)', () => {
  test('a folder on the way to the source folder that is a link: refused, nothing is staged or run (the walk would trust where it leads)', async () => {
    // alice may write her own folder; a command of hers made via/ a link to a folder outside the team folder, and the
    // caller names users/alice/via/stuff (or swaps a real via/ for the link after its check)
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-outside-')))
    w(path.join(outside, 'stuff/server-secret.txt'), 'SERVER-SECRET')
    fs.symlinkSync(outside, team('users/alice/via'))
    const id = chat()
    await expect(writeIntoWork(h.ctx, personal(id), 'got', { kind: 'folder', abs: team('users/alice/via/stuff') })).rejects.toThrow(/link|changed/)
    expect(runs).toHaveLength(0)
    expect(stageLeft()).toEqual([])
    expect(fs.existsSync(path.join(chatWork(base, id), 'got'))).toBe(false)
    fs.rmSync(outside, { recursive: true, force: true })
  })

  test('a file named without its lstat through a folder that is a link (a work folder\'s link to the server\'s data): refused', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-outside-')))
    w(path.join(outside, 'db.sqlite'), 'SERVER-DB')
    const id = chat()
    // a command made lnk/ in the chat's own work folder; a copy of chat:work/lnk/db.sqlite elsewhere in it
    await writeIntoWork(h.ctx, personal(id), 'seed.txt', { kind: 'file', abs: team('users/alice/proposal/proposal.html') })
    const work = fs.realpathSync(chatWork(base, id))
    fs.symlinkSync(outside, path.join(work, 'lnk'))
    runs.length = 0
    await expect(writeIntoWork(h.ctx, personal(id), 'got.sqlite', { kind: 'file', abs: path.join(work, 'lnk', 'db.sqlite') })).rejects.toThrow(/link/)
    expect(runs).toHaveLength(0)
    expect(fs.existsSync(path.join(work, 'got.sqlite'))).toBe(false)
    fs.rmSync(outside, { recursive: true, force: true })
  })

  test.if(process.platform === 'darwin')('macOS: a folder whose name is stored in another Unicode form than the path names it (Finder NFD) is no link: copied', async () => {
    const nfd = '제안서'.normalize('NFD')
    w(team(`users/alice/${nfd}/a.txt`), 'A')
    const r = await writeIntoWork(h.ctx, personal(chat()), 'nf/', { kind: 'folder', abs: team(`users/alice/${nfd.normalize('NFC')}`) })
    expect(r.files).toBe(1)
  })

  test('two copies to the same name at once: each gets its own name, neither overwrites or lands inside the other', async () => {
    // a cp that waits first: both scripts have looked at the name before either copies (two parallel tool calls)
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-race-')))
    const shim = path.join(d, 'bin'); fs.mkdirSync(shim)
    fs.writeFileSync(path.join(shim, 'cp'), '#!/bin/sh\nsleep 0.4\nexec /bin/cp "$@"\n', { mode: 0o755 })
    const work = path.join(d, 'work'); fs.mkdirSync(work)
    for (const k of ['a', 'b']) { w(path.join(d, `stage-${k}/item.txt`), `FILE-${k}`); w(path.join(d, `stage-${k}/dir/x.txt`), `DIR-${k}`) }
    const both = async (item: (k: string) => string, leaf: string, folder: boolean) => {
      const ps = ['a', 'b'].map((k) => Bun.spawn(['/bin/sh', '-c', copyInScript(item(k), 'in', leaf, folder)], { cwd: work, env: { PATH: `${shim}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' }))
      const outs = await Promise.all(ps.map(async (p) => { await p.exited; return { code: p.exitCode, out: await new Response(p.stdout).text() } }))
      expect(outs.map((o) => o.code)).toEqual([0, 0])
      return outs.map((o) => /TRINA-WROTE:\.\/(.+)/.exec(o.out)![1]!)
    }
    const files = await both((k) => path.join(d, `stage-${k}/item.txt`), 'report.txt', false)
    expect(new Set(files).size).toBe(2)
    expect(files.map((f) => fs.readFileSync(path.join(work, f), 'utf8')).sort()).toEqual(['FILE-a', 'FILE-b'])
    const dirs = await both((k) => path.join(d, `stage-${k}/dir`), 'pages', true)
    expect(new Set(dirs).size).toBe(2)
    expect(dirs.map((f) => listAll(path.join(work, f)))).toEqual([['x.txt'], ['x.txt']])
    expect(dirs.map((f) => fs.readFileSync(path.join(work, f, 'x.txt'), 'utf8')).sort()).toEqual(['DIR-a', 'DIR-b'])
    fs.rmSync(d, { recursive: true, force: true })
  })

  test('a shared chat that copies often: copies for the same people share one group, so the 500 cap never stops copying', () => {
    const id = chat()
    const root = path.join(devenvPaths(base).workShared, id, 'k1')
    for (let i = 0; i < COPIED_GROUPS_MAX + 20; i++) addCopiedIn(base, id, root, { c: ['bob', 'alice'], s: [{ type: 'user', id: `u${i}` }] })
    const g = readCopiedIn(base, id, root)
    expect(g).toHaveLength(1)
    expect(g[0]!.c).toEqual(['alice', 'bob'])
    expect(g[0]!.s).toHaveLength(COPIED_GROUPS_MAX + 20)
    // the same source again adds nothing; other people get a group of their own
    addCopiedIn(base, id, root, { c: ['alice', 'bob'], s: [{ type: 'user', id: 'u0' }] })
    addCopiedIn(base, id, root, { c: ['alice'], s: [{ type: 'user', id: 'u0' }] })
    expect(readCopiedIn(base, id, root).map((x) => x.s.length)).toEqual([COPIED_GROUPS_MAX + 20, 1])
  })
})
