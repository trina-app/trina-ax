// Text for read/grep. Office formats: pandoc (docx/pptx/odt), SheetJS (xlsx/xls/ods), pdftotext (pdf), hwp.ts (hwp/hwpx).
// Scanned PDFs and images: mycel-ocr (native/ocr, Apple Vision, macOS) when it is built.
// Input bytes always come from an fd opened with O_NOFOLLOW and checked (nlink==1), and are fed to the
// converters on stdin, so a converter never opens a path itself. Converters run isolated (tools/isolate.ts:
// sandbox-exec on macOS, bwrap on Linux): no network, no reading of the team folder or server data.
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { hwpText, hwpxText } from './hwp'
import { runIsolated } from '../tools/isolate'

export const OFFICE_EXT = ['docx', 'pptx', 'odt', 'xlsx', 'xls', 'ods', 'pdf', 'hwp', 'hwpx'] as const
export const isOffice = (name: string) => OFFICE_EXT.includes(ext(name) as any)
export const ext = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase()

export interface Tools { pandoc: string | null; pdftotext: string | null; ocr?: string | null }

/** Images the OCR tool reads (read only; grep's text cache keeps to documents, an image folder would mean minutes). */
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'gif', 'webp'] as const
const OCR_PAGES_MAX = 100

/** pdftotext's text of a scanned PDF: some page (pages end with a form feed) has next to no text. */
export function looksScanned(text: string): boolean {
  const pages = text.split('\f')
  if (pages.length > 1 && pages[pages.length - 1]!.trim() === '') pages.pop()
  return pages.some((p) => p.replace(/\s/g, '').length < 20)
}

/** Recognized text (PDF pages without a text layer, or an image); about a second per page. */
function ocr(bin: string, bytes: Uint8Array, pdf: boolean): Promise<string> {
  return pipeThrough([bin, '--max-pages', String(OCR_PAGES_MAX)], bytes, pdf ? 240_000 : 30_000)
}

async function pipeThrough(cmd: string[], input: Uint8Array, timeoutMs = 20000): Promise<string> {
  const r = await runIsolated({ cmd: cmd[0]!, args: cmd.slice(1), stdin: input, timeoutMs, maxStdout: 32 * 1024 * 1024, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } })
  const name = cmd[0]!.split('/').pop()
  if (r.killed === 'timeout') throw new ToolError(`could not convert the file to text (${name}: took too long)`)
  if (r.code !== 0) throw new ToolError(`could not convert the file to text (${name}: ${r.stderr.trim().slice(0, 200) || 'exit ' + r.code})`)
  return r.stdout.toString('utf8')
}

export async function extractText(name: string, bytes: Uint8Array, tools: Tools): Promise<string> {
  const e = ext(name)
  switch (e) {
    case 'docx': case 'pptx': case 'odt':
      if (!tools.pandoc) throw new ToolError('pandoc is not installed on the server')
      return pipeThrough([tools.pandoc, '--sandbox', '-f', e, '-t', 'plain', '--wrap=none'], bytes)
    case 'xlsx': case 'xls': case 'ods': {
      const wb = XLSX.read(bytes, { type: 'array', cellFormula: false, cellHTML: false })
      return wb.SheetNames.map((s) => `# sheet: ${s} (tab-separated)\n` + XLSX.utils.sheet_to_csv(wb.Sheets[s], { FS: '\t', blankrows: false })).join('\n\n')
    }
    case 'hwp':
      return hwpText(bytes)
    case 'hwpx':
      return hwpxText(bytes)
    case 'pdf': {
      if (!tools.pdftotext && !tools.ocr) throw new ToolError('pdftotext is not installed on the server')
      if (tools.pdftotext) {
        const text = await pipeThrough([tools.pdftotext, '-layout', '-enc', 'UTF-8', '-', '-'], bytes)
        // a scanned page (no text layer): OCR, which keeps the text layer of the other pages
        if (!tools.ocr || !looksScanned(text)) return text
      }
      return ocr(tools.ocr!, bytes, true)
    }
    default: {
      if (tools.ocr && (IMAGE_EXT as readonly string[]).includes(e)) return ocr(tools.ocr, bytes, false)
      const head = bytes.subarray(0, 8000)
      if (head.includes(0)) throw new ToolError('this is a binary file; it cannot be shown as text')
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}
