// Text for read/grep. Office formats: pandoc (docx/pptx/odt), SheetJS (xlsx/xls/ods), pdftotext (pdf).
// Input bytes always come from an fd opened with O_NOFOLLOW and checked (nlink==1), and are fed to the
// converters on stdin, so a converter never opens a path itself. Converters run isolated (tools/isolate.ts:
// sandbox-exec on macOS, bwrap on Linux): no network, no reading of the team folder or server data.
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { runIsolated } from '../tools/isolate'

export const OFFICE_EXT = ['docx', 'pptx', 'odt', 'xlsx', 'xls', 'ods', 'pdf'] as const
export const isOffice = (name: string) => OFFICE_EXT.includes(ext(name) as any)
export const ext = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase()

export interface Tools { pandoc: string | null; pdftotext: string | null }

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
    case 'pdf':
      if (!tools.pdftotext) throw new ToolError('pdftotext is not installed on the server')
      return pipeThrough([tools.pdftotext, '-layout', '-enc', 'UTF-8', '-', '-'], bytes)
    default: {
      const head = bytes.subarray(0, 8000)
      if (head.includes(0)) throw new ToolError('this is a binary file; it cannot be shown as text')
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}
