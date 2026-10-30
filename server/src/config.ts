import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type AuthMode } from '@mycel/shared'
import { prodBase } from './app-config'

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
  /** mycel-ocr (macOS: PDFKit, ImageIO, Apple Vision): the search index's OCR of scanned PDFs, PDFKit pages and HEIC for AI
   * reads; null on Linux (no OCR there) and when not built */
  ocr: string | null
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

/** a release bundle's own tools (Linux bundle: rg, pandoc, typst, whisper-cli; macOS bundle: bun only): app/<v>/bin next
 * to server/src (linux-runtime spec 3.6.1). Absent in a source checkout. */
const BUNDLE_BIN = path.resolve(import.meta.dir, '..', '..', 'bin')

export function which(name: string, extra: string[] = []): string | null {
  const dirs = [BUNDLE_BIN, ...extra, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', ...(process.env.PATH ?? '').split(':')]
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, name)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
  }
  return null
}

/** The Codex CLI the engine runs (dev / local-login). Shared by admin diagnostics, the launcher allow-list
 * (context.ts) and chat runtime (chat/engines.ts): status must describe the executable the launcher runs. */
/** explicit '' = Codex off (office mode, docs/OFFICE.md): no PATH lookup */
export function findCodexBin(explicit?: string): string | null {
  if (explicit === '') return null
  return explicit ?? which('codex', [path.join(os.homedir(), '.local', 'bin')])
}

/** The macOS engine sandbox profile (design tab 2 "기본 ② 샌드박스"). Dev runs every engine turn under it too. */
export function engineSandboxProfile(): string {
  return path.resolve(import.meta.dir, '..', '..', 'scripts', 'macos', 'engine.sb')
}

/** mycel-ocr next to the other native helpers (native/build.sh builds it on a Mac with swiftc). macOS only: a Linux
 * server runs no OCR at all (docs/DECISIONS.md "AI sees images and PDF pages"; the AI sees images and scanned pages,
 * and those are not text-searchable there, as in Claude Code), even when tesseract happens to be installed. */
export function ocrBin(): string | null {
  if (process.platform !== 'darwin') return null
  const p = path.join(nativeBinDir(), 'mycel-ocr')
  return fs.existsSync(p) ? p : null
}

export function nativeBinDir(): string {
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (process.env.MYCEL_NATIVE_BIN) return process.env.MYCEL_NATIVE_BIN
  // release bundle (scripts/build-bundle.ts): app/<version>/native/{mycel-gate,mycel-bridge} next to server/src/main.js
  const bundled = path.resolve(import.meta.dir, '..', '..', 'native')
  if (fs.existsSync(path.join(bundled, 'mycel-gate'))) return bundled
  return path.resolve(import.meta.dir, '..', '..', 'native', 'bin', `${plat}-${arch}`)
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
    ocr: ocrBin(),
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
  /** macOS /Library/Application Support/<id>, Linux /var/lib/<id> (app-config.ts prodBase) */
  base: prodBase(),
} as const
