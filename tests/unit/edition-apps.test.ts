// shared/src/app-downloads.ts and scripts/edition-apps.ts: where an edition's apps are (Settings › Apps).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appAddress, editionApps, main, parseEditionApps } from '../../scripts/edition-apps'
import { APP_DOWNLOADS } from '../../shared/src/app-downloads'

const ROOT = path.resolve(import.meta.dir, '../..')
const MODULE = fs.readFileSync(path.join(ROOT, 'shared/src/app-downloads.ts'), 'utf8')
const acme = {
  page: 'https://acme.example/download',
  iphone: 'https://apps.apple.com/app/acme/id1?platform=iphone',
  android: 'https://play.google.com/store/apps/details?id=example.acme',
  mac: '',
  windows: '',
}

describe('edition apps', () => {
  test('writes exactly the five fields; applying again changes nothing', () => {
    const out = editionApps(MODULE, acme)
    expect(out).toContain("  page: 'https://acme.example/download',")
    expect(out).toContain("  android: 'https://play.google.com/store/apps/details?id=example.acme',")
    expect(out).toContain("  mac: '',")
    expect(out.replace(/'[^'\n]*'/g, "''")).toBe(MODULE.replace(/'[^'\n]*'/g, "''"))
    expect(editionApps(out, acme)).toBe(out)
    expect(editionApps(MODULE, { ...APP_DOWNLOADS })).toBe(MODULE)
  })

  test('an edition with no apps at all is allowed (every field empty)', () => {
    const none = { page: '', iphone: '', android: '', mac: '', windows: '' }
    expect(editionApps(MODULE, none)).toContain("  iphone: '',")
  })

  test('refuses unknown or missing keys and anything but a plain https address', () => {
    expect(() => parseEditionApps({ ...acme, extra: '' })).toThrow()
    const { windows: _, ...four } = acme
    expect(() => parseEditionApps(four)).toThrow()
    for (const bad of [
      'http://acme.example/download', 'https://acme.example/download#top', 'https://user@acme.example/', "https://acme.example/d'own",
      'https://acme.example:8443/download', 'https://acme.example/a b', 'https://acme.example\\download', 'javascript:alert(1)',
      'https://ACME.example/', 'https://localhost/download', 'https://acme.example/\nx', 1, null,
    ]) expect(appAddress(bad), String(bad)).toBe(false)
    for (const good of ['', 'https://acme.example', 'https://acme.example/download', 'https://apps.apple.com/app/x/id1?platform=mac']) expect(appAddress(good), good).toBe(true)
  })

  test('--apply writes shared/src/app-downloads.ts in a copy; a check writes nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edition-apps-'))
    const out: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    try {
      fs.mkdirSync(path.join(tmp, 'shared/src'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'shared/src/app-downloads.ts'), MODULE)
      fs.writeFileSync(path.join(tmp, 'apps.json'), JSON.stringify(acme))
      process.stdout.write = ((s: string) => { out.push(s); return true }) as typeof process.stdout.write
      main([path.join(tmp, 'apps.json')], tmp)
      expect(fs.readFileSync(path.join(tmp, 'shared/src/app-downloads.ts'), 'utf8')).toBe(MODULE)
      main([path.join(tmp, 'apps.json'), '--apply'], tmp)
      main([path.join(tmp, 'apps.json'), '--apply'], tmp)
    } finally { process.stdout.write = write }
    try {
      expect(out.map((s) => JSON.parse(s).changed)).toEqual([true, true, false])
      expect(fs.readFileSync(path.join(tmp, 'shared/src/app-downloads.ts'), 'utf8')).toBe(editionApps(MODULE, acme))
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  test("an edition's apps.json, when the repository has one, is the one applied", () => {
    const editions = path.join(ROOT, 'editions')
    const files = fs.existsSync(editions)
      ? fs.readdirSync(editions).map((e) => path.join(editions, e, 'branding', 'apps.json')).filter((f) => fs.existsSync(f))
      : []
    expect(files.length).toBeLessThanOrEqual(1)
    for (const f of files) expect({ ...APP_DOWNLOADS }).toEqual(parseEditionApps(JSON.parse(fs.readFileSync(f, 'utf8'))))
  })

  test('the apps\' store and download addresses are named only in APP_DOWNLOADS, not in the web app', () => {
    const hits: string[] = []
    const walk = (rel: string) => {
      for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = path.join(rel, d.name)
        if (d.isDirectory()) { walk(r); continue }
        if (!/\.(ts|tsx)$/.test(d.name)) continue
        const text = fs.readFileSync(path.join(ROOT, r), 'utf8')
        if (/apps\.apple\.com|play\.google\.com|ax\.trina\.app\/download/.test(text)) hits.push(r)
      }
    }
    walk('web/src')
    expect(hits).toEqual([])
  })
})
