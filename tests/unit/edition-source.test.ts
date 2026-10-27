// An edition's source link (AGPL-3.0): editions/<name>/branding/source.json applied to SOURCE_CODE by
// scripts/edition-source.ts, and no other user-facing source names the repository.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { editionSource, main, parseEditionSource } from '../../scripts/edition-source'
import { SOURCE_CODE } from '../../shared/src/source'

const ROOT = path.resolve(import.meta.dir, '../..')
const MODULE = fs.readFileSync(path.join(ROOT, 'shared/src/source.ts'), 'utf8')
const good = { repository: 'https://github.com/example/edition', published: true, requestEmail: 'source@example.com' }

describe('edition source link', () => {
  test('applies the three values and nothing else; applying again changes nothing', () => {
    const out = editionSource(MODULE, good)
    expect(out).toContain("  repository: 'https://github.com/example/edition',")
    expect(out).toContain('  published: true,')
    expect(out).toContain("  requestEmail: 'source@example.com',")
    expect(out.split('\n').length).toBe(MODULE.split('\n').length)
    const changed = MODULE.split('\n').filter((l, i) => l !== out.split('\n')[i])
    expect(changed.length).toBeLessThanOrEqual(3)
    expect(editionSource(out, good)).toBe(out)
    // the current values give the module back unchanged
    expect(editionSource(MODULE, { repository: SOURCE_CODE.repository, published: SOURCE_CODE.published, requestEmail: SOURCE_CODE.requestEmail })).toBe(MODULE)
  })

  test('refuses anything that is not one plain repository page, a boolean and one mailbox', () => {
    const bad: Record<string, unknown>[] = [
      { ...good, extra: 1 },
      { repository: good.repository, published: true },
      { ...good, repository: 'http://github.com/example/edition' },
      { ...good, repository: 'https://github.com/example/edition/' },
      { ...good, repository: 'https://github.com/example/edition?x=1' },
      { ...good, repository: "https://github.com/example/ed'ition" },
      { ...good, repository: 'https://user@github.com/example/edition' },
      { ...good, published: 'yes' },
      { ...good, requestEmail: 'a@b.com, c@d.com' },
      { ...good, requestEmail: "a'@example.com" },
      { ...good, requestEmail: 'not-an-email' },
    ]
    for (const b of bad) expect(() => parseEditionSource(b), JSON.stringify(b)).toThrow()
  })

  test('--apply writes shared/src/source.ts in a copy; a check writes nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edition-source-'))
    const out: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    try {
      fs.mkdirSync(path.join(tmp, 'shared/src'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'shared/src/source.ts'), MODULE)
      fs.writeFileSync(path.join(tmp, 'source.json'), JSON.stringify(good))
      process.stdout.write = ((s: string) => { out.push(s); return true }) as typeof process.stdout.write
      main([path.join(tmp, 'source.json')], tmp)
      expect(fs.readFileSync(path.join(tmp, 'shared/src/source.ts'), 'utf8')).toBe(MODULE)
      main([path.join(tmp, 'source.json'), '--apply'], tmp)
      main([path.join(tmp, 'source.json'), '--apply'], tmp)
    } finally { process.stdout.write = write; }
    try {
      expect(out.map((s) => JSON.parse(s).changed)).toEqual([true, true, false])
      expect(fs.readFileSync(path.join(tmp, 'shared/src/source.ts'), 'utf8')).toBe(editionSource(MODULE, good))
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  test("an edition's source.json, when the repository has one, is the one applied", () => {
    const editions = path.join(ROOT, 'editions')
    const files = fs.existsSync(editions)
      ? fs.readdirSync(editions).map((e) => path.join(editions, e, 'branding', 'source.json')).filter((f) => fs.existsSync(f))
      : []
    expect(files.length).toBeLessThanOrEqual(1)
    for (const f of files) {
      const s = parseEditionSource(JSON.parse(fs.readFileSync(f, 'utf8')))
      const applied: Record<string, unknown> = { repository: SOURCE_CODE.repository, published: SOURCE_CODE.published, requestEmail: SOURCE_CODE.requestEmail }
      expect(applied).toEqual(s)
    }
  })

  test('no other user-facing source names the repository (an edition changes only SOURCE_CODE)', () => {
    const hits: string[] = []
    const skip = new Set(['node_modules', 'dist', 'build', '.expo', 'ios', 'android'])
    const walk = (rel: string) => {
      for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = path.join(rel, d.name)
        if (d.isDirectory()) { if (!skip.has(d.name) && !d.name.startsWith('.')) walk(r); continue }
        if (!/\.(ts|tsx|js|mjs|cjs|go|swift)$/.test(d.name) || r === path.join('shared', 'src', 'source.ts')) continue
        if (fs.readFileSync(path.join(ROOT, r), 'utf8').includes(SOURCE_CODE.repository.replace(/^https:\/\//, ''))) hits.push(r)
      }
    }
    for (const top of ['server/src', 'shared/src', 'web/src', 'desktop/src', 'menubar', 'mobile/src', 'relay/src']) if (fs.existsSync(path.join(ROOT, top))) walk(top)
    expect(hits).toEqual([])
  })
})
