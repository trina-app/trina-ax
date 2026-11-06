// The office worker: `bun office-worker.js <ext>` reads one file on stdin and writes its text on stdout (`docx-extra` /
// `pptx-extra`: only the parts that pandoc drops, ooxml.ts). extract.ts starts it through the converter isolation (tools/isolate.ts: sandbox-exec / bwrap, the converter cgroup's memory
// cap on Linux, a memory watchdog elsewhere, a time limit, an output cap), so a crafted spreadsheet or Hangul file
// can only take this process down, not the server. The bundles ship it built to one self-contained file next to
// main.js (scripts/build-bundle.ts, scripts/build-office.ts); a dev server builds it on first use.
//
// Protocol: exit 0 = stdout is the text (a write mode, `hwpx-write`: the file's bytes); exit 3 = stderr is a
// ToolError message to show as it is; anything else = the worker failed.
import { EXTRA_MODES, officeText, officeWrite, TOOL_ERROR_EXIT, WORKER_EXT, WRITE_MODES } from './office-parse'
import { ToolError } from '../policy/errors'

async function main() {
  const ext = process.argv[2] ?? ''
  if (!WORKER_EXT.has(ext) && !EXTRA_MODES.has(ext) && !WRITE_MODES.has(ext)) { process.stderr.write(`unknown format ${ext}\n`); process.exit(2) }
  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer())
  let out: string | Uint8Array
  try { out = WRITE_MODES.has(ext) ? officeWrite(ext, bytes) : officeText(ext, bytes) } catch (e) {
    if (e instanceof ToolError) { process.stderr.write(e.message.slice(0, 1500)); process.exit(TOOL_ERROR_EXIT) }
    process.stderr.write(String((e as Error)?.stack ?? e).slice(0, 2000))
    process.exit(1)
  }
  await Bun.write(Bun.stdout, out)
  process.exit(0)
}

if (import.meta.main) await main()
