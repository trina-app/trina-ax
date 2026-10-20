import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT, type AuthMode } from '@mycel/shared'

export interface ServerConfig {
  /** team folder (resolved real path). Only the server touches it. */
  teamRoot: string
  /** server-private data: app.db, sessions/, textcache/, history is inside the team folder's .system/ */
  dataDir: string
  /** sockets: <runDir>/tools.sock (engine side, via gate), <runDir>/private/server.sock (gate -> server only) */
  runDir: string
  /** per-chat empty working folders for the engine */
  agentRoot: string
  /** uid allowed on tools.sock (the engine account). Stage 1: the current user. */
  agentUid: number
  rg: string
  pandoc: string | null
  pdftotext: string | null
  /** folder with mycel-gate / mycel-bridge / mycel-launcher for this platform */
  nativeBin: string
  claudeBin: string
  authMode: AuthMode
  /** grep limits */
  grepTimeoutMs: number
  /** per-turn write limits (disk-fill protection) */
  maxWriteBytesPerTurn: number
  maxFilesWrittenPerTurn: number
}

export function which(name: string, extra: string[] = []): string | null {
  const dirs = [...extra, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', ...(process.env.PATH ?? '').split(':')]
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, name)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
  }
  return null
}

export function nativeBinDir(): string {
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return process.env.MYCEL_NATIVE_BIN ?? path.resolve(import.meta.dir, '..', '..', 'native', 'bin', `${plat}-${arch}`)
}

export function defaultConfig(over: Partial<ServerConfig> & { teamRoot: string; dataDir: string }): ServerConfig {
  const runDir = over.runDir ?? path.join(over.dataDir, 'run')
  return {
    runDir,
    agentRoot: path.join(over.dataDir, 'agent'),
    agentUid: process.getuid?.() ?? 0,
    rg: which('rg') ?? 'rg',
    pandoc: which('pandoc'),
    pdftotext: which('pdftotext'),
    nativeBin: nativeBinDir(),
    claudeBin: which('claude', [path.join(os.homedir(), '.local', 'bin')]) ?? 'claude',
    authMode: 'local-login',
    grepTimeoutMs: 15000,
    maxWriteBytesPerTurn: 50 * 1024 * 1024,
    maxFilesWrittenPerTurn: 200,
    ...over,
    teamRoot: fs.realpathSync(over.teamRoot),
  }
}

/** Production layout (design tab 6). Stage 3 installer creates these with the right owners.
 * Folder names use the machine id, not the display name (no spaces, survives a rename of the display name). */
export const PROD_LAYOUT = {
  base: `/Library/Application Support/${PRODUCT.id}`,
} as const
