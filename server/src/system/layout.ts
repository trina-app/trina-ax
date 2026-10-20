// Where the installed server's operational files are (design tab 6 "파일 위치와 제거"). Component G.
//
// Installed (MYCEL_MODE=prod, started by root/bootstrap): <base> = $MYCEL_INSTALL_BASE, else the folder above
// config/server.json, else /Library/Application Support/<id>. The test install uses id mycel-test, so nothing here
// may assume the product id.
// Dev: <base> = the folder holding the data dir (.dev/); there is no app/ (no updates), no root/ (no pf, no sandbox).
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../app-config'
import { PROD_BASE } from '../app-config'

export interface InstallLayout {
  mode: 'dev' | 'prod'
  base: string
  /** app/ with versions/, current, state.json; null in dev */
  appDir: string | null
  rootDir: string | null
  statusDir: string
  /** pf-load's status (root writes it into the root-owned run/ folder; never into a folder the server can write) */
  pfStatusFile: string
  setupDir: string
  secretsDir: string
  dataDir: string
  teamRoot: string
  logDir: string | null
  /** VACUUM INTO copies + backup metadata (data/backups) */
  dbBackupsDir: string
  /** team folder archives (team/.system/backups) */
  teamBackupsDir: string
  /** LaunchDaemon plists (for diagnostics only; the server cannot change them) */
  launchDaemonsDir: string
  /** bundle id prefix of the LaunchDaemons, e.g. app.treesoop.mycel-test */
  label: string | null
}

export function resolveLayout(cfg: AppConfig, env: Record<string, string | undefined> = process.env): InstallLayout {
  const prod = cfg.mode === 'prod'
  const base = prod
    ? env.MYCEL_INSTALL_BASE ?? (cfg.configFile ? path.dirname(path.dirname(cfg.configFile)) : PROD_BASE)
    : path.dirname(cfg.dataDir)
  const appDir = prod ? path.join(base, 'app') : null
  return {
    mode: cfg.mode,
    base,
    appDir: appDir && fs.existsSync(appDir) ? appDir : null,
    rootDir: prod ? path.join(base, 'root') : null,
    statusDir: path.join(base, 'status'),
    pfStatusFile: path.join(base, 'run', 'pf.json'),
    setupDir: path.join(base, 'setup'),
    secretsDir: path.join(base, 'secrets'),
    dataDir: cfg.dataDir,
    teamRoot: cfg.teamRoot,
    logDir: cfg.logDir,
    dbBackupsDir: path.join(cfg.dataDir, 'backups'),
    teamBackupsDir: path.join(cfg.teamRoot, '.system', 'backups'),
    launchDaemonsDir: env.MYCEL_LAUNCHDAEMONS_DIR ?? '/Library/LaunchDaemons',
    label: env.MYCEL_LABEL ?? (prod ? `app.treesoop.${path.basename(base)}` : null),
  }
}

/** Free and total bytes of the volume holding `p` (closest existing parent). */
export function diskSpace(p: string): { free: number; total: number } {
  let dir = p
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir)
  const s = fs.statfsSync(dir)
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }
}
