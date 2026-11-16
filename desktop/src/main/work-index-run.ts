// The computer's index for "Find work files on this computer" (common/work-index.ts parses; this runs the commands). A
// Mac: the folders are walked (faster than listing through Spotlight) and mdls gives what Spotlight knows of the newest
// documents (last opened, how often, where from, authors), a few hundred at a time. Windows: one PowerShell run of Windows
// Search's SystemIndex for the three folders, Windows' Recent folder (its shortcuts' targets) and Office's list of recent
// files; the downloads' Zone.Identifier stream says where each came from. Every command has a time limit; a failure is
// "no index" (null), and the folder is walked instead. Nothing here opens a document.
import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { shell } from 'electron'
import { windowsRecentLinks } from './work-places-run'
import { mdlsArgs, mergeIndexed, parseMdls, parseOfficeMru, parseWindowsSearch, parseZoneIdentifier, powershellArgs, windowsLook, windowsSearchScript, type IndexedFile, type WindowsLook } from '../common/work-index'

/** A command's output; a non-zero exit with output still answers (mdls exits 1 when one of 200 paths is gone, and the
 * other 199 count); a time-out or no output at all fails. */
const run = (cmd: string, args: string[], ms: number) =>
  new Promise<string>((done, fail) => execFile(cmd, args, { timeout: ms, maxBuffer: 64 << 20, windowsHide: true }, (e, out) => {
    const text = String(out ?? '')
    if (e && ((e as { killed?: boolean }).killed || !text)) fail(e)
    else done(text)
  }))

let spotlightOn: boolean | null = null
/** What Spotlight knows of these files (last opened, how often, where from, authors): mdls, 200 paths a call, four calls
 * at a time; [] when Spotlight is off or does not answer. Listing through mdfind took longer than walking the folders
 * (0.7 s against 0.1 s, measured 2026-11-15), so a Mac walks and asks mdls about the newest documents only. */
export async function macHints(paths: readonly string[], until: { deadline: number; stopped: () => boolean } = { deadline: Date.now() + 10_000, stopped: () => false }): Promise<IndexedFile[]> {
  if (spotlightOn === null) spotlightOn = await run('/usr/bin/mdutil', ['-s', '/'], 3000).then((o) => /Indexing enabled/i.test(o), () => false)
  if (!spotlightOn || !paths.length) return []
  const batches: string[][] = []
  for (let i = 0; i < paths.length; i += 200) batches.push(paths.slice(i, i + 200))
  const out: IndexedFile[] = []
  for (let i = 0; i < batches.length; i += 4) {
    const answers = await Promise.all(batches.slice(i, i + 4).map((b) => run('/usr/bin/mdls', mdlsArgs(b), 8000).then(parseMdls, () => [])))
    for (const a of answers) out.push(...a)
  }
  return out
}

/** Windows' own recent lists: the Recent folder's shortcuts (their targets, the shortcut's time as last opened, the newest
 * 300; work-places-run.ts) and Office's recent files. */
async function windowsRecent(home: string): Promise<IndexedFile[]> {
  const base = (p: string, used: number | null): IndexedFile => ({ path: p, used, modified: null, useCount: null, size: null, origins: [], authors: [], org: null, listed: true })
  const out: IndexedFile[] = await windowsRecentLinks(home, (p) => shell.readShortcutLink(p).target || null)
  try {
    const mru = await run('powershell.exe', powershellArgs("Get-ChildItem 'HKCU:\\Software\\Microsoft\\Office' -Recurse -ErrorAction SilentlyContinue | Where-Object PSChildName -eq 'File MRU' | ForEach-Object { (Get-ItemProperty $_.PSPath).PSObject.Properties | Where-Object Name -like 'Item*' | ForEach-Object { $_.Value } }"), 6000)
    for (const f of parseOfficeMru(mru)) out.push(base(f.path, f.used))
  } catch { /* no Office */ }
  return out
}

/** Windows Search's recent files under the roots plus the recent lists (common/work-index.ts windowsLook): the index's
 * part is null when the index does not answer (the WSearch service off, no provider), and the recent lists still count
 * (`lists`).
 * Files under Downloads say where they were downloaded from. */
export async function windowsIndex(roots: readonly string[], downloads: string | null, o: { home?: string; drives?: boolean; lists?: boolean } = {}): Promise<WindowsLook> {
  const recentP = windowsRecent(o.home ?? process.env.USERPROFILE ?? '').catch(() => [] as IndexedFile[])
  const indexed = await run('powershell.exe', powershellArgs(windowsSearchScript(roots, undefined, undefined, { drives: o.drives })), 10_000).then(parseWindowsSearch, () => null)
  const look = windowsLook(indexed, await recentP)
  // a look that only takes the index (the three folders) walks at once when there is none (`lists`: the wide look,
  // which lists the recent files too)
  if (!look.index && !o.lists) return look
  const all = look.index ?? look.recent
  if (downloads) {
    // where the downloads came from: their Zone.Identifier stream (4 KB at most), only for files under Downloads
    // itself (not a Downloads2 beside it), a second each and 5 s in all; the hosts only
    const d = downloads.toLowerCase().replace(/[\\/]+$/, '') + '\\'
    // (never an online-only file's: its streams are the cloud's too)
    const here = all.filter((f) => !f.cloud && f.path.toLowerCase().startsWith(d)).slice(0, 300)
    const until = Date.now() + 5000
    for (let i = 0; i < here.length && Date.now() < until; i += 16) {
      await Promise.all(here.slice(i, i + 16).map(async (f) => {
        try {
          const h = await open(`${f.path}:Zone.Identifier`, 'r')
          try {
            const buf = Buffer.alloc(4096)
            const { bytesRead } = await Promise.race([h.read(buf, 0, 4096, 0), new Promise<never>((_, no) => setTimeout(() => no(new Error('late')), 1000))])
            f.origins = [...new Set([...f.origins, ...parseZoneIdentifier(buf.subarray(0, bytesRead).toString('utf8'))])]
          } finally { await h.close().catch(() => {}) }
        } catch { /* no stream, or it did not answer */ }
      }))
    }
  }
  return look
}

/** Windows' fixed drives ("C:\\", "D:\\"): any other drive letter is a network or removable one. */
export async function windowsFixedDrives(): Promise<string[]> {
  try {
    const out = await run('powershell.exe', powershellArgs("[System.IO.DriveInfo]::GetDrives()|Where-Object{$_.DriveType -eq 'Fixed'}|ForEach-Object{$_.Name}"), 5000)
    return out.split(/\r?\n/).map((x) => x.trim()).filter((x) => /^[A-Z]:\\$/i.test(x))
  } catch { return [] }
}
