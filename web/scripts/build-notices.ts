// Run after both app and vendor builds so the inventory covers the complete web/dist payload.
import path from 'node:path'
import pkg from '../package.json'
import { reportReleaseNotices, writeReleaseNotices } from '../../scripts/release-notices'

const repoRoot = path.resolve(import.meta.dir, '../..')
reportReleaseNotices(writeReleaseNotices({
  repoRoot,
  artifactDir: path.join(repoRoot, 'web/dist'),
  version: pkg.version,
  target: 'browser',
  arch: 'any',
  kind: 'web',
  includeNative: false,
  roots: [{ directory: 'web' }, { directory: 'web', packages: ['@tailwindcss/browser'] }],
}))
