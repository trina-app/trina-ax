// The "Build a plugin" guide (docs/site/develop/plugins.md) stays true: its example skill and description file, copied
// as written, pack into a package that a development server accepts as "Unverified", whose skill loads, and that a
// company server (no community keys) refuses; and the sizes and SHA-256 it lists match the skill it shows.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { checkSkill } from '../../server/src/chat/skills'
import { writeArchive } from '../../server/src/plugins/archive'
import { PackageError, verifyPackage } from '../../server/src/plugins/package'
import { noKeyTrust } from '../lib/plugins'

const ROOT = path.resolve(import.meta.dir, '../..')
const guide = fs.readFileSync(path.join(ROOT, 'docs/site/develop/plugins.md'), 'utf8')
/** fenced blocks in steps are not indented on this site, so a plain match finds them */
const block = (lang: string, has: string) => {
  const b = [...guide.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]!).find((x) => x.includes(has))
  if (!b) throw new Error(`no ${lang} block with ${has}`)
  return b
}
const skill = block('markdown', 'name: meeting-notes')
const manifestText = block('json', '"schemaVersion"')
const manifest = JSON.parse(manifestText) as { id: string; files: { path: string; size: number; sha256: string }[] }
const pack = () => writeArchive({ 'trina-plugin.json': Buffer.from(manifestText), 'skills/meeting-notes/SKILL.md': Buffer.from(skill) }, { gzip: true })

describe('Build a plugin guide', () => {
  test('the listed size and SHA-256 are those of the skill shown', () => {
    expect(manifest.files).toEqual([{ path: 'skills/meeting-notes/SKILL.md', size: Buffer.byteLength(skill), sha256: crypto.createHash('sha256').update(skill).digest('hex') }])
  })

  test('a development server that accepts unsigned packages takes it, and its skill loads', () => {
    const v = verifyPackage(pack(), noKeyTrust('dev', { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' }))
    expect(v.trust).toBe('unverified')
    expect(v.manifest.id).toBe('com.example.meeting-notes')
    expect(checkSkill(v.files.get('skills/meeting-notes/SKILL.md')!.toString('utf8'), `skills/${manifest.id}/meeting-notes/SKILL.md`)).toMatchObject({ ok: true })
  })

  test('a company server refuses it until community publishers can sign, as the guide says', () => {
    for (const trust of [noKeyTrust('selfhost'), noKeyTrust('selfhost', { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' }), noKeyTrust('office', { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1', MYCEL_PLUGINS_TEST_SERVER: '1' })]) {
      expect(() => verifyPackage(pack(), trust)).toThrow(PackageError)
    }
    expect(noKeyTrust('selfhost', { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1', MYCEL_PLUGINS_TEST_SERVER: '1' }).allowUnsigned).toBe(true)
  })

  test('a changed file is refused even on a development server', () => {
    const bad = writeArchive({ 'trina-plugin.json': Buffer.from(manifestText), 'skills/meeting-notes/SKILL.md': Buffer.from(skill + 'x') })
    expect(() => verifyPackage(bad, noKeyTrust('dev', { MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' }))).toThrow(/does not match/)
  })
})
