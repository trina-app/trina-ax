import { test, expect, spyOn } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { makeCApp } from '../lib/c-app'
import { SearchAdmission } from '../../server/src/files/search-admission'
import { SemanticIndex } from '../../server/src/search/semantic'
import { sha256 } from '../../server/src/files/store'

const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

test('R2-1: another user, text/image copies and CP949 never enter real raw rg output', async () => {
  const a = await makeCApp('search-admission-copies')
  const marker = 'QUARANTINED_SEARCH_BYTES'
  // Valid CP949 Korean with ASCII marker, so both passes can expose it.
  const bad = Buffer.concat([Buffer.from(marker + ' '), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])])
  a.ctx.files.quarantine.add(bad, 'image')
  for (const n of ['original.jpg', 'copy.txt', 'renamed.png']) fs.writeFileSync(path.join(a.team, 'shared', n), bad)
  fs.writeFileSync(path.join(a.team, 'shared/normal.txt'), 'ordinary search result')
  const log = path.join(a.data, 'raw.log'), wrapper = path.join(a.data, 'rg')
  fs.writeFileSync(wrapper, `#!/bin/sh\n${shell(a.ctx.files.cfg.rg!)} "$@" | tee -a ${shell(log)}\n`, { mode: 0o700 })
  a.ctx.files.cfg.rg = wrapper
  delete process.env.MYCEL_SAFE_OPS_1A
  try {
    const result = await a.ctx.files.grep(a.toolCtx('bob'), { pattern: marker + '|ordinary|한글', path: 'shared', output_mode: 'content' })
    expect(result.text).toContain('ordinary')
    expect(result.text).not.toContain(marker)
    expect(fs.readFileSync(log, 'utf8')).not.toContain(marker)
    expect(a.ctx.db.query('SELECT * FROM safe_ops_search_inputs').all()).toEqual([])
  } finally { await a.close() }
})

test('R2-1: publication/copy/rename/replacement during BOTH passes cannot change frozen inputs', async () => {
  const a = await makeCApp('search-admission-races')
  const bad = Buffer.from('RACE_QUARANTINED'), good = 'RACE_ALLOWED'
  a.ctx.files.quarantine.add(bad, 'pptx')
  const original = path.join(a.team, 'shared/normal.txt')
  fs.writeFileSync(original, good)
  const spawn = Bun.spawn.bind(Bun)
  let passes = 0
  const spy = spyOn(Bun, 'spawn').mockImplementation(((argv: string[], opts: any) => {
    if (argv[0] === a.ctx.files.cfg.rg && !argv.includes('--files') && !argv.includes('*.txt')) {
      passes++
      expect(opts.cwd).not.toBe(a.team)
      expect(fs.readFileSync(path.join(opts.cwd, 'shared/normal.txt'), 'utf8')).toBe(good)
      // Independent local writer operates after admission but before rg opens.
      const writer = Bun.spawnSync(['/bin/sh', '-c', 'cp "$1" "$2"; mv "$2" "$3"; cp "$1" "$4"; cp "$1" "$5"', 'race',
        path.join(a.data, 'bad'), original + '.tmp', original, path.join(a.team, 'shared/copy.png'), path.join(a.team, 'shared/published.txt')])
      expect(writer.exitCode).toBe(0)
    }
    return spawn(argv, opts)
  }) as typeof Bun.spawn)
  fs.writeFileSync(path.join(a.data, 'bad'), bad)
  try {
    const result = await a.ctx.files.grep(a.toolCtx('bob'), { pattern: 'RACE_', path: 'shared', output_mode: 'content' })
    expect(result.text).not.toContain('QUARANTINED')
    expect(passes).toBe(2)
  } finally { spy.mockRestore(); await a.close() }
})

test('R2-1: DB connections serialize hash admission and quarantine; no TTL releases a live consumer', async () => {
  const a = await makeCApp('search-admission-registration')
  const q = a.ctx.files.quarantine, admission = new SearchAdmission(q)
  const bytes = Buffer.from('normal bytes being consumed')
  const other = new Database(path.join(a.data, 'app.db'))
  try {
    expect(admission.hold(bytes)).toBe(true)
    expect(() => other.query('INSERT INTO safe_ops_artifacts(hash,size,kind) VALUES(?,?,?)').run(sha256(bytes), bytes.length, 'image')).toThrow('safe_ops_search_busy')
    expect(() => q.add(bytes, 'image')).toThrow('active search')
    admission.close()
    q.add(bytes, 'image')
    expect(admission.hold(bytes)).toBe(false)
    expect(() => other.query('INSERT INTO safe_ops_search_inputs VALUES(?,?,?)').run('other', sha256(bytes), process.pid)).toThrow('safe_ops_quarantined')
  } finally { admission.close(); other.close(); await a.close() }
})

test('R2-1: descriptor identity and version reject replacement during broker read', async () => {
  const a = await makeCApp('search-admission-open-race')
  const admission = new SearchAdmission(a.ctx.files.quarantine)
  const abs = path.join(a.team, 'shared/race.txt')
  fs.writeFileSync(abs, 'original')
  let calls = 0
  try {
    expect(admission.read(abs, () => {
      const st = fs.lstatSync(abs)
      if (++calls === 1) { fs.unlinkSync(abs); fs.writeFileSync(abs, 'replacement') }
      return st
    })).toBeNull()
  } finally { admission.close(); await a.close() }
})

test('R2-3: semantic embedding holds its admitted bytes until the async consumer ends', async () => {
  const a = await makeCApp('search-admission-semantic')
  const text = 'unique semantic text being consumed asynchronously'
  const abs = path.join(a.team, 'shared/semantic.txt')
  fs.writeFileSync(abs, text)
  let consumed = false
  const index = new SemanticIndex({ dataDir: a.data, root: a.team, office: a.ctx.files.office, quarantine: a.ctx.files.quarantine,
    embedder: async () => async (texts, kind) => {
      if (kind === 'passage' && texts.some(t => t.includes(text))) {
        consumed = true
        expect(() => a.ctx.files.quarantine.add(Buffer.from(text), 'pptx')).toThrow('active search')
        await Bun.sleep(5)
      }
      return texts.map(() => new Float32Array(384))
    } })
  try {
    await index.refresh(30_000)
    expect(consumed).toBe(true)
    a.ctx.files.quarantine.add(Buffer.from(text), 'pptx')
    fs.copyFileSync(abs, path.join(a.team, 'shared/copy.txt'))
    expect((await index.query('query', () => true))!.some(h => h.text.includes(text))).toBe(false)
    fs.writeFileSync(abs, 'replacement ordinary text')
    // The retained source hash blocks the old chunks even after path replacement.
    expect((await index.query('query', () => true))!.some(h => h.text.includes(text))).toBe(false)
    fs.writeFileSync(abs, text)
    consumed = false
    await index.refresh(30_000)
    expect(consumed).toBe(false)
    expect(index.db.query("SELECT * FROM chunks WHERE path IN ('shared/semantic.txt','shared/copy.txt')").all()).toEqual([])
  } finally { index.db.close(); await a.close() }
})
