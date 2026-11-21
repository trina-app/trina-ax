// query_data (QA TC-4913, docs/decisions/20261118-data-tool.md): totals, pivots, top-N, monthly figures and splits over
// the team's data files, on every install. Before it, without the dev environment (an office Mac, teams from before
// 2026-11-06, Ubuntu / Debian 12 servers) the AI refused a pivot of a 50,000-row CSV ("the heavier data-processing option
// isn't available"), retyped rows into make_file or counted with dozens of greps.
// - Inputs: CSV, TSV, xlsx / xls / ods, JSON, JSONL files the person may read (authorize 'read', as read does; a file
//   they cannot open answers like a missing one). Each joins the turn's read scope, read hashes and sources like a read
//   (its content goes to the model through the result), and a shared chat's read card sees them (`paths`).
// - Engine: SQLite (bun:sqlite) in the office worker (files/data-query.ts), run through the converter isolation
//   (tools/isolate.ts): the copies of the inputs in an empty work folder, no network, nothing else readable; at most
//   DATA_LIMITS.timeoutMs, DATA_LIMITS.rssMiB of memory and a disk cap on the work folder; DATA_LIMITS.parallel queries at
//   a time on the server (others wait, then "busy").
// - save_as: the whole result as .csv / .tsv / .xlsx (split_by: a file per value), placed through make_file's save path
//   (placeProduced: write access checked again, conflict copies, versions, file events) after the wider-audience check
//   for the inputs (confirmSources), asked before the query runs so a "no" costs nothing. What one answer saves has its
//   own budget (DATA_LIMITS.saveBytes / saveFiles), not the turn's write limits for AI-typed text; a guest keeps those.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { QueryDataInput } from '@mycel/shared'
import { fileShareUrl } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { ext, officeWorkerScript } from '../files/extract'
import { DATA_EXT, DATA_QUERY_MODE, SHEET_EXT, sqlName, type DataQueryRequest, type DataQueryResponse, type TableInfo } from '../files/data-query'
import { TOOL_ERROR_EXIT } from '../files/office-parse'
import type { ToolCtx } from '../files/service'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { inSkills } from '../skills/guard'
import { isReservedPlace } from '@mycel/shared/places'
import { PLACE_WORDS } from '../files/places'
import { inProcessParseMax, readMaxBytes } from '../system/limits'
import { checkRegular, openChecked } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir, runIsolated } from './isolate'
import { confirmSources, placeProduced } from './make-file'

type QueryIn = z.output<typeof QueryDataInput>

/** Sized for a 200 MB CSV (measured on an M-series Mac: 4,000,000 rows, 217 MB, loaded and grouped in 26 s at 770 MB of
 * memory): time, memory, work folder (the copies, the database, its sort files and the results), queries at once and
 * how long another waits, rows shown by default, and what one answer may save. */
export const DATA_LIMITS = {
  timeoutMs: 180_000,
  rssMiB: 2048,
  /** work folder bytes: this many times the inputs, plus workExtra */
  workFactor: 4,
  workExtra: 512 * 1024 * 1024,
  parallel: 2,
  waitMs: 60_000,
  showRows: 50,
  /** characters of the result table in the answer (a tool result over about 25,000 tokens is cut by the engine) */
  textMax: 30_000,
  saveBytes: 500 * 1024 * 1024,
  saveFiles: 200,
  /** files of one split */
  splitFiles: 100,
  /** SQLite's memory cap inside the worker where its build honours it (files/data-query.ts SQLITE_HEAP_MIB); sorts and groups stay in memory, under rssMiB */
  sqliteHeapMiB: 1536,
}

export const QUERY_DATA_DESCRIPTION = 'Calculate over data files in the team folder with SQL: totals, counts, averages, pivots (GROUP BY), ' +
  'top-N, monthly or weekly figures, filters, joins of several files, de-duplication, and splitting one file into several. Works on CSV, TSV, ' +
  'Excel (.xlsx, .xls), .ods, JSON and JSONL, also very large ones (hundreds of thousands or millions of rows, up to 200 MB): every row is ' +
  'counted, nothing is estimated. Use it for any question about the numbers in a data file instead of reading it page by page, counting ' +
  'with grep or retyping rows; never tell the user such work cannot be done here. ' +
  'First call it with only `paths` to see the tables, column names and types and the first rows; then give `sql`. One file is the table ' +
  '"data"; several are t1, t2, ... in the order given; a workbook\'s further sheets are data_2, data_3 (t1_2, ...). The SQL is SQLite: put ' +
  'names with spaces, other letters or capitals in double quotes ("Sales total", "Order Date", Korean or other non-Latin names); months: substr(date, 1, 7) for "2025-03-15", ' +
  'strftime(\'%Y-%m\', date) for ISO dates; numbers stored as text: CAST(x AS REAL); ROUND(x, 2); window functions and WITH work. ' +
  'Cells that are all numbers are INTEGER or REAL columns (codes with a leading zero like "007" stay text); sheet dates are "YYYY-MM-DD". ' +
  'Only reading queries run; the files are never changed. ' +
  '`save_as` saves the whole result (any number of rows) as .csv, .tsv or .xlsx in the team folder; with `split_by` one file per value of a ' +
  'result column ("split it by region" = sql SELECT * FROM data, save_as "…/sales.csv", split_by "region"). For a chart, save the result ' +
  'as .csv and make an Excel chart from it with make_file (`source` = that .csv, `charts`).'

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const num = (n: number) => n.toLocaleString('en-US')

export interface QueryDataResult {
  response: DataQueryResponse
  inputs: string[]
  saved: { path: string; size: number; rows: number; value: string | null; conflictCopyOf?: string }[]
  failed: { name: string; why: string }[]
}

// ---------------------------------------------------------------- the server-wide slot

let running = 0
/** the people with a query running: one at a time each, so one person's calls (or sub-agents) never take every place */
const runningFor = new Set<string>()
const waiting: { who: string; go: () => void }[] = []
/** the first one waiting whose person has no query running gets the free place */
function wakeNext() {
  if (running >= DATA_LIMITS.parallel) return
  const i = waiting.findIndex((w) => !runningFor.has(w.who))
  if (i >= 0) waiting.splice(i, 1)[0]!.go()
}
/** One of DATA_LIMITS.parallel places, at most one per person (`who`); waits up to DATA_LIMITS.waitMs, then ToolError
 * 'busy'. */
export function dataSlot(who: string, signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let released = false
    const release = () => { if (released) return; released = true; running--; runningFor.delete(who); wakeNext() }
    const grant = () => { running++; runningFor.add(who); resolve(release) }
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
    if (running < DATA_LIMITS.parallel && !runningFor.has(who)) { grant(); return }
    const entry = { who, go: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); grant() } }
    const drop = (e: unknown) => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e) }
    const timer = setTimeout(() => drop(new ToolError(runningFor.has(who)
      ? 'another data calculation of this person is still running, so this one was not done and nothing was saved. Run the calculations one after the other'
      : 'other data work is running on the team\'s app right now, so this was not done and nothing was saved. Tell the user in plain words to try again in a moment', 'busy')), DATA_LIMITS.waitMs)
    const onAbort = () => drop(signal!.reason ?? new Error('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    waiting.push(entry)
  })
}

/** A team file copied into the work folder chunk by chunk (reads and writes on the I/O threads, never the whole file in
 * the server's memory), hashed on the way, from the very file authorize checked (openChecked: same device and inode). */
async function copyIn(abs: string, st: fs.Stats, max: number, to: string, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
  const { fd } = openChecked(abs, st)
  const hash = crypto.createHash('sha256')
  const out = await fs.promises.open(to, 'wx', 0o600)
  let size = 0
  try {
    const buf = Buffer.alloc(COPY_CHUNK)
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await readAt(fd, buf, size)
      if (bytesRead <= 0) break
      size += bytesRead
      if (size > max) throw new ToolError('file is too large')
      hash.update(buf.subarray(0, bytesRead))
      await out.write(buf, 0, bytesRead)
    }
  } finally {
    await out.close()
    try { fs.closeSync(fd) } catch {}
  }
  return { sha256: hash.digest('hex'), size }
}
const COPY_CHUNK = 4 * 1024 * 1024
const readAt = (fd: number, buf: Buffer, pos: number) => new Promise<{ bytesRead: number }>((res, rej) => fs.read(fd, buf, 0, buf.length, pos, (e, n) => (e ? rej(e) : res({ bytesRead: n }))))

// ---------------------------------------------------------------- inputs and outputs

/** `place`: a chat place input (chat:files/…, chat:work/…), copied into the call's own folder first (Placed) */
interface Input { rel: string; abs: string; ext: string; table: string; size: number; max: number; st: fs.Stats; place?: boolean }
/** a chat place's copy for this call, by the path the AI gave (files/service.ts TurnFiles.placeInput) */
type Placed = Map<string, { abs: string; st: fs.Stats }>

/** each input as authorize resolves it for this person now (read access; a folder, another format or a size over the
 * limits refused before any work); a chat place as its copy (`placed`) */
function resolveInputs(files: TeamFiles, c: ToolCtx, paths: string[], placed: Placed = new Map()): Input[] {
  const fx = files.fx
  const rules = files.rules()
  const out: Input[] = []
  const seen = new Set<string>()
  for (const [i, p] of paths.entries()) {
    const pl = placed.get(p)
    if (pl) {
      const e = ext(p)
      if (seen.has(p)) throw new ToolError(`'${p}' is given twice; give each file once`)
      seen.add(p)
      if (!DATA_EXT.has(e)) throw new ToolError(`'${p}' is not a data file this can calculate over (CSV, TSV, .xlsx, .xls, .ods, JSON, JSONL)`)
      out.push({ rel: p, abs: pl.abs, ext: e === 'txt' ? 'csv' : e, table: paths.length === 1 ? 'data' : `t${i + 1}`, size: pl.st.size, max: Math.max(pl.st.size, 1), st: pl.st, place: true })
      continue
    }
    const r = authorize(fx, rules, c.user, p, 'read')
    if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; give the data files in it (list or glob finds them)`, 'is_folder')
    if (seen.has(r.rel)) throw new ToolError(`'${r.rel}' is given twice; give each file once`)
    seen.add(r.rel)
    const e = ext(r.rel)
    if (!DATA_EXT.has(e)) throw new ToolError(`'${r.rel}' is not a data file this can calculate over (CSV, TSV, .xlsx, .xls, .ods, JSON, JSONL)${e === 'pdf' || e === 'docx' ? '; read it to see its tables, or copy a table out of it into a CSV first' : ''}`)
    const st = checkRegular(r.abs)
    const max = SHEET_EXT.has(e) ? Math.min(readMaxBytes(), inProcessParseMax()) : readMaxBytes()
    if (st.size > max) throw new ToolError(`'${r.rel}' is ${human(st.size)}, larger than the ${human(max)} that can be calculated over here${SHEET_EXT.has(e) ? '; saved as a .csv it can be larger' : ''}. Nothing was done`)
    out.push({ rel: r.rel, abs: r.abs, ext: e === 'txt' ? 'csv' : e, table: paths.length === 1 ? 'data' : `t${i + 1}`, size: st.size, max, st: r.st! })
  }
  const total = out.reduce((n, x) => n + x.size, 0)
  if (total > 2 * readMaxBytes()) throw new ToolError(`the files are ${human(total)} together, more than the ${human(2 * readMaxBytes())} one call can load. Nothing was done; use fewer files`)
  return out
}

/**
 * Where each result file goes: save_as, or for a split "<name> - <value>.<ext>" ({value} in save_as is replaced). A
 * name the team folder does not take (a reserved name like "CON", nothing left of the value) becomes
 * "<name> - value <index>". `used` (lower case, NFC) holds the names this call already gave: a clash gets " 2", " 3" ...
 */
export function splitTarget(saveAs: string, value: string | null, index: number, used?: Set<string>): string {
  const slash = saveAs.lastIndexOf('/')
  const dir = slash >= 0 ? saveAs.slice(0, slash + 1) : ''
  const name = saveAs.slice(slash + 1)
  if (value === null) return saveAs
  const dot = name.lastIndexOf('.')
  const stem = name.slice(0, dot), extn = name.slice(dot)
  const make = (v: string) => (stem.includes('{value}') ? stem.replace(/\{value\}/g, v).trim() + extn : `${stem} - ${v}${extn}`)
  let file = value ? make(value) : ''
  if (!value || badSegment(file)) file = `${stem.replace(/\{value\}/g, '').replace(/\s+/g, ' ').trim().replace(/[ -]+$/, '') || 'result'} - value ${index}${extn}`
  const key = (f: string) => f.normalize('NFC').toLowerCase()
  if (used) {
    const base = file.slice(0, file.length - extn.length)
    for (let k = 2; used.has(key(file)); k++) file = `${base} ${k}${extn}`
    used.add(key(file))
  }
  return dir + file
}
/** two team paths name the same file (letter case and Unicode forms as the file layer folds them) */
const sameFile = (a: string, b: string) => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()

// ---------------------------------------------------------------- the tool

export async function queryData(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: QueryIn): Promise<QueryDataResult> {
  const guest = files.rules().isGuest(c.user)
  // a chat file or a work-folder file (chat:files/…, chat:work/…; QA: the AI tried a chat file and was refused): copied
  // into a folder of this call first, through the chat turn's own checks (chat/places-copy.ts stagePlaceInput)
  const placed: Placed = new Map()
  const stage = a.paths.some(isReservedPlace) ? makeWorkDir(path.join(ctx.config.dataDir, 'work')) : null
  try {
    for (const [i, p] of a.paths.entries()) {
      if (!isReservedPlace(p) || placed.has(p)) continue
      if (!c.files.placeInput) throw new ToolError(`'${p}': ${PLACE_WORDS.noChat}`, 'not_found')
      const e = ext(p)
      const max = SHEET_EXT.has(e) ? Math.min(readMaxBytes(), inProcessParseMax()) : readMaxBytes()
      const dest = path.join(stage!, `place-${i + 1}.${DATA_EXT.has(e) ? e : 'bin'}`)
      const got = await c.files.placeInput(p, dest, max, c.signal)
      if (ctx.files.quarantine.hasHash(got.sha256)) throw new ToolError('Generated output is download-only; indexing, text extraction and in-app previews are disabled.', 'safe_ops_quarantined')
      placed.set(p, { abs: dest, st: fs.lstatSync(dest) })
    }
    return await queryDataOf(ctx, files, c, a, placed, guest)
  } finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }) }
}

async function queryDataOf(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: QueryIn, placed: Placed, guest: boolean): Promise<QueryDataResult> {
  const fx = files.fx
  const rules = files.rules()
  const inputs = resolveInputs(files, c, a.paths, placed)

  // the place for the result, checked before any work (a read-only place stops the call here)
  let saveAs: string | null = null
  let format: 'csv' | 'tsv' | 'xlsx' | null = null
  if (a.save_as !== undefined) {
    const e = ext(a.save_as)
    if (e !== 'csv' && e !== 'tsv' && e !== 'xlsx') throw new ToolError('save_as must end in .csv, .tsv or .xlsx (for a Word or PDF report, save a .csv and make the report with make_file)')
    format = e
    if (inSkills(a.save_as)) throw new ToolError('a result cannot be saved into a skills folder (skills/, a group\'s or a project\'s); pick another folder')
    // save_as naming one of the inputs (also in another letter case): the plain refusal below, before authorize, whose
    // "almost the same name" check would answer first on a case-sensitive file system (Linux)
    const asked = a.save_as.split('/').filter((x) => x && x !== '.').join('/')
    const named = a.split_by === undefined ? inputs.find((x) => sameFile(x.rel, asked)) : undefined
    if (named) throw new ToolError(`save_as is '${named.rel}', one of the files the data comes from, which is never changed; nothing was done. Save the result under a new name (for example "${named.rel.replace(/(\.[^./]+)$/, ' (result)$1')}")`)
    const probe = a.split_by !== undefined ? splitTarget(a.save_as, 'x', 1) : splitTarget(a.save_as, null, 0)
    const t = authorize(fx, rules, c.user, probe, 'write', { mustExist: false, createDirs: true })
    if (t.exists && t.st!.isDirectory()) throw new ToolError(`'${t.rel}' is a folder`, 'is_folder')
    saveAs = a.split_by !== undefined ? [...t.segs.slice(0, -1), a.save_as.split('/').at(-1)!].join('/') : t.rel
    // the inputs are never changed: a result never goes over one of them (they count as read in this turn, so the save
    // would replace the file instead of making a conflict copy)
    const over = inputs.find((x) => sameFile(x.rel, t.rel))
    if (a.split_by === undefined && over) throw new ToolError(`save_as is '${over.rel}', one of the files the data comes from, which is never changed; nothing was done. Save the result under a new name (for example "${over.rel.replace(/(\.[^./]+)$/, ' (result)$1')}")`)
    if (inSkills(saveAs)) throw new ToolError('a result cannot be saved into a skills folder; pick another folder')
    // the wider-audience check for the inputs' content at the result's folder, before the query runs: a "no" costs
    // nothing (every file of a split goes into this same folder)
    await confirmSources(ctx, files, c, t.rel, t.segs, inputs.map((x) => x.rel))
  }
  // what this answer may still save (guests: the turn's normal limits, checked by placeProduced file by file)
  const roomFiles = guest ? ctx.engineConfig.maxFilesWrittenPerTurn - c.files.filesWritten.size : DATA_LIMITS.saveFiles - c.files.dataSavedFiles
  if (saveAs !== null && roomFiles <= 0) throw new ToolError('no more result files can be saved in this answer, so nothing was done. Tell the user; they can ask again in a new message')

  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    let response: DataQueryResponse
    const release = await dataSlot(c.user.id, c.signal)
    try {
      // the inputs again, as the file layer resolves them now (a card may have been open for minutes), copied into the
      // work folder one by one: the worker sees only these copies
      const now = resolveInputs(files, c, a.paths, placed)
      const req: DataQueryRequest = {
        inputs: [], ...(a.sql !== undefined ? { sql: a.sql } : {}), ...(a.sheet !== undefined ? { sheet: a.sheet } : {}),
        ...(a.header_row !== undefined ? { headerRow: a.header_row } : {}), show: a.show_rows ?? DATA_LIMITS.showRows,
        ...(format ? { save: { format, ...(a.split_by !== undefined ? { splitBy: a.split_by } : {}), maxFiles: Math.min(DATA_LIMITS.splitFiles, roomFiles) } } : {}),
      }
      for (const [i, x] of now.entries()) {
        if (x.rel !== inputs[i]!.rel) throw new ToolError(`'${inputs[i]!.rel}' changed while this call waited, so nothing was done. Try again`)
        const file = `in-${i + 1}.${x.ext}`
        // streamed and hashed on the way (a 200 MB file never sits whole in the server's memory or blocks it)
        const { sha256: hash } = await copyIn(x.abs, x.st, x.max, path.join(work, file), c.signal)
        if (ctx.files.quarantine.hasHash(hash)) throw new ToolError('Generated output is download-only; indexing, text extraction and in-app previews are disabled.', 'safe_ops_quarantined')
        // its content reaches the model through the result: read like a read (scope, hashes, the answer's sources); a
        // chat place's source was recorded when it was copied (it is no team file)
        if (!x.place) {
          c.files.readHashes.set(x.rel, hash)
          c.files.readPaths.add(x.rel)
          c.files.sources.note(x.rel, 'read', { agent: c.files.agent, sha256: hash })
        }
        req.inputs.push({ file, name: x.rel, ext: x.ext, table: x.table })
      }
      const inBytes = now.reduce((n, x) => n + x.size, 0)
      req.heapMiB = DATA_LIMITS.sqliteHeapMiB
      response = await runDataWorker(work, req, inBytes, c.signal)
    } finally { release() }

    const result: QueryDataResult = { response, inputs: inputs.map((x) => x.rel), saved: [], failed: [] }
    if (saveAs === null || !response.outputs) return result
    // the result files, through make_file's save path (write access checked again for each, conflict copies, versions)
    const outs = response.outputs
    const bytesOf = (o: { file: string }) => checkRegular(path.join(work, o.file)).size
    const total = outs.reduce((n, o) => n + bytesOf(o), 0)
    if (!guest && c.files.dataSavedBytes + total > DATA_LIMITS.saveBytes) throw new ToolError(`the result is ${human(total)}, more than the ${human(DATA_LIMITS.saveBytes)} that can still be saved in this answer, so nothing was saved. Tell the user; a narrower query (fewer columns or rows) fits`)
    const used = new Set<string>()
    for (const [i, o] of outs.entries()) {
      if (c.signal?.aborted) { result.failed.push({ name: o.value ?? saveAs, why: 'stopped' }); continue }
      const target = splitTarget(saveAs, o.value, i + 1, used)
      try {
        // a split file whose name is one of the inputs: never saved over it
        const at = authorize(fx, files.rules(), c.user, target, 'write', { mustExist: false, createDirs: true }).rel
        const over = inputs.find((x) => sameFile(x.rel, at))
        if (over) throw new ToolError(`it would replace '${over.rel}', one of the files the data comes from, which is never changed`)
        const made = await placeProduced(ctx, files, c, target.split('/'), path.join(work, o.file), 'query_data', undefined, { turnBytes: guest, turnFiles: guest, thisAnswerOnly: true, detail: { from: inputs[0]!.rel, files: inputs.slice(1, 51).map((x) => x.rel) } })
        if (!guest) { c.files.dataSavedBytes += made.size; c.files.dataSavedFiles++ }
        result.saved.push({ path: made.path, size: made.size, rows: o.rows, value: o.value, ...(made.conflictCopyOf ? { conflictCopyOf: made.conflictCopyOf } : {}) })
      } catch (e) {
        if (!(e instanceof Error)) throw e
        if (!result.saved.length && outs.length === 1) throw e
        result.failed.push({ name: target, why: e instanceof ToolError ? e.message : e instanceof Denied ? `not allowed (${e.message})` : 'internal error' })
      }
    }
    if (!result.saved.length) throw new ToolError(`nothing was saved:\n${result.failed.slice(0, 10).map((f) => `- ${f.name}: ${f.why}`).join('\n')}`)
    return result
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** The office worker's data mode in the work folder, isolated; its answer, or a ToolError in plain words. */
export async function runDataWorker(work: string, req: DataQueryRequest, inBytes: number, signal?: AbortSignal): Promise<DataQueryResponse> {
  const script = await officeWorkerScript()
  const r = await runIsolated({
    cmd: process.execPath, args: ['--smol', '--no-env-file', script, DATA_QUERY_MODE], stdin: new TextEncoder().encode(JSON.stringify(req)),
    workDir: work, readPaths: [path.dirname(script)], timeoutMs: DATA_LIMITS.timeoutMs, maxStdout: 16 * 1024 * 1024,
    maxRssMiB: DATA_LIMITS.rssMiB, maxWorkBytes: DATA_LIMITS.workFactor * inBytes + DATA_LIMITS.workExtra, signal,
    // the worker's dates in UTC: a sheet's date is the day it shows, whatever the server's zone
    env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', NO_COLOR: '1', TZ: 'UTC' },
  })
  if (r.killed === 'aborted') { signal?.throwIfAborted(); throw new ToolError('stopped') }
  const stopped = (why: string) => new ToolError(`the data work was stopped: ${why}. Nothing was saved. Tell the user in plain words; a narrower question (fewer files, fewer columns, a filter) can work`)
  if (r.killed === 'timeout') throw stopped(`it took longer than ${DATA_LIMITS.timeoutMs / 1000} s`)
  if (r.killed === 'memory') throw stopped(`it needed more than ${DATA_LIMITS.rssMiB / 1024} GB of memory`)
  if (r.killed === 'disk') throw stopped('it needed more working space than this much data may take')
  if (r.killed === 'output') throw stopped('its answer was too long')
  if (r.code === TOOL_ERROR_EXIT) throw new ToolError(r.stderr.trim().slice(0, 1500))
  if (r.code === null || r.code >= 128) throw stopped('it ran out of memory or time')
  if (r.code !== 0) throw new ToolError(`the data could not be loaded (${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'exit ' + r.code})`)
  try { return JSON.parse(r.stdout.toString('utf8')) as DataQueryResponse } catch { throw new ToolError('the data work gave no answer') }
}

// ---------------------------------------------------------------- the text for the AI

/** a cell on one line of a tab-separated table */
const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' '))
const tsv = (cols: string[], rows: unknown[][]) => [cols.map(cell).join('\t'), ...rows.map((r) => r.map(cell).join('\t'))]

function tableLine(t: TableInfo): string {
  const src = `'${t.source}'${t.sheet !== undefined ? ` sheet '${t.sheet}'` : ''}`
  return `${sqlName(t.table)} = ${src}: ${num(t.rows)} row${t.rows === 1 ? '' : 's'}; columns: ${t.columns.map((c) => `${sqlName(c.name)} ${c.type}`).join(', ') || 'none'}`
}

export function queryDataText(r: QueryDataResult): string {
  const res = r.response
  const lines: string[] = []
  const skipped = res.skippedSheets.map((s) => `'${s.source}' also has the sheets ${s.sheets.map((n) => `'${n}'`).join(', ')} (not loaded: \`sheet\` named another one)`)
  const notes = res.tables.flatMap((t) => t.notes.map((n) => `${t.table}: ${n}`))
  if (!res.result) {
    lines.push(`Loaded ${res.tables.length} table${res.tables.length === 1 ? '' : 's'} (SQLite). Query ${res.tables.length === 1 ? 'it' : 'them'} with \`sql\`; names with spaces, capitals or other letters go in "double quotes".`)
    for (const t of res.tables) {
      lines.push('', `- ${tableLine(t)}`)
      if (t.sample.length) lines.push(`  First rows (tab-separated):`, ...tsv(t.columns.map((c) => c.name), t.sample).map((l) => '  ' + l))
    }
    if (notes.length) lines.push('', 'Notes:', ...notes.map((n) => `- ${n}`))
    if (skipped.length) lines.push('', ...skipped)
    lines.push('', 'If the column names look like data (a title row above the table), call again with header_row.')
    return cut(lines.join('\n'))
  }
  const q = res.result
  lines.push(`Tables: ${res.tables.map((t) => `${sqlName(t.table)} = '${t.source}'${t.sheet !== undefined ? ` sheet '${t.sheet}'` : ''} (${num(t.rows)} rows)`).join('; ')}.`)
  const head = `Result: ${num(q.total)} row${q.total === 1 ? '' : 's'}, ${q.columns.length} column${q.columns.length === 1 ? '' : 's'}`
  let shownRows = q.rows
  let table = tsv(q.columns, shownRows)
  // the result table within textMax (a long answer is cut by the engine, silently)
  while (table.join('\n').length > DATA_LIMITS.textMax && shownRows.length > 1) { shownRows = shownRows.slice(0, Math.max(1, Math.floor(shownRows.length * 0.7))); table = tsv(q.columns, shownRows) }
  const all = shownRows.length === q.total
  lines.push(`${head}${all ? '' : ` (the first ${num(shownRows.length)} shown${r.saved.length ? '; all of them are in the saved file' : '; add ORDER BY / LIMIT, or save_as for all of them'})`}:`)
  lines.push(...table)
  if (notes.length) lines.push('', 'Notes:', ...notes.map((n) => `- ${n}`))
  if (skipped.length) lines.push('', ...skipped)
  if (r.saved.length) {
    lines.push('', `Saved ${r.saved.length} file${r.saved.length === 1 ? '' : 's'}:`)
    for (const s of r.saved.slice(0, 50)) {
      const name = s.path.split('/').pop()!
      lines.push(`- [${name}](${fileShareUrl(s.path, 'preview')}): ${num(s.rows)} row${s.rows === 1 ? '' : 's'}, ${human(s.size)}${s.conflictCopyOf ? ` (a file named '${s.conflictCopyOf}' was already there and was not read in this turn, so this is a new copy next to it; the existing file is unchanged)` : ''}`)
    }
    if (r.saved.length > 50) lines.push(`- … and ${r.saved.length - 50} more in the same folder`)
  }
  if (r.failed.length) lines.push('', `NOT saved (${r.failed.length}):`, ...r.failed.slice(0, 20).map((f) => `- ${f.name}: ${f.why}`))
  lines.push('', 'These figures are computed from every row of the files. Give them as they are (round only for display), and ' +
    (r.saved.length ? 'link the saved files by name.' : 'offer to save the result as a file when it is long.'))
  return cut(lines.join('\n'))
}

const cut = (s: string) => (s.length > DATA_LIMITS.textMax + 4000 ? s.slice(0, DATA_LIMITS.textMax + 4000) + '\n… (cut)' : s)

export function queryDataSummary(r: QueryDataResult): string {
  const q = r.response.result
  return `query_data ${r.inputs.join(', ')}${q ? ` -> ${q.total} rows x ${q.columns.length} cols` : ` -> ${r.response.tables.length} tables`}${r.saved.length ? `, saved ${r.saved.map((s) => `${s.path} ${s.size}B`).join(', ')}` : ''}${r.failed.length ? `, ${r.failed.length} not saved` : ''}`.slice(0, 1000)
}
