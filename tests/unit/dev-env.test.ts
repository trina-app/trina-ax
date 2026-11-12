// Dev environment: the parts that do not need a runner (cwd, login commands, snapshots, the step label), the purge of
// old rows, and the load order of the modules. box_shell, the queue and the tracker are tested against a fake system
// in dev-env-srt.test.ts and dev-env-queue.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHarness, type Harness } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { diffSnapshots, readInside, skipName, takeSnapshot, SnapshotStore } from '../../server/src/devenv/snapshot'
import { boxCwd, usesCredentials } from '../../server/src/devenv/tool'
import { purgeOldJobs } from '../../server/src/devenv/jobs'
import { stepLabel } from '@mycel/shared'

setDefaultTimeout(40_000)

describe('pure parts', () => {
  test('cwd stays inside the project folder', () => {
    expect(boxCwd(undefined)).toBe('')
    expect(boxCwd('./src/')).toBe('src')
    expect(boxCwd('a/../../etc')).toBeNull()
    expect(boxCwd('/etc')).toBe('etc') // leading slashes are taken off: relative to /work
    expect(boxCwd('a//b')).toBeNull()
  })
  test('commands that can use a login', () => {
    for (const c of ['git push origin main', 'cd x && git pull', 'npm publish', 'ssh host', 'gh pr create', 'docker login']) expect(usesCredentials(c)).toBe(true)
    for (const c of ['git status', 'git commit -m x', 'npm install', 'npm run dev', 'echo github']) expect(usesCredentials(c)).toBe(false)
  })
  test('snapshots skip build output and secrets, catch mtime tricks, see deletes', () => {
    for (const n of ['node_modules', '.git', '.env', '.env.local', 'dist', '.next', '.venv']) expect(skipName(n)).toBe(true)
    expect(skipName('src')).toBe(false)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-snap-'))
    const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t) }
    w('app/a.txt', 'one'); w('app/node_modules/x/i.js', 'x'); w('app/.env', 'SECRET=1'); w('app/dist/o.js', 'o')
    const store = new SnapshotStore(path.join(root, '.store'))
    const s1 = takeSnapshot(root, 'app', null, store)
    expect(Object.keys(s1.files)).toEqual(['app/a.txt'])
    // same size, mtime set back: ctime still differs
    const st = fs.statSync(path.join(root, 'app/a.txt'))
    Bun.sleepSync(20)
    fs.writeFileSync(path.join(root, 'app/a.txt'), 'two'); fs.utimesSync(path.join(root, 'app/a.txt'), st.atime, st.mtime)
    w('app/b.txt', 'b')
    const s2 = takeSnapshot(root, 'app', s1, store)
    expect(diffSnapshots(s1, s2).map((c) => `${c.action} ${c.path}`)).toEqual(['update app/a.txt', 'create app/b.txt'])
    expect(store.blob(s1.files['app/a.txt']!.sha256!)?.toString()).toBe('one')
    // a link the box made to a file outside the folder is never read, also when swapped in for a listed name
    w('secret.db', 'SERVER SECRET')
    fs.symlinkSync(path.join(root, 'secret.db'), path.join(root, 'app/link.txt'))
    fs.mkdirSync(path.join(root, 'outside')); w('outside/x.txt', 'SERVER SECRET 2')
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'app/dirlink'))
    expect(readInside(path.join(root, 'app/link.txt'), path.join(root, 'app'))).toBeNull()
    expect(readInside(path.join(root, 'app/dirlink/x.txt'), path.join(root, 'app'))).toBeNull()
    expect(readInside(path.join(root, 'app/a.txt'), path.join(root, 'app'))?.bytes.toString()).toBe('two')
    const s3 = takeSnapshot(root, 'app', s2, store)
    expect(Object.keys(s3.files).some((k) => k.includes('link'))).toBe(false)
    fs.rmSync(path.join(root, 'app/link.txt')); fs.rmSync(path.join(root, 'app/dirlink'))
    fs.rmSync(path.join(root, 'app/b.txt'))
    expect(diffSnapshots(s2, takeSnapshot(root, 'app', s2, store)).map((c) => `${c.action} ${c.path}`)).toEqual(['delete app/b.txt'])
    fs.rmSync(root, { recursive: true, force: true })
  })
  test('step label', () => {
    expect(stepLabel('box_shell', { command: 'npm install\nnpm test' }, 'en', new Set())).toBe('Dev environment command · npm install')
  })
})

describe('the purge', () => {
  let h: Harness
  beforeAll(async () => { h = await startHarness({ name: 'dev-env-purge' }) })
  afterAll(async () => { await h.close() })
  test('old rows of the removed box runner go, also rows that never ended; newer rows stay', async () => {
    const projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
    const long = new Date(Date.now() - 31 * 86400_000).toISOString(), now = new Date().toISOString()
    const job = h.ctx.db.query('INSERT INTO dev_env_jobs (id, project_id, name, user_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    job.run('old-ended', projectId, 'a', 'alice', long, long)
    job.run('old-open', projectId, 'b', 'alice', long, null)
    job.run('new-open', projectId, 'c', 'alice', now, null)
    const stop = h.ctx.db.query('INSERT INTO dev_env_stops (id, project_id, code, reason, stopped_at) VALUES (?, ?, ?, ?, ?)')
    stop.run('old-stop', projectId, 'disk', '', long)
    stop.run('new-stop', projectId, 'disk', '', now)
    purgeOldJobs(h.ctx.db)
    expect((h.ctx.db.query('SELECT id FROM dev_env_jobs ORDER BY id').all() as { id: string }[]).map((r) => r.id)).toEqual(['new-open'])
    expect((h.ctx.db.query('SELECT id FROM dev_env_stops ORDER BY id').all() as { id: string }[]).map((r) => r.id)).toEqual(['new-stop'])
  })
})

describe('load order', () => {
  // runner.ts and jobs.ts reach each other through a long import chain, and jobs.ts sets the end hook while it loads
  // (srt/end.ts holds it). Loaded runner first, as a single test file can do, nothing may be used before it exists.
  test.each(['srt/runner', 'jobs'])('loading %s first works', (first) => {
    const dir = path.resolve(import.meta.dir, '../../server/src/devenv')
    const code = `await import(${JSON.stringify(path.join(dir, first))}); await import(${JSON.stringify(path.join(dir, 'jobs'))}); console.log('loaded')`
    const p = Bun.spawnSync([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' })
    expect({ code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().slice(0, 500) }).toEqual({ code: 0, out: 'loaded', err: '' })
  })
})
