import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runIsolated, isolation } from '../tools/isolate'
import { ToolError } from '../policy/errors'
import type { Deck } from '../tools/pptx-check'
import { execFileSync } from 'node:child_process'
let script: Promise<string> | undefined
function workerScript() {
  return (script ??= (async () => {
    const built = path.join(import.meta.dir, 'deck-worker.js')
    if (fs.existsSync(built)) return built
    // Checkout-only compilation of trusted, bundled source. A second in-process
    // Bun 1.3.12 build can fail after Office indexing built its worker, even when
    // serialized. Keep the compiler in a separate short-lived process. Installed
    // bundles already contain this script. No document bytes enter the compiler.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-deck-'))
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
    execFileSync(process.execPath, [
      'build', path.join(import.meta.dir, 'deck-worker.ts'), '--target=bun', '--outfile', path.join(dir, 'deck-worker.js'),
    ], {
      timeout: 30_000, maxBuffer: 64 * 1024,
      env: { PATH: '/usr/bin:/bin', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return path.join(dir, 'deck-worker.js')
  })().catch((e) => { script = undefined; throw e }))
}
export async function readDeckIsolated(bytes: Uint8Array, signal?: AbortSignal): Promise<Deck> {
  if (bytes.length > 32 * 1024 ** 2 || isolation() === 'none')
    throw new ToolError('PowerPoint validation is unavailable')
  const script = await workerScript()
  const r = await runIsolated({
    cmd: process.execPath,
    args: ['--smol', '--no-env-file', script],
    readPaths: [path.dirname(script)],
    stdin: bytes,
    timeoutMs: 20_000,
    maxStdout: 64 * 1024,
    maxRssMiB: 512,
    maxWorkBytes: 32 * 1024 ** 2,
    signal,
    env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  })
  signal?.throwIfAborted()
  if (r.code !== 0 || r.killed) throw new ToolError('PowerPoint validation failed; nothing was saved')
  return JSON.parse(r.stdout.toString())
}
