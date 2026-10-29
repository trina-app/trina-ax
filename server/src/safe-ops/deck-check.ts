import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runIsolated, isolation } from '../tools/isolate'
import { ToolError } from '../policy/errors'
import type { Deck } from '../tools/pptx-check'
let script: Promise<string> | undefined
function workerScript() {
  return (script ??= (async () => {
    const built = path.join(import.meta.dir, 'deck-worker.js')
    if (fs.existsSync(built)) return built
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-deck-'))
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
    const b = await Bun.build({
      entrypoints: [path.join(import.meta.dir, 'deck-worker.ts')],
      target: 'bun',
      outdir: dir,
      naming: 'deck-worker.js',
    })
    if (!b.success) throw new Error('deck worker build failed')
    return path.join(dir, 'deck-worker.js')
  })())
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
