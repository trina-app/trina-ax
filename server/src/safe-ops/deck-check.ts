import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runIsolated, isolation } from '../tools/isolate'
import { ToolError } from '../policy/errors'
import type { Deck } from '../tools/pptx-check'
import { officeWorkerScript } from '../files/extract'
let script: Promise<string> | undefined
function workerScript() {
  return (script ??= (async () => {
    const built = path.join(import.meta.dir, 'deck-worker.js')
    if (fs.existsSync(built)) return built
    // In a checkout, background Office indexing may be building its worker at the
    // same time. Bun 1.3.12 can fail concurrent in-process builds. Join that shared
    // build before starting ours; installed bundles already contain both workers.
    await officeWorkerScript()
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
