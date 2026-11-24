// The document skills (resources/doc-skills: Anthropic's docx, pptx, xlsx and pdf, Apache-2.0; docs/decisions/
// 20261124-doc-skills.md) in a run. They are part of the program, not of a team: nothing is added to a team's folder or
// skill list (docs/DECISIONS.md "DS3"). The server copies exactly the files SOURCE.json lists, each checked by its
// sha256, into a version folder in its bin folder, which a run can read and not change, and points a link at it.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { bundledDocSkillsDir } from '../config'
import { BOX_PYTHON_BIN, DOC_SKILLS_DIR, type DevPlatform } from './srt/config'
import { docKit } from './kit'
import { documentsOnlyServer } from './setting'

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const inside = (rel: string) => !path.isAbsolute(rel) && !rel.split('/').includes('..')

/** Can a run on this server use them? Linux with the box's Python libraries; an office Mac with its document kit
 * (devenv/kit.ts, the documents profile); a Mac team server's run has no libraries so far. */
export function docSkillsReady(platform: DevPlatform | NodeJS.Platform = process.platform, python: string = BOX_PYTHON_BIN): boolean {
  if (!bundledDocSkillsDir()) return false
  if (platform === 'darwin') return documentsOnlyServer() && docKit() !== null
  if (platform !== 'linux') return false
  try { return fs.statSync(python).isDirectory() } catch { return false }
}

/** Puts the skills under `bin` (idempotent; two runs at once each finish with the same link). */
export function writeDocSkills(bin: string, src: string | null = bundledDocSkillsDir()): boolean {
  if (!src) return false
  const manifest = fs.readFileSync(path.join(src, 'SOURCE.json'))
  const version = `.${DOC_SKILLS_DIR}-${sha256(manifest).slice(0, 12)}`
  const link = path.join(bin, DOC_SKILLS_DIR), target = path.join(bin, version)
  if (fs.existsSync(path.join(target, 'SOURCE.json'))) {
    try { if (fs.readlinkSync(link) === version) return true } catch { /* no link yet */ }
  } else {
    const { files } = JSON.parse(manifest.toString('utf8')) as { files: Record<string, string> }
    const tmp = fs.mkdtempSync(path.join(bin, `.${DOC_SKILLS_DIR}-new-`))
    try {
      for (const [rel, want] of Object.entries(files)) {
        if (!inside(rel)) throw new Error(`doc skills: bad path ${rel}`)
        const data = fs.readFileSync(path.join(src, rel))
        if (sha256(data) !== want) throw new Error(`doc skills: ${rel} is not the file SOURCE.json lists`)
        const out = path.join(tmp, rel)
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o755 })
        fs.writeFileSync(out, data, { mode: 0o644 })
      }
      fs.writeFileSync(path.join(tmp, 'SOURCE.json'), manifest, { mode: 0o644 })
      fs.chmodSync(tmp, 0o755)
      try { fs.renameSync(tmp, target) } catch (e) { if (!fs.existsSync(path.join(target, 'SOURCE.json'))) throw e; fs.rmSync(tmp, { recursive: true, force: true }) }
    } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e }
  }
  const next = `${link}.${process.pid}.${crypto.randomBytes(3).toString('hex')}`
  fs.symlinkSync(version, next)
  fs.renameSync(next, link)
  for (const e of fs.readdirSync(bin)) if (e.startsWith(`.${DOC_SKILLS_DIR}-`) && !e.startsWith(`.${DOC_SKILLS_DIR}-new-`) && e !== version) fs.rmSync(path.join(bin, e), { recursive: true, force: true })
  return true
}
