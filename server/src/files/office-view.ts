// Word and Excel pages as the AI's page images (read with pages or as_images; docs/decisions/20261124-doc-skills.md):
// LibreOffice turns the file into a PDF in the converters' isolation (bwrap: no network, only its empty work folder),
// and the PDF's pages go the way every PDF's do. Linux only: on a Mac LibreOffice does not start inside the converter
// sandbox without loosening it (network, exec and file rules), and the sandbox is not loosened for a preview. There the
// AI says it did not see the pages.
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../config'
import { isolation, makeWorkDir, readOutput, runIsolated } from '../tools/isolate'
import { renderSlot } from './html-pdf'

export const OFFICE_VIEW_EXT = new Set(['docx', 'xlsx'])
const LIMITS = { timeoutMs: 90_000, maxRssMiB: 1536, maxWorkBytes: 512 * 1024 * 1024, maxPdfBytes: 64 * 1024 * 1024 }

/** The LibreOffice this server can run isolated, or null. */
export function officeViewer(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'linux' || isolation() !== 'bwrap') return null
  return which('soffice')
}

/** make_file's line after a Word or Excel file: the one place the AI reads right when it has made one. */
export function officeViewLine(format: string, canView: boolean = officeViewer() !== null): string {
  if (!OFFICE_VIEW_EXT.has(format)) return ''
  return canView ? '\nYou have not seen its pages yet: look at them with read as_images before you answer.'
    : '\nYou have not seen its pages, and this server cannot show them: tell the user in one short line that you did not see how its pages look.'
}

/** The file drawn as a PDF. Throws when it cannot be drawn (the caller tells the AI). */
export async function officePdf(bytes: Uint8Array, ext: string, o: { user: string; workBase: string; signal?: AbortSignal }): Promise<Uint8Array> {
  const soffice = officeViewer()
  if (!soffice || !OFFICE_VIEW_EXT.has(ext)) throw new Error('this server cannot draw this file')
  const release = await renderSlot(o.user, o.signal)
  const workDir = makeWorkDir(o.workBase)
  try {
    const name = `in.${ext}`
    fs.writeFileSync(path.join(workDir, name), bytes, { mode: 0o600 })
    const r = await runIsolated({
      cmd: soffice, workDir, signal: o.signal, timeoutMs: LIMITS.timeoutMs, maxRssMiB: LIMITS.maxRssMiB, maxWorkBytes: LIMITS.maxWorkBytes,
      readPaths: fs.existsSync('/etc/libreoffice') ? ['/etc/libreoffice'] : [],
      args: [`-env:UserInstallation=file://${workDir}/profile`, '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', workDir, path.join(workDir, name)],
    })
    if (r.code !== 0) throw new Error(r.killed ? `the drawing stopped (${r.killed})` : 'LibreOffice could not open the file')
    const out = readOutput(workDir, 'in.pdf', LIMITS.maxPdfBytes)
    if (!out.ok) throw new Error('LibreOffice made no PDF')
    return out.bytes
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
    release()
  }
}
