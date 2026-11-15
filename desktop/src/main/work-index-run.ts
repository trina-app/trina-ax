// The computer's index for "Find work files on this computer" (common/work-index.ts parses; this runs the commands). A
// Mac: the folders are walked (faster than listing through Spotlight) and mdls gives what Spotlight knows of the newest
// documents (last opened, how often, where from, authors), a few hundred at a time. Windows: one PowerShell run of Windows
// Search's SystemIndex for the three folders, Windows' Recent folder (its shortcuts' targets) and Office's list of recent
// files; the downloads' Zone.Identifier stream says where each came from. Every command has a time limit; a failure is
// "no index" (null), and the folder is walked instead. Nothing here opens a document.
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { shell } from 'electron'
import { mdlsArgs, mergeIndexed, parseMdls, parseOfficeMru, parseWindowsSearch, parseZoneIdentifier, windowsSearchScript, type IndexedFile } from '../common/work-index'

const run = (cmd: string, args: string[], ms: number) =>
  new Promise<string>((done, fail) => execFile(cmd, args, { timeout: ms, maxBuffer: 64 << 20, windowsHide: true }, (e, out) => (e ? fail(e) : done(String(out)))))

let spotlightOn: boolean | null = null
/** What Spotlight knows of these files (last opened, how often, where from, authors): mdls, 200 paths a call, four calls
 * at a time; [] when Spotlight is off or does not answer. Listing through mdfind took longer than walking the folders
 * (0.7 s against 0.1 s, measured 2026-11-15), so a Mac walks and asks mdls about the newest documents only. */
export async function macHints(paths: readonly string[]): Promise<IndexedFile[]> {
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
 * 300) and Office's recent files. */
async function windowsRecent(): Promise<IndexedFile[]> {
  const base = (p: string, used: number | null): IndexedFile => ({ path: p, used, modified: null, useCount: null, size: null, origins: [], authors: [], org: null })
  const out: IndexedFile[] = []
  const recent = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Recent')
  try {
    const names = (await readdir(recent)).filter((n) => n.toLowerCase().endsWith('.lnk'))
    const withTime = await Promise.all(names.map(async (n) => ({ n, t: await stat(join(recent, n)).then((s) => s.mtimeMs, () => 0) })))
    for (const { n, t } of withTime.sort((a, b) => b.t - a.t).slice(0, 300)) {
      try {
        const target = shell.readShortcutLink(join(recent, n)).target
        if (target) out.push(base(target, t || null))
      } catch { /* not a shortcut to a file */ }
    }
  } catch { /* no Recent folder */ }
  try {
    const mru = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Office' -Recurse -ErrorAction SilentlyContinue | Where-Object PSChildName -eq 'File MRU' | ForEach-Object { (Get-ItemProperty $_.PSPath).PSObject.Properties | Where-Object Name -like 'Item*' | ForEach-Object { $_.Value } }"], 6000)
    for (const f of parseOfficeMru(mru)) out.push(base(f.path, f.used))
  } catch { /* no Office */ }
  return out
}

/** Windows Search's recent files under the roots plus the recent lists, merged; null when the index does not answer
 * (the WSearch service off, no provider). Files under Downloads say where they were downloaded from. */
export async function windowsIndex(roots: readonly string[], downloads: string | null): Promise<IndexedFile[] | null> {
  let indexed: IndexedFile[]
  try {
    indexed = parseWindowsSearch(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsSearchScript(roots)], 10_000))
  } catch {
    return null
  }
  const all = mergeIndexed([indexed, await windowsRecent()], 'win32')
  if (downloads) {
    const d = downloads.toLowerCase()
    const here = all.filter((f) => f.path.toLowerCase().startsWith(d)).slice(0, 300)
    await Promise.all(here.map(async (f) => {
      try { f.origins = [...new Set([...f.origins, ...parseZoneIdentifier((await readFile(`${f.path}:Zone.Identifier`, 'utf8')).slice(0, 4096))])] } catch { /* no stream */ }
    }))
  }
  return all
}
