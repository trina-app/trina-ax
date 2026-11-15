// Files the AI saved before the saving tools hid stored keys (docs/DECISIONS.md "Stored keys are hidden in the files the
// AI saves") can still hold one of their person's stored connection keys, and so can their search text (the text cache
// of docx, pdf, hwpx). Once, a moment after a server start, they are looked for, and the person whose key it is gets one
// Activity notice that lists them (QA TC-3082). Nothing is rewritten: the file is the person's (or their team's) and
// only they can tell what it is for. What is logged is counts only, never a path or a key.
import fs from 'node:fs'
import { isUtf8 } from '@mycel/shared/text-encoding'
import type { AppContext } from '../../context'
import { authorize } from '../../policy/authorize'
import type { Principal } from '../../policy/access'
import { readRegular } from '../../files/store'
import { notifyStoredKeyFiles } from '../../notifications/service'
import { redactorOf, redactorFor, type Redactor } from './redact'
import { integrationsOf } from './service'

export const FILE_SCAN_KEY = 'files.storedKeyScan'
export const FILE_SCAN_VERSION = 1

/** What one run looks at, at most: the newest files the AI saved (the rest wait for no one: the run is still marked
 * done, see DECISIONS), and the text read of each file and of its search text. It lets the server's other work run
 * after every `batch` files and after every `pauseBytes` read (one big file is enough), so big files never hold the
 * start-up (the dev server's health check) for long. */
export const FILE_SCAN_LIMITS = { files: 20_000, bytes: 4 * 1024 * 1024, batch: 50, pauseBytes: 2 * 1024 * 1024 }

export interface FileScanResult {
  /** files looked at (they exist and their person may still read them) */
  scanned: number
  /** of those, files that hold one of their person's keys */
  found: number
  /** people told */
  people: number
  /** marked done (every person's keys could be read) */
  done: boolean
}

const pause = () => new Promise<void>((r) => setImmediate(r))

/** The text of a regular file up to `max` bytes, as UTF-8 (null when there is none, it is bigger, or not text), and
 * how many bytes were read for it. */
function textOf(abs: string, max: number): { text: string | null; read: number } {
  try {
    const st = fs.lstatSync(abs)
    if (!st.isFile() || st.size > max) return { text: null, read: 0 }
    const { bytes } = readRegular(abs, max)
    return { text: isUtf8(bytes) ? bytes.toString('utf8') : null, read: bytes.length }
  } catch { return { text: null, read: 0 } }
}

/** The person's redactor, and whether it has every one of their keys (allSecretsFor); a failure is logged. */
function keysOf(ctx: AppContext, userId: string): { r: Redactor; complete: boolean } {
  try {
    const all = integrationsOf(ctx).allSecretsFor(userId)
    if (all) return { r: redactorOf(all), complete: true }
  } catch (e) { ctx.log?.warn('reading connection secrets for the file check failed', { err: e }) }
  return { r: redactorFor(ctx, userId), complete: false }
}

/**
 * Once (settings key `files.storedKeyScan`): the files the AI saved for each person with stored connection keys
 * (file_events with a turn: create or update), the newest first, that are still there and that the person may still
 * read, together with their search text, are checked for any form of that person's keys (redact.ts, as the answer).
 * The ones found are kept (stored_key_files) and the person gets one notice (`files.stored_key`). While someone's keys
 * cannot all be read the keys that can be are looked for, and the run is not marked done: it runs again at the next
 * start. A server that stops meanwhile writes nothing (`stopped`).
 */
export async function findKeysInOldFiles(ctx: AppContext, o: { limits?: typeof FILE_SCAN_LIMITS; stopped?: () => boolean } = {}): Promise<FileScanResult> {
  const limits = o.limits ?? FILE_SCAN_LIMITS
  const db = ctx.db
  const result: FileScanResult = { scanned: 0, found: 0, people: 0, done: false }
  const mark = db.query('SELECT value FROM settings WHERE key = ?').get(FILE_SCAN_KEY) as { value: string } | null
  if (mark && Number(JSON.parse(mark.value)) >= FILE_SCAN_VERSION) return { ...result, done: true }
  const setDone = () => {
    db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(FILE_SCAN_KEY, JSON.stringify(FILE_SCAN_VERSION))
    result.done = true
  }
  if (!db.query('SELECT 1 FROM integrations WHERE secret_enc IS NOT NULL LIMIT 1').get()) { setDone(); return result }

  // each file once, with the person of its newest AI save
  const rows = db.query(`SELECT user_id, path FROM file_events WHERE id IN (
      SELECT MAX(id) FROM file_events WHERE turn_id IS NOT NULL AND action IN ('create','update') GROUP BY path)
    ORDER BY id DESC LIMIT ?`).all(limits.files) as { user_id: string; path: string }[]
  const people = new Map<string, { r: Redactor; p: Principal } | null>()
  let complete = true
  const found = new Map<string, string[]>()
  const files = ctx.files
  const rules = files.rules()
  /** files and bytes since the last pause */
  let since = 0, sinceBytes = 0
  for (let i = 0; i < rows.length; i++) {
    if (since >= limits.batch || sinceBytes >= limits.pauseBytes) {
      since = 0; sinceBytes = 0
      await pause()
      // the server is stopping: nothing is written, the next start looks again
      if (o.stopped?.()) return result
    }
    since++
    const { user_id: userId, path: rel } = rows[i]!
    let who = people.get(userId)
    if (who === undefined) {
      who = null
      try {
        const keys = keysOf(ctx, userId)
        if (!keys.complete) complete = false
        if (keys.r.re) who = { r: keys.r, p: files.principal(userId) }
      } catch { /* an account that is gone or disabled: nobody to tell */ }
      people.set(userId, who)
    }
    if (!who) continue
    let abs: string
    let cache: string
    try {
      const a = authorize(files.fx, rules, who.p, rel, 'read')
      if (!a.exists || !a.st?.isFile()) continue
      abs = a.abs
      cache = files.office.cachePath(a.rel)
    } catch { continue }
    result.scanned++
    const texts = [textOf(abs, limits.bytes), textOf(cache, limits.bytes)]
    sinceBytes += texts[0]!.read + texts[1]!.read
    const holds = texts.some(({ text }) => text !== null && text.search(who.r.re!) >= 0)
    if (!holds) continue
    result.found++
    const list = found.get(userId) ?? []
    list.push(rel)
    found.set(userId, list)
  }

  const at = new Date().toISOString()
  db.transaction(() => {
    for (const [userId, paths] of found) {
      for (const p of paths) db.query('INSERT INTO stored_key_files (user_id, path, found_at) VALUES (?, ?, ?) ON CONFLICT(user_id, path) DO NOTHING').run(userId, p, at)
    }
    if (complete) setDone()
  })()
  for (const userId of found.keys()) notifyStoredKeyFiles(ctx, userId)
  result.people = found.size
  return result
}

/** The files of the notice the person may open now, the first `show` of them, and how many there are. Read when the
 * notice is shown: a file that is gone or that they may no longer open is left out (no access is widened). */
export function storedKeyFilesOf(ctx: AppContext, userId: string, show = 20): { n: number; files: { path: string }[] } {
  const rows = ctx.db.query('SELECT path FROM stored_key_files WHERE user_id = ? ORDER BY path LIMIT 500').all(userId) as { path: string }[]
  let p: Principal
  try { p = ctx.files.principal(userId) } catch { return { n: 0, files: [] } }
  const rules = ctx.files.rules()
  const open: { path: string }[] = []
  for (const r of rows) {
    try {
      const a = authorize(ctx.files.fx, rules, p, r.path, 'read')
      if (a.exists && a.st?.isFile()) open.push({ path: a.rel })
    } catch {}
  }
  return { n: open.length, files: open.slice(0, show) }
}
