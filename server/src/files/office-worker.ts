// The office worker: `bun office-worker.js <ext>` reads one file on stdin and writes its text on stdout (`docx-extra` /
// `pptx-extra`: only the parts that pandoc drops, ooxml.ts). extract.ts starts it through the converter isolation (tools/isolate.ts: sandbox-exec / bwrap, the converter cgroup's memory
// cap on Linux, a memory watchdog elsewhere, a time limit, an output cap), so a crafted spreadsheet or Hangul file
// can only take this process down, not the server. The bundles ship it built to one self-contained file next to
// main.js (scripts/build-bundle.ts, scripts/build-office.ts); a dev server builds it on first use.
//
// Protocol: exit 0 = stdout is the text (a write mode, `hwpx-write`: the file's bytes); exit 3 = stderr is a
// ToolError message to show as it is; anything else = the worker failed.
import fs from 'node:fs'
import { EXTRA_MODES, officeText, officeWrite, TOOL_ERROR_EXIT, WORKER_EXT, WRITE_MODES } from './office-parse'
import { ToolError } from '../policy/errors'
import type { SheetAsk } from './sheet-stream'

/**
 * The whole of stdin, read a MiB at a time into one buffer of the size extract.ts gives (INPUT_BYTES), else a growing
 * one. Bun.stdin.arrayBuffer() on a pipe peaked at 570 MB for a 200 MB file (measured 2026-11-18), this at 234 MB.
 */
async function readStdin(size: number): Promise<Uint8Array> {
  let out = Buffer.allocUnsafe(size > 0 ? size : 1 << 20)
  const piece = Buffer.allocUnsafe(1 << 20)
  let at = 0
  for (;;) {
    const n = await new Promise<number>((ok, no) => fs.read(0, piece, 0, piece.length, null, (e, got) => (e ? no(e) : ok(got))))
    if (n === 0) break
    if (at + n > out.length) { const grown = Buffer.allocUnsafe(Math.max(out.length * 2, at + n)); out.copy(grown, 0, 0, at); out = grown }
    piece.copy(out, at, 0, n)
    at += n
  }
  return new Uint8Array(out.buffer, out.byteOffset, at)
}

async function main() {
  const ext = process.argv[2] ?? ''
  if (!WORKER_EXT.has(ext) && !EXTRA_MODES.has(ext) && !WRITE_MODES.has(ext)) { process.stderr.write(`unknown format ${ext}\n`); process.exit(2) }
  // a spreadsheet's sheet and range (read's `sheet` / `range`, extract.ts officeWorkerText), as JSON
  let ask: SheetAsk | undefined
  try { const a = process.argv[3] ? JSON.parse(process.argv[3]) : undefined; if (a && typeof a === 'object') ask = { sheet: typeof a.sheet === 'string' ? a.sheet : undefined, range: typeof a.range === 'string' ? a.range : undefined } } catch {}
  const bytes = await readStdin(Number(process.env.INPUT_BYTES) || 0)
  let out: string | Uint8Array
  try { out = WRITE_MODES.has(ext) ? await officeWrite(ext, bytes) : await officeText(ext, bytes, ask) } catch (e) {
    if (e instanceof ToolError) { process.stderr.write(e.message.slice(0, 1500)); process.exit(TOOL_ERROR_EXIT) }
    process.stderr.write(String((e as Error)?.stack ?? e).slice(0, 2000))
    process.exit(1)
  }
  await Bun.write(Bun.stdout, out)
  process.exit(0)
}

if (import.meta.main) await main()
