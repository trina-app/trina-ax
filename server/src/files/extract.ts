// Text for read/grep. Office formats: pandoc (docx/pptx/odt; the office worker adds the docx headers, footers and
// comments and the pptx speaker notes and chart data that pandoc drops, ooxml.ts), SheetJS (xlsx/xls/ods) and hwp.ts (hwp/hwpx) in the office
// worker (office-worker.ts, a bun child process), pdftotext (pdf).
// Plain text: UTF-8, else legacy Korean (CP949 / EUC-KR, the Korean Excel CSV default) when it decodes cleanly.
// Scanned PDFs: mycel-ocr (native/ocr, Apple Vision) on macOS only, for the search index (grep text cache, semantic search)
// and the read fallback when a team turned image viewing off. Linux has no OCR. An AI read of an image or a scanned page
// gives the model the image instead (files/vision.ts).
// Input bytes always come from an fd opened with O_NOFOLLOW and checked (nlink==1), and are fed to the
// converters on stdin, so a converter never opens a path itself. Converters run isolated (tools/isolate.ts:
// sandbox-exec on macOS, bwrap on Linux): no network, no reading of the team folder or server data.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cp949Text } from '@mycel/shared/text-encoding'
import { ToolError } from '../policy/errors'
import { runIsolated } from '../tools/isolate'
import { inProcessParseMax } from '../system/limits'
import { OFFICE_TEXT_MAX, TOOL_ERROR_EXIT, WORKER_EXT } from './office-parse'
import { tooComplex } from './zip-guard'
import { quoteLines, SECTION_MARK } from './ooxml'

export const OFFICE_EXT = ['docx', 'pptx', 'odt', 'xlsx', 'xls', 'ods', 'pdf', 'hwp', 'hwpx'] as const
export const isOffice = (name: string) => OFFICE_EXT.includes(ext(name) as any)
export const ext = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase()

export interface Tools {
  pandoc: string | null; pdftotext: string | null; ocr?: string | null; quarantine?: { assertBytes(bytes: Uint8Array): void }
  /** a read for the AI (drive_read): never OCR. A PDF gives its text layer only (pdftotext, else PDFKit through
   * `mycel-ocr --layer` on a Mac without poppler); an image is no text at all (the caller shows it as an image). */
  textLayerOnly?: boolean
}

/** Images the macOS OCR tool reads (only for a read when image viewing is off: grep's text cache keeps to documents, an
 * image folder would mean minutes). */
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'gif', 'webp'] as const
/** pages recognized per PDF (Apple Vision, about a second per page, within the 240 s below) */
const OCR_PAGES_MAX = 100

/** pdftotext's text of a scanned PDF: some page (pages end with a form feed) has next to no text. */
export function looksScanned(text: string): boolean {
  const pages = text.split('\f')
  if (pages.length > 1 && pages[pages.length - 1]!.trim() === '') pages.pop()
  return pages.some((p) => p.replace(/\s/g, '').length < 20)
}

/** Recognized text (PDF pages without a text layer, or an image); about a second per page. */
function ocr(bin: string, bytes: Uint8Array, pdf: boolean, signal?: AbortSignal): Promise<string> {
  return pipeThrough([bin, '--max-pages', String(OCR_PAGES_MAX)], bytes, pdf ? 240_000 : 30_000, signal)
}

async function pipeThrough(cmd: string[], input: Uint8Array, timeoutMs = 20000, signal?: AbortSignal): Promise<string> {
  const r = await runIsolated({ cmd: cmd[0]!, args: cmd.slice(1), stdin: input, timeoutMs, signal, maxStdout: 32 * 1024 * 1024, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } })
  const name = cmd[0]!.split('/').pop()
  if (r.killed === 'timeout') throw new ToolError(`could not convert the file to text (${name}: took too long)`)
  if (r.code !== 0) throw new ToolError(`could not convert the file to text (${name}: ${r.stderr.trim().slice(0, 200) || 'exit ' + r.code})`)
  return r.stdout.toString('utf8')
}

/** formats parsed by the office worker (pure TypeScript parsers, never in the server process); capped where the
 * limits apply (the name stays from when they ran in-process) */
export const IN_PROCESS_EXT = WORKER_EXT
export const TOO_BIG_IN_PROCESS = 'too large to read as text (over 32 MB); download it to look at it'

/** the office worker's limits: wall clock, resident memory (where no converter cgroup applies; the cgroup's memory.max
 * applies on production Linux as well), workers at the same time (the rest wait) */
export const OFFICE_WORKER_TIMEOUT_MS = 60_000
export const OFFICE_WORKER_RSS_MIB = 2048
const OFFICE_WORKERS_MAX = 2

/** The worker script: built next to main.js in the bundles; in a repository checkout built once per process from the
 * TypeScript source into a private temp folder. The isolation lets the worker read that folder (bun reads the
 * script's folder, not only the file): the bundle's server/src holds only the built server files. */
let workerScript: Promise<string> | null = null
export function officeWorkerScript(): Promise<string> {
  return (workerScript ??= (async () => {
    const built = path.join(import.meta.dir, 'office-worker.js')
    if (fs.existsSync(built)) return fs.realpathSync(built)
    const src = path.join(import.meta.dir, 'office-worker.ts')
    if (!fs.existsSync(src)) throw new Error('office-worker.js is missing next to the server files')
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-worker-')))
    process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
    const res = await Bun.build({ entrypoints: [src], target: 'bun', outdir: dir, naming: 'office-worker.js', minify: false })
    if (!res.success) throw new Error('office worker build failed: ' + res.logs.map(String).join('\n'))
    return path.join(dir, 'office-worker.js')
  })().catch((e) => { workerScript = null; throw e }))
}

let running = 0
const waiting: (() => void)[] = []
/** At most OFFICE_WORKERS_MAX workers; a finished one hands its slot straight to the next waiting caller. */
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (running >= OFFICE_WORKERS_MAX) await new Promise<void>((r) => waiting.push(r))
  else running++
  try { return await f() } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

/** A spreadsheet or Hangul file's text (or the extra parts of a .docx / .pptx: mode `docx-extra` / `pptx-extra`) from
 * the office worker, isolated like the other converters. */
export async function officeWorkerText(e: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  const script = await officeWorkerScript()
  return slot(async () => {
    signal?.throwIfAborted()
    const r = await runIsolated({
      cmd: process.execPath, args: ['--smol', '--no-env-file', script, e], stdin: bytes, readPaths: [path.dirname(script)],
      timeoutMs: OFFICE_WORKER_TIMEOUT_MS, maxStdout: OFFICE_TEXT_MAX + 1024 * 1024, maxRssMiB: OFFICE_WORKER_RSS_MIB, signal,
      env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', NO_COLOR: '1' },
    })
    if (r.killed === 'aborted') signal?.throwIfAborted()
    if (r.killed === 'timeout') throw tooComplex(`reading it took longer than ${OFFICE_WORKER_TIMEOUT_MS / 1000} s`)
    if (r.killed === 'memory') throw tooComplex(`reading it needed more than ${OFFICE_WORKER_RSS_MIB} MB of memory`)
    if (r.killed === 'output') throw tooComplex(`more than ${OFFICE_TEXT_MAX / 1024 / 1024} MB of text`)
    if (r.code === TOOL_ERROR_EXIT) throw new ToolError(r.stderr.trim().slice(0, 500))
    // killed by the converter cgroup (memory.max) or a CPU rlimit: a signal, no exit code
    if (r.code === null || r.code >= 128) throw tooComplex('the reader ran out of memory or time')
    if (r.code !== 0) throw new ToolError(`could not convert the file to text (office reader: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'exit ' + r.code})`)
    return r.stdout.toString('utf8')
  })
}

export async function extractText(name: string, bytes: Uint8Array, tools: Tools, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  tools.quarantine?.assertBytes(bytes)
  const e = ext(name)
  // a spreadsheet or Hangul file expands many times in memory: refused above 32 MB where limits apply (Linux, a plan;
  // system/limits.ts) before a worker starts; smaller ones still meet the worker's own limits
  if (IN_PROCESS_EXT.has(e) && bytes.byteLength > inProcessParseMax()) throw new ToolError(TOO_BIG_IN_PROCESS)
  switch (e) {
    case 'docx': case 'pptx': case 'odt': {
      if (!tools.pandoc) throw new ToolError('pandoc is not installed on the server')
      // a body line that starts like a section label (`=== `) gets a space in front, so only the real labels of the
      // extra text below are at the start of a line
      const body = pipeThrough([tools.pandoc, '--sandbox', '-f', e, '-t', 'plain', '--wrap=none'], bytes, 20_000, signal).then(quoteLines)
      if (e === 'odt') return body
      const [text, extra] = await Promise.all([body, extraText(e, bytes, signal)])
      return extra ? `${text.trimEnd()}\n\n${extra}\n` : text
    }
    case 'xlsx': case 'xls': case 'ods': case 'hwp': case 'hwpx':
      return officeWorkerText(e, bytes, signal)
    case 'pdf': {
      if (!tools.pdftotext && !tools.ocr) throw new ToolError('pdftotext is not installed on the server')
      if (tools.textLayerOnly) {
        if (tools.pdftotext) return pipeThrough([tools.pdftotext, '-layout', '-enc', 'UTF-8', '-', '-'], bytes, 20_000, signal)
        return pipeThrough([tools.ocr!, '--layer'], bytes, 20_000, signal)
      }
      if (tools.pdftotext) {
        const text = await pipeThrough([tools.pdftotext, '-layout', '-enc', 'UTF-8', '-', '-'], bytes, 20_000, signal)
        // a scanned page (no text layer): OCR, which keeps the text layer of the other pages
        if (!tools.ocr || !looksScanned(text)) return text
      }
      return ocr(tools.ocr!, bytes, true, signal)
    }
    default: {
      if (tools.ocr && !tools.textLayerOnly && (IMAGE_EXT as readonly string[]).includes(e)) return ocr(tools.ocr, bytes, false, signal)
      const head = bytes.subarray(0, 8000)
      if (head.includes(0)) throw new ToolError('this is a binary file; it cannot be shown as text')
      return decodeText(bytes)
    }
  }
}

const EXTRA_WHAT = { docx: 'headers, footers and comments', pptx: 'speaker notes and chart data' } as const

/**
 * The parts of a .docx / .pptx that pandoc drops, from the office worker. When they cannot be read, a labelled line
 * says so (the AI must not guess them); pandoc's body text is still given. Under the same size limit as the other
 * worker formats.
 */
async function extraText(e: 'docx' | 'pptx', bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  const notRead = (why: string) => `${SECTION_MARK}The ${EXTRA_WHAT[e]} of this file were not read (${why}) ===`
  if (bytes.byteLength > inProcessParseMax()) return notRead('the file is over 32 MB')
  try { return (await officeWorkerText(`${e}-extra`, bytes, signal)).trim() } catch (err) {
    signal?.throwIfAborted()
    return notRead(err instanceof ToolError ? err.message.slice(0, 300) : 'the reader failed')
  }
}

/**
 * Text of a plain text file: UTF-8 (a BOM is dropped) when the bytes are valid UTF-8. Otherwise legacy Korean
 * (CP949, a superset of EUC-KR) when the bytes are clearly Korean (shared `cp949Text`: no decode error, no Windows-1252
 * punctuation pair, at least 2 Hangul syllables, at least 80% of the non-ASCII characters are Hangul syllables, at
 * least 90% of the syllables are KS X 1001 pairs, no Hanja). Otherwise UTF-8 with
 * replacement characters, as before, so a Windows-1252 file does not become false Korean text.
 */
export function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {}
  return cp949Text(bytes) ?? new TextDecoder('utf-8').decode(bytes)
}
