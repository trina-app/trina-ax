// Offline entry-page contract: local links/images, role skills, product artifact names.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '../shared/src/product'
import desktopConfig from '../desktop/electron-builder.config'
import { checkSkill, listSkills, skillIssues } from '../server/src/chat/skills'

const ROOT = path.resolve(import.meta.dir, '..')
export const ENTRY = ['README.md', 'README.ko.md', 'README.ja.md', 'README.es.md', 'SUPPORT.md', 'docs/README.md', 'docs/QUICKSTART.md', 'docs/QUICKSTART.ko.md', 'docs/for-teams.md', 'docs/for-teams.ko.md', 'docs/for-admins.md', 'docs/for-admins.ko.md', 'docs/INSTALL-LINUX.md', 'docs/INSTALL-LINUX.en.md', 'docs/OFFICE.md', 'docs/OFFICE.en.md', 'docs/FAQ.md', 'docs/FAQ.ko.md', 'docs/BACKUP-RESTORE.md', 'docs/CONFIGURATION.md', 'docs/TROUBLESHOOTING.md', 'docs/DEVELOPMENT.md', 'examples/README.md', 'examples/README.ko.md']
export function localLinkProblems(file: string, root = ROOT): string[] {
  const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '')
  const problems: string[] = []
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1]!
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const [raw, fragment] = target.split('#')
    const p = decodeURIComponent(raw!)
    const dest = path.resolve(root, path.dirname(file), p)
    if (!fs.existsSync(dest)) problems.push(`${file}: missing ${target}`)
    else if (fragment && dest.endsWith('.md')) {
      const headings = [...fs.readFileSync(dest, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1]!.replace(/<[^>]+>/g, '').replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'))
      if (!headings.includes(decodeURIComponent(fragment))) problems.push(`${file}: missing anchor ${target}`)
    }
  }
  return problems
}
export function checkOnboarding(): string[] {
  const errors = ENTRY.flatMap(file => localLinkProblems(file))
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const documentedOn = readme.includes('Fresh Trina teams allow shared subscriptions by default')
  if (documentedOn !== PRODUCT.sharedSubscriptionsDefault) errors.push('README fresh-team default disagrees with PRODUCT; review defaults and all translations')
  const exRoot = path.join(ROOT, 'examples')
  const names = fs.readdirSync(path.join(exRoot, 'skills')).sort()
  const files = { fx: { root: exRoot, caseInsensitive: false }, rules: () => ({ canList: () => true, access: () => 'read' }) } as unknown as Parameters<typeof listSkills>[0]
  const user = { id: 'fictional-reader' } as Parameters<typeof listSkills>[1]
  for (const name of names) {
    const rel = `skills/${name}/SKILL.md`
    const parsed = checkSkill(fs.readFileSync(path.join(exRoot, rel), 'utf8'), rel)
    if (!parsed.ok) errors.push(`${rel}: ${parsed.problem}`)
  }
  const loaded = listSkills(files, user).map(s => s.name).sort()
  if (JSON.stringify(loaded) !== JSON.stringify(names)) errors.push('Skill discovery did not load every starter')
  for (const issue of skillIssues(files, user)) errors.push(`${issue.path}: loader warning ${issue.problem}`)
  for (const file of ['docs/OFFICE.md','docs/OFFICE.en.md','scripts/office/README.txt']) {
    const text = fs.readFileSync(path.join(ROOT,file),'utf8')
    if (!text.includes(PRODUCT.officeBundle)) errors.push(`${file}: office artifact does not match PRODUCT.officeBundle`)
    const windows = desktopConfig.nsis.artifactName.replace('${version}', '<version>').replace('${arch}', 'x64').replace('${ext}', 'exe')
    if (!text.replaceAll('<버전>', '<version>').includes(windows)) errors.push(`${file}: desktop artifact does not match the actual NSIS release filename`)
  }
  return errors
}
if (import.meta.main) {
  const errors = checkOnboarding()
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log(`Onboarding contracts OK: ${ENTRY.length} entry pages, six discovered skills without loader warnings, release artifact names.`)
}
