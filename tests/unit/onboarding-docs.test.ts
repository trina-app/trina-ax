import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkOnboarding, localLinkProblems } from '../../scripts/check-onboarding-docs'

test('published entry paths, product artifact names and actual skill discovery agree', () => {
  expect(checkOnboarding()).toEqual([])
})
test('a missing image fails the offline link contract; external and code examples do not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-doc-links-'))
  try {
    fs.writeFileSync(path.join(root, 'target.md'), '# Existing heading')
    fs.writeFileSync(path.join(root, 'doc.md'), '[Anchor](target.md#missing)\n![Screen](missing.png)\n[Website](https://example.com)\n```md\n[Sample](not-real)\n```')
    expect(localLinkProblems('doc.md', root)).toEqual(['doc.md: missing anchor target.md#missing', 'doc.md: missing missing.png'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('office manifest requires both shipped language guides and release notes keep their path', async () => {
  const { bundleManifest } = await import('../../scripts/build-office')
  const manifest = bundleManifest({ pandoc: true, desktop: false })
  expect(manifest).toContain('app/docs/OFFICE.md')
  expect(manifest).toContain('app/docs/OFFICE.en.md')
  const workflow = fs.readFileSync(path.resolve(import.meta.dir, '../../.github/workflows/release.yml'), 'utf8')
  expect(workflow).toContain('--notes-file in/release-notes/notes.md')
  expect(workflow).toContain('--notes-file notes/notes.md')
})

test('printed manuals retain complete chapters and customer-copy fields', () => {
  for (const [file, chapterCount, markerCount] of [
    ['docs/install/guide.html', 6, 0],
    ['docs/guide/guide.html', 10, 0],
    ['docs/office/guide.html', 8, 35],
    ['docs/office/windows-guide.html', 4, 20],
  ] as const) {
    const html = fs.readFileSync(path.resolve(import.meta.dir, '../..', file), 'utf8')
    const toc = [...html.matchAll(/data-toc="([^"]+)"/g)].map(m => m[1])
    expect(toc.length).toBe(chapterCount)
    for (const id of toc) expect(html).toContain(`id="${id}"`)
    expect([...html.matchAll(/\bdata-k="/g)].length).toBe(markerCount)
    // A chapter shell or a Markdown-link stub is not a usable printed manual.
    const prose = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '')
    expect(prose.length).toBeGreaterThan(6000)
    expect(html).not.toContain('updates.treesoop.com')
  }
  const office = fs.readFileSync(path.resolve(import.meta.dir, '../../docs/office/guide.html'), 'utf8')
  for (const key of ['title', 'team-name', 'boss', 'place', 'sensitive', 'version', 'desktop-version']) {
    expect(office).toContain(`data-k="${key}"`)
  }
})

test('office documentation staging carries full offline runbooks and selected customer PDFs', async () => {
  const { stageOfficeDocs } = await import('../../scripts/build-office')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-office-docs-'))
  try {
    const guide = path.join(root, 'customer-office.pdf'), deskGuide = path.join(root, 'customer-desks.pdf')
    fs.writeFileSync(guide, 'office PDF staging fixture')
    fs.writeFileSync(deskGuide, 'desk PDF staging fixture')
    const stage = path.join(root, 'kit')
    stageOfficeDocs(stage, { guide, deskGuide, teamHost: 'team.fictional.test' })
    for (const file of ['OFFICE.md', 'OFFICE.en.md']) {
      const text = fs.readFileSync(path.join(stage, 'app/docs', file), 'utf8')
      for (const command of ['office-install.sh', 'teamax card', 'restore-archive', 'public-address set', 'update status']) {
        expect(text).toContain(command)
      }
      expect(text.length).toBeGreaterThan(15000)
    }
    expect(fs.readFileSync(path.join(stage, 'app/docs/OFFICE.md'), 'utf8')).toContain('[English](OFFICE.en.md)')
    expect(fs.readFileSync(path.join(stage, 'app/docs/OFFICE.en.md'), 'utf8')).toContain('[한국어](OFFICE.md)')
    const readme = fs.readFileSync(path.join(stage, '설치-먼저-읽기.txt'), 'utf8')
    expect(readme).toContain('customer-office.pdf')
    expect(readme).toContain('customer-desks.pdf')
    expect(readme).toContain('team.fictional.test')
    expect(readme).not.toContain('team.example.com')
    expect(fs.readFileSync(path.join(stage, path.basename(guide)))).toEqual(fs.readFileSync(guide))
    expect(fs.readFileSync(path.join(stage, path.basename(deskGuide)))).toEqual(fs.readFileSync(deskGuide))
    expect(() => stageOfficeDocs(stage, { guide: path.join(root, 'absent.pdf') })).toThrow('--guide')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
