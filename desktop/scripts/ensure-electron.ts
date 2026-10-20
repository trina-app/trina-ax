// Bun does not run Electron's postinstall (it is not a trusted dependency), so the Electron binary is fetched here,
// only when the desktop app is built or tested — the rest of the monorepo never downloads it.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export async function ensureElectron(): Promise<string> {
  const require = createRequire(join(import.meta.dir, '..', 'package.json'))
  const pkgDir = dirname(require.resolve('electron/package.json'))
  if (existsSync(join(pkgDir, 'path.txt')) && existsSync(join(pkgDir, 'dist'))) return pkgDir
  const p = Bun.spawn(['node', join(pkgDir, 'install.js')], { cwd: pkgDir, stdout: 'inherit', stderr: 'inherit' })
  if ((await p.exited) !== 0) throw new Error('Electron download failed (node_modules/electron/install.js)')
  return pkgDir
}

if (import.meta.main) await ensureElectron()
