// Word and Excel pages as the AI's page images (read with pages or as_images; docs/decisions/20261124-doc-skills.md):
// LibreOffice turns the file into a PDF in the converters' isolation (bwrap: no network, only its empty work folder),
// and the PDF's pages go the way every PDF's do. Linux only: on a Mac LibreOffice does not start inside the converter
// sandbox without loosening it (network, exec and file rules), and the sandbox is not loosened for a preview. There the
// AI says it did not see the pages.
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../config'
import { isolation, makeWorkDir, readOutput, runIsolated, sandboxHelper } from '../tools/isolate'
import { renderSlot } from './html-pdf'
import { officeWorkerWrite } from './extract'
import { XLSX_VALUES_MODE } from './xlsx-values'
import { cjkLocale, kitFontsDir, writeOfficeProfile } from './office-profile'

let warnedHelper = false
export const OFFICE_VIEW_EXT = new Set(['docx', 'xlsx', 'pptx'])
const LIMITS = { timeoutMs: 90_000, maxRssMiB: 1536, maxWorkBytes: 512 * 1024 * 1024, maxPdfBytes: 64 * 1024 * 1024 }

/** The LibreOffice this server can run isolated, or null. */
export function officeViewer(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'linux' || isolation() !== 'bwrap') return null
  return which('soffice')
}

/** make_file's line after a Word or Excel file: the one place the AI reads right when it has made one. */
export function officeViewLine(format: string, canView: boolean = officeViewer() !== null): string {
  // a deck without LibreOffice still has the server's own slide drawing (files/deck-pdf.ts)
  if (!OFFICE_VIEW_EXT.has(format) || (format === 'pptx' && !canView)) return ''
  return canView ? '\nYou have not seen its pages yet: look at them with read as_images before you answer.'
    : '\nYou have not seen its pages, and this server cannot show them: tell the user in one short line that you did not see how its pages look.'
}

/** One LibreOffice conversion of `bytes` (a .`ext` file) to `to` in an empty work folder; the output's bytes. */
async function convert(soffice: string, bytes: Uint8Array, ext: string, to: string, outName: string, o: { user: string; workBase: string; signal?: AbortSignal; teamLocale?: string }): Promise<Uint8Array> {
  const release = await renderSlot(o.user, o.signal)
  const workDir = makeWorkDir(o.workBase)
  try {
    const name = `in.${ext}`
    fs.writeFileSync(path.join(workDir, name), bytes, { mode: 0o600 })
    // the run's own profile: the kit's fonts and font table, macros off, formulas calculated (files/office-profile.ts)
    const profile = writeOfficeProfile(path.join(workDir, 'profile'), undefined, cjkLocale(o.teamLocale))
    const fonts = kitFontsDir()
    // the seccomp step needs the sandbox helper: a production Linux server without it draws in bwrap alone (logged once)
    if (process.env.MYCEL_MODE !== 'dev' && !sandboxHelper() && !warnedHelper) { warnedHelper = true; console.warn('office-view: no MYCEL_SANDBOX_HELPER; the page render runs in bwrap without the seccomp filter') }
    fs.mkdirSync(path.join(workDir, 'out'), { mode: 0o700 })
    const r = await runIsolated({
      cmd: soffice, workDir, signal: o.signal, timeoutMs: LIMITS.timeoutMs, maxRssMiB: LIMITS.maxRssMiB, maxWorkBytes: LIMITS.maxWorkBytes,
      readPaths: [...(fs.existsSync('/etc/libreoffice') ? ['/etc/libreoffice'] : []), ...(fonts ? [fonts] : [])],
      seccomp: 'listen',
      args: [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--nolockcheck', '--convert-to', to, '--outdir', path.join(workDir, 'out'), path.join(workDir, name)],
    })
    if (r.code !== 0) throw new Error(r.killed ? `the drawing stopped (${r.killed})` : 'LibreOffice could not open the file')
    const out = readOutput(path.join(workDir, 'out'), outName, LIMITS.maxPdfBytes)
    if (!out.ok) throw new Error('LibreOffice made no output')
    return out.bytes
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
    release()
  }
}

/** A workbook with every formula's result filled in (files/xlsx-values.ts): recalculated by LibreOffice in the
 * isolation, then only the results copied into the original in the office worker. Throws when it cannot. */
export async function officeRecalc(bytes: Uint8Array, o: { user: string; workBase: string; signal?: AbortSignal; teamLocale?: string }): Promise<Uint8Array> {
  const soffice = officeViewer()
  if (!soffice) throw new Error('this server cannot calculate workbooks')
  const copy = await convert(soffice, bytes, 'xlsx', 'xlsx:Calc MS Excel 2007 XML', 'in.xlsx', o)
  const req = new Uint8Array(4 + bytes.length + copy.length)
  new DataView(req.buffer).setUint32(0, bytes.length); req.set(bytes, 4); req.set(copy, 4 + bytes.length)
  return new Uint8Array(await officeWorkerWrite(XLSX_VALUES_MODE, req, o.signal))
}

/** The file drawn as a PDF. Throws when it cannot be drawn (the caller tells the AI). */
export async function officePdf(bytes: Uint8Array, ext: string, o: { user: string; workBase: string; signal?: AbortSignal; teamLocale?: string }): Promise<Uint8Array> {
  const soffice = officeViewer()
  if (!soffice || !OFFICE_VIEW_EXT.has(ext)) throw new Error('this server cannot draw this file')
  return convert(soffice, bytes, ext, 'pdf', 'in.pdf', o)
}
