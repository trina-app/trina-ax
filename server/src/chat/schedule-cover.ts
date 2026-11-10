// A scheduled run's saves and sends that the task's card allowed (docs/DECISIONS.md "Scheduled tasks: saving and sending
// allowed on the card"; the card and its facts: chat/schedule-scope.ts). A run has nobody to answer a card, so a save
// that would ask (the wider-audience card, or the room card after a room read) and a connection write after a room read
// go on here only when the card said yes to exactly this, else they are refused with why and what to do instead:
//   - saves: a NEW file in the save folder or one of its sub-folders that has no folder rules of its own, or a file this
//     same run made there (nobody changed it since); never an existing file of anyone else, a hidden or plugin folder, a
//     skills folder or an instruction file, a path an AI turn just put in the trash; at most MAX_COVERED_FILES new files
//     per run; and only when every place the run read that fewer people can see than the file is on the card, and every
//     room the run read. Moves, copies, renames, deletes, save_url and videos are never covered (the usual card: no).
//   - sends after a room read: a write to a connection the card allowed (an "allow" team connection, or the person's
//     own one, whose recipients connections/tools.ts gate checks against the pins) skips the room card only when every
//     room the run read is on the card.
//   - a lapse (the folder moved, renamed, deleted, its rules changed, the person's write access gone) stops every save
//     there: the run saves in the person's own folder and says why (chat/schedule-scope.ts checkLapse).
// Every cover is checked again right before the call writes (recheck), an absent target is reserved for the one call
// that claimed it (two calls of a run at the same time cannot both make one path), and the first cover of a run is
// audited `schedule.save_cover`.
import type { Database } from 'bun:sqlite'
import type { Locale, Step } from '@mycel/shared/api'
import type { StoredStep } from './store'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { refusal } from '../policy/refusal'
import type { Principal, RuleSet } from '../policy/access'
import { authorize, type FsCtx } from '../policy/authorize'
import { hwpOutputPath } from '../files/hwpx-check'
import { ext } from '../files/extract'
import { inSkills } from '../skills/guard'
import { readersOf, ruledBetween, within } from '../rooms/ai-grants'
import { componentC } from '../team-files/component'
import { confidentialChat } from '../safe-ops/confidential'
import { getRow } from '../integrations/connections/store'
import { missingReaders, readScope, sourceOf, type ReadSource } from './read-scope'
import { checkLapse, LAPSE_FOR_AI, MAX_COVERED_FILES, rowSends, rowSources, scopeKey, sourceForAi, type SaveLapse, type ScopeSource } from './schedule-scope'
import { scheduleList, type ScheduleRow } from './schedules'
import { tr } from './i18n'
import { instructionLike } from './turn'

/** What the cover needs of the turn (chat/turn.ts TurnExec). */
export interface CoverHost {
  readonly id: string
  readonly spec: { userId: string; chatId: string; locale: Locale }
  readonly rt: { db: Database; ctx: AppContext; files: { fx: FsCtx; rules(): RuleSet } }
  livePrincipal(): Principal
  noteReads(): void
  patchToolStep(tool: string, patch: (s: Step) => Partial<StoredStep>): void
}

/** The only tools whose saves a card may cover: they write one file, whose whole content the run made (never save_url,
 * whose name and bytes come from the web, a video, a move, copy, rename or delete). */
export const COVER_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'make_file', 'edit_hwp', 'save_room_file'])

/** A call by its tool and input (the room card's key, chat/turn.ts confirmRoomChange). */
export function callKey(tool: string, input: unknown): string {
  let args = ''
  try { args = JSON.stringify(input ?? null) } catch { args = String(input) }
  return `${tool}\u0000${args}`
}

/** Where write, make_file, edit_hwp and edit save, as the call names it, and whether the call may make a new file
 * there (edit and edit_hwp without an output change a file in place); null for any other tool. save_room_file: where
 * its widen hook says it saves. */
export function saveTargetOf(tool: string, input: unknown, widenTarget?: string): { path: string; mayBeNew: boolean } | null {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  let p: string, mayBeNew: boolean
  switch (tool) {
    case 'write': p = str(a.file_path); mayBeNew = true; break
    case 'make_file':
      if (!str(a.format) || /\/\s*$/.test(str(a.output))) return null
      p = ext(str(a.output)) === str(a.format) ? str(a.output) : `${str(a.output)}.${str(a.format)}`
      mayBeNew = true
      break
    case 'edit_hwp':
      if (str(a.output)) { p = hwpOutputPath(str(a.output), str(a.file_path)); mayBeNew = true }
      else { p = str(a.file_path); mayBeNew = false }
      break
    case 'edit': p = str(a.file_path); mayBeNew = false; break
    case 'save_room_file': p = widenTarget ?? ''; mayBeNew = true; break
    default: return null
  }
  return p.trim() ? { path: p, mayBeNew } : null
}

/** A refusal of this run (policy/refusal.ts): what did not happen, why the card's yes does not cover it, the next step,
 * the folders and connections involved. */
function refuse(done: string, why: string, next: string, names: string[] = []): string {
  return refusal({ done, why: { kind: 'mode', mode: 'this scheduled run', why }, next, names })
}

/** One save: the call (its key: tool and input), where it saves, whether it may make a new file there, the files it
 * copies bytes from (`from`) and other places its bytes come from (`read`: a room file's room), and whether it is the
 * main AI's own call (its step says why it went on). */
export interface SaveCall { key: string; tool: string; path: string; mayBeNew: boolean; from: readonly string[]; read: readonly ReadSource[]; main: boolean }

/** One run's covers (TurnExec.scheduleCover): null outside a confirmed free-text task's run. */
export class ScheduleCover {
  /** absent targets claimed by a call (rel → call key), until that call ends (release) */
  private reserved = new Map<string, string>()
  /** new files this run saved under the cover (the cap) */
  private made = new Set<string>()
  /** covered calls, checked again right before they write */
  private covered = new Map<string, SaveCall>()
  private audited = false
  private stepped = new Set<string>()

  private constructor(private host: CoverHost, readonly scheduleId: string) {}

  /** The cover of a scheduled run's turn, or null (no task, a template's run). */
  static of(host: CoverHost): ScheduleCover | null {
    const r = host.rt.db.query('SELECT s.id FROM turns t JOIN schedules s ON s.id = t.schedule_id AND s.user_id = t.user_id WHERE t.id = ? AND s.template_id IS NULL').get(host.id) as { id: string } | null
    return r ? new ScheduleCover(host, r.id) : null
  }

  /** The task as it is now (an edit during the run counts at once): confirmed, its owner's. */
  private row(): ScheduleRow | null {
    return this.host.rt.db.query('SELECT * FROM schedules WHERE id = ? AND user_id = ? AND confirmed_at IS NOT NULL AND template_id IS NULL').get(this.scheduleId, this.host.spec.userId) as ScheduleRow | null
  }

  private get mine() { return `users/${this.host.spec.userId}` }

  /** Did this run make the file at `rel` (a create of this turn, not a move into place) and nobody else change it since? */
  private madeHere(rel: string): boolean {
    return !!this.host.rt.db.query(`SELECT 1 FROM file_events e WHERE e.turn_id = ? AND e.path = ? AND e.action = 'create' AND json_extract(e.detail, '$.movedFrom') IS NULL
      AND NOT EXISTS (SELECT 1 FROM file_events x WHERE x.path = e.path AND x.id > e.id AND (x.turn_id IS NULL OR x.turn_id <> e.turn_id)) LIMIT 1`).get(this.host.id, rel)
  }

  /** Is the place `s` (a read-scope source) on the card? Only the person's own folder (never what the browser showed or
   * a personal connection answered: they are not "my folder"), rooms, ruled folders and the team root by id. */
  private listed(s: ReadSource, on: ReadonlySet<string>): boolean {
    if (s.type === 'user') return !s.via && s.id === this.host.spec.userId && on.has(`user:${s.id}`)
    if (s.type === 'room' || s.type === 'folder') return on.has(`${s.type}:${s.id}`)
    if (s.type === 'root') return on.has('root')
    return false
  }

  /** A place for the AI's text. */
  private aiName(s: ReadSource): string {
    const db = this.host.rt.db
    if (s.type === 'user' || s.type === 'room' || s.type === 'folder' || s.type === 'root') {
      if (s.type === 'user' && s.via) return s.via === 'browser' ? 'a page of the in-app browser' : 'an answer of the user\'s own connected service'
      return sourceForAi(db, s as ScopeSource, this.host.spec.userId)
    }
    if (s.type === 'integration') return `the team connection ${getRow(db, s.id)?.name ?? '?'}`
    if (s.type === 'drive_share') return 'a Google Drive shared with the team'
    return `the name ${s.path}`
  }

  /** The rooms the run read that the card does not list (their AI names). */
  private unlistedRooms(scope: readonly ReadSource[], on: ReadonlySet<string>): string[] {
    return [...new Set(scope.filter((s) => s.type === 'room' && !on.has(`room:${s.id}`)).map((s) => this.aiName(s)))]
  }

  /**
   * A save that would need a card now (the room card after a room read, the wider-audience card): null = the card's
   * yes covers it, go on; a string = refused, with why; undefined = not in this task's save folder (the usual card, which
   * nobody answers in a run).
   */
  save(c: SaveCall): string | null | undefined {
    const row = this.row()
    if (!row?.save_folder) return undefined
    const db = this.host.rt.db, fx = this.host.rt.files.fx, rules = this.host.rt.files.rules()
    let r
    try { r = authorize(fx, rules, this.host.livePrincipal(), c.path, 'write', { createDirs: true }) } catch { return undefined }
    const folder = row.save_folder.split('/')
    const fileFolder = r.segs.slice(0, -1)
    if (!within(folder, fileFolder)) return undefined
    const mine = this.mine
    const elsewhere = `save it in the user's personal folder (${mine}) instead and say so in the summary`
    const lapse = checkLapse(this.host.rt.ctx, row)
    if (lapse) return this.lapsed(r.rel, row.save_folder, lapse)
    const done = `Not saved: '${r.rel}'.`
    if (ruledBetween(rules, folder, fileFolder)) return refuse(done, `the task's card allowed new files in ${row.save_folder} and its sub-folders without folder permissions of their own, and '${fileFolder.join('/')}' has its own`, elsewhere, [row.save_folder])
    if (r.segs.some((x) => x.startsWith('.')) || inSkills(r.rel) || instructionLike(r.rel) || fx.managed?.managerOf(r.segs) || fx.managed?.managerOf(fileFolder))
      return refuse(done, 'a run never saves in a hidden or plugin folder, a skills folder or an instruction file (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md), whatever its card allowed', `${elsewhere}; the user can change skills and instruction files in a chat`, [row.save_folder])
    try { if (confidentialChat(db, this.host.spec.chatId)) return undefined } catch { return undefined }
    if (r.exists) {
      if (!r.st?.isFile() || !this.madeHere(r.rel))
        return refuse(done, `the task's card allows only NEW files in ${row.save_folder} (and changes of files this run made there); '${r.rel}' is there already, and a run never changes, replaces, moves or deletes an existing file`, `save it under a new name in ${row.save_folder}, or ${elsewhere}`, [row.save_folder])
    } else {
      if (!c.mayBeNew) return undefined
      try { if (componentC(this.host.rt.ctx).files.aiTrashed(r.rel)) return refuse(done, `'${r.rel}' was just put in the trash, and saving there again would replace what was removed`, `use another name, or ${elsewhere}`, [row.save_folder]) } catch { return undefined }
      const claimed = this.reserved.get(r.rel)
      if (claimed && claimed !== c.key) return refuse(done, `another call of this run is saving '${r.rel}' right now`, 'wait for it, then change that file, or save under another name')
      if (!this.made.has(r.rel) && this.made.size >= MAX_COVERED_FILES) return refuse(done, `a run saves at most ${MAX_COVERED_FILES} new files in its save folder`, `${elsewhere}, or put several results in one file`, [row.save_folder])
    }
    // what the run read: every room on the card, every place fewer people can see than the file on the card
    this.host.noteReads()
    const extra: ReadSource[] = [...c.read]
    for (const p of c.from) {
      try { extra.push(sourceOf(db, rules, authorize(fx, rules, this.host.livePrincipal(), p, 'read').rel)) } catch { /* the tool reports it */ }
    }
    const scope = [...(readScope(db, this.host.spec.chatId) ?? []), ...extra]
    const on = new Set(rowSources(row).map(scopeKey))
    const rooms = this.unlistedRooms(scope, on)
    if (rooms.length) return refuse(done, `this run read ${rooms.join(', ')}, which the task's card does not list, so nothing it read may go to ${row.save_folder}`, `${elsewhere}; the user can add the room to the task by making it again in a chat`, [row.save_folder])
    const readers = readersOf(db, rules, r.segs)
    const unlisted = missingReaders(db, rules, scope, readers, this.host.spec.userId).map((m) => m.source).filter((s) => !this.listed(s, on))
    if (unlisted.length) {
      const names = [...new Set(unlisted.map((s) => this.aiName(s)))]
      return refuse(done, `this run read ${names.join(', ')}, which fewer people can see than ${row.save_folder}, and the task's card does not list ${names.length === 1 ? 'it' : 'them'} as content that may go there`, `${elsewhere}; the user can allow it by making the task again in a chat with that place listed`, [row.save_folder])
    }
    if (!r.exists) { this.reserved.set(r.rel, c.key); this.made.add(r.rel) }
    this.covered.set(c.key, c)
    if (!this.audited) {
      this.audited = true
      try { audit(db, { actor: this.host.spec.userId, action: 'schedule.save_cover', target: this.scheduleId, detail: { turnId: this.host.id, folder: row.save_folder } }) } catch { /* the save goes on; the file events name it */ }
    }
    if (c.main && !this.stepped.has(c.key)) {
      this.stepped.add(c.key)
      const said = tr('scheduleCoverStep', this.host.spec.locale)
      this.host.patchToolStep(c.tool, (st) => ({ label: st.label.endsWith(said) ? st.label : `${st.label} · ${said}` }))
    }
    return null
  }

  /** The refusal of a save in a lapsed save folder: the own folder instead, and why. */
  private lapsed(rel: string, folder: string, why: SaveLapse): string {
    return refuse(`Not saved: '${rel}'.`, `saving in ${folder} is paused for this task: ${LAPSE_FOR_AI[why]}, so the card's yes no longer holds`,
      `save it in the user's personal folder (${this.mine}) instead and say in the summary why, and that the user can check the save folder again on the Scheduled page`, [folder])
  }

  /**
   * A connection write after a room read (its tool says which connection: TurnTool.sendsTo): null = the room card is
   * skipped (the connection's own checks follow: an "allow" team connection the card allowed, or the person's own one
   * at its pinned recipients); a string = refused; undefined = the card never allowed this connection (the usual card).
   */
  send(connectionId: string): string | null | undefined {
    const row = this.row()
    if (!row) return undefined
    const may = scheduleList(row.write_connections).includes(connectionId) || rowSends(row).some((x) => x.connectionId === connectionId)
    if (!may) return undefined
    this.host.noteReads()
    const scope = readScope(this.host.rt.db, this.host.spec.chatId) ?? []
    const rooms = this.unlistedRooms(scope, new Set(rowSources(row).map(scopeKey)))
    const name = getRow(this.host.rt.db, connectionId)?.name ?? 'that connection'
    if (rooms.length) return refuse(`Nothing was sent to ${name}.`, `this run read ${rooms.join(', ')}, which the task's card does not list, so a run that read ${rooms.length === 1 ? 'it' : 'them'} sends nothing (the room's messages are other people's words)`, 'say so in the summary; the user can send it in a chat, or make the task again in a chat with that room listed', [name])
    return null
  }

  /** Right before a covered call writes: still covered (the same checks again), else why not. Calls nothing covered: null. */
  recheck(key: string): string | null {
    const c = this.covered.get(key)
    if (!c) return null
    const again = this.save(c)
    return again === undefined ? refuse(`Not saved: '${c.path}'.`, 'the task\'s save folder changed while this run was saving', `save it in the user's personal folder (${this.mine}) instead and say so`) : again
  }

  /** A call ended (saved or not): its claims go; an absent target it claimed no longer counts for the cap. */
  release(key: string): void {
    this.covered.delete(key)
    for (const [rel, k] of this.reserved) {
      if (k !== key) continue
      this.reserved.delete(rel)
      try {
        const r = authorize(this.host.rt.files.fx, this.host.rt.files.rules(), this.host.livePrincipal(), rel, 'write', { createDirs: true })
        if (!r.exists) this.made.delete(rel)
      } catch { /* kept counted: fails closed */ }
    }
  }
}

/** What a task's card let its runs do without a card, for the run's instructions (chat/schedules.ts scheduledRunBlock),
 * in English; null for nothing. A lapsed save folder is named with why and where to save instead. */
export function runAllowance(ctx: AppContext, s: ScheduleRow): string | null {
  const db = ctx.db
  const fresh = (db.query('SELECT * FROM schedules WHERE id = ?').get(s.id) as ScheduleRow | null) ?? s
  if (fresh.template_id || !fresh.confirmed_at) return null
  const lines: string[] = []
  const sources = rowSources(fresh)
  const names = (xs: readonly ScopeSource[]) => xs.map((x) => sourceForAi(db, x, fresh.user_id)).join(', ')
  if (fresh.save_folder) {
    if (fresh.save_lapsed_at) {
      const why = (fresh.save_lapse_reason as SaveLapse | null) ?? 'folder'
      lines.push(`- Saving in ${fresh.save_folder} is paused: ${LAPSE_FOR_AI[why]}. Save the results in the user's personal folder (users/${fresh.user_id}) instead, and say in your summary why, and that the user can check the save folder again on the Scheduled page.`)
    } else {
      const from = sources.length ? names(sources) : null
      lines.push(`- Save NEW files in ${fresh.save_folder}, or in its sub-folders that have no folder permissions of their own, without asking: at most ${MAX_COVERED_FILES} per run, and you may change the files this run made there. Never replace, move, rename or delete a file there, and never save skills or instruction files there. ${from ? `Content from ${from} may go there; if this run reads anything else that fewer people can see, or a room not named here, do not save there: save in the user's personal folder and say why.` : 'Only content everyone who can see that folder may see goes there: if this run reads anything that fewer people can see, or a room, do not save there: save in the user\'s personal folder and say why.'}`)
    }
  } else if (sources.length) lines.push(`- Reading ${names(sources)} does not stop the sends below; reading any other room does.`)
  const team = scheduleList(fresh.write_connections).map((id) => getRow(db, id)?.name).filter((n): n is string => !!n)
  if (team.length) lines.push(`- Send to ${team.join(', ')} without asking.`)
  for (const x of rowSends(fresh)) {
    const name = getRow(db, x.connectionId)?.name
    if (name) lines.push(`- Send to ${name} only at ${x.pins.map((p) => `'${p}'`).join(', ')}: any other recipient is refused, and a call whose recipient cannot be told is refused too.`)
  }
  return lines.length ? lines.join('\n') : null
}
