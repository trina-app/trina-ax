// macOS permission prompts per language: English in mac.extendInfo (the Info.plist base), one InfoPlist.strings per
// language in desktop/build-resources/mac-infoplist/, copied into Contents/Resources/<folder>.lproj.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const desktop = join(import.meta.dir, '../../desktop')
type Mac = { extendInfo: Record<string, unknown>; extraResources: { from: string; to: string }[] }

function strings(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of readFileSync(file, 'utf8').matchAll(/^"(\w+)" = "((?:[^"\\]|\\.)*)";$/gm)) out[m[1]!] = m[2]!
  return out
}

test('every permission prompt is in each language, and English matches the Info.plist base', async () => {
  const mac = ((await import('../../desktop/electron-builder.config')).default as { mac: Mac }).mac
  const prompts = Object.entries(mac.extendInfo).filter(([k]) => k.endsWith('UsageDescription'))
  expect(prompts.length).toBe(5)
  // the base is one language now, not "English / Korean"
  for (const [, v] of prompts) expect(String(v)).not.toMatch(/[가-힣]/)
  expect(mac.extendInfo.CFBundleLocalizations).toEqual(['en', 'ko', 'zh-Hans', 'ja', 'es', 'id'])
  const folders = mac.extraResources.map((r) => r.to)
  for (const f of ['en', 'ko', 'zh-Hans', 'zh_CN', 'ja', 'es', 'es_419', 'id']) expect(folders).toContain(`${f}.lproj/InfoPlist.strings`)
  for (const r of mac.extraResources) {
    const file = join(desktop, r.from)
    expect(existsSync(file), r.from).toBe(true)
    const s = strings(file)
    expect(Object.keys(s).sort(), r.from).toEqual(prompts.map(([k]) => k).sort())
    if (r.from.endsWith('/en.strings')) for (const [k, v] of prompts) expect(s[k]).toBe(String(v))
    if (r.from.endsWith('/zh-Hans.strings')) for (const v of Object.values(s)) expect(v).toMatch(/[一-鿿]/)
    if (r.from.endsWith('/ko.strings')) for (const v of Object.values(s)) expect(v).toMatch(/[가-힣]/)
  }
})
