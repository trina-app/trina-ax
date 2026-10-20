// Text for read/grep. Office formats: pandoc (docx/pptx/odt), SheetJS (xlsx/xls/ods), pdftotext (pdf).
// Input bytes always come from an fd opened with O_NOFOLLOW and checked (nlink==1), and are fed to the
// converters on stdin, so a converter never opens a path itself.
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'

export const OFFICE_EXT = ['docx', 'pptx', 'odt', 'xlsx', 'xls', 'ods', 'pdf'] as const
export const isOffice = (name: string) => OFFICE_EXT.includes(ext(name) as any)
export const ext = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase()

export interface Tools { pandoc: string | null; pdftotext: string | null }

async function pipeThrough(cmd: string[], input: Uint8Array, timeoutMs = 20000): Promise<string> {
  const p = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
  const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
  p.stdin.write(input); p.stdin.end()
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(t)
  if (code !== 0) throw new ToolError(`could not convert the file to text (${cmd[0].split('/').pop()}: ${err.trim().slice(0, 200) || 'exit ' + code})`)
  return out
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
