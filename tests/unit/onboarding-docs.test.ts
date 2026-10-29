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
