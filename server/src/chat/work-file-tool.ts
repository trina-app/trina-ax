// save_work_file (docs/decisions/20261121-ai-sees-and-saves-workspace-output.md): a finished file that box_shell's
// commands made in a personal chat's work folder ($TRINA_WORK), put into the team folder byte for byte, so the person
// opens or plays it in Trina and the AI links it. Runs never write the team folder beyond their own rules
// (DECISIONS "Write only in the starting folder"); this is the one explicit way out, with the person's own write rights.
//   - Where: save_as, a folder keeping the file's own name, or by default the person's own folder users/<id>/. In the
//     person's own folder a name that is taken gets "name (2).ext"; elsewhere placeProduced's usual rule (a file the AI
//     did not read in this answer is kept, the copy saved next to it). Never under skills/, never as an instruction file,
//     never where the person may not write: refused before any card.
//   - Who may see it: the work folder may hold anything the person can read, so the person is its source
//     ({type:'user'}), as for a copy out of their own folder: a place more people can see asks on the wider-audience
//     card first (Always allow as everywhere).
//   - The bytes: streamed from one checked descriptor (devenv/work-files.ts copyWorkFile: no link, no hard link, inside
//     the work folder) into a server-only copy with its sha256, refused when the safety check holds that hash, then
//     placeProduced (write access again, the turn's write limits, the storage check, versions and file events).
// A chat shared with people gets the file attached to the answer instead (a later change); this tool is offered in
// personal chats only (chat/tools.ts).
import fs from 'node:fs'
import path from 'node:path'
import { FILE_STEP_VERB, SaveWorkFileInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { z } from 'zod'
import type { McpContent } from '../turns'
import type { ToolCtx, TurnFiles } from '../files/service'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { cardEndShort, endOfText } from '../policy/refusal'
import { inSkills } from '../skills/guard'
import { componentC } from '../team-files/component'
import { freeName } from '../team-files/place'
import { placeProduced } from '../tools/make-file'
import { turnWriteLimits } from '../files/turn-write-limits'
import { copyWorkFile, shownWorkPath, workRel, type WorkFolder } from '../devenv/work-files'
import type { ReadSource } from './read-scope'
import type { Tool } from './tools'
import { instructionLike, type TurnExec, type WidenOf } from './turn'

export const SAVE_WORK_FILE_TOOL = 'save_work_file'
export const SAVE_WORK_FILE_DESCRIPTION = 'Hand over a finished file that your box_shell commands made in this chat\'s work folder ($TRINA_WORK): a copy goes into the team folder byte for byte (a video, a picture, a PDF, a zip, any file), where the user opens or plays it in Trina. path: the file ("$TRINA_WORK/out/promo.mp4"); save_as: a team path, or a folder ending in "/" that keeps the file\'s name; without save_as it goes to the user\'s own folder (users/<id>/). A place more people can see asks the user on a card first. Then link the saved file in your answer.'

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })
const zodText = (e: z.ZodError) => 'Invalid input: ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

type Args = z.output<typeof SaveWorkFileInput>
type Refusal = { text: string; summary: string }
type Found = { rel: string; target: string }

/** a link the app opens (the same form the prompt asks for: SOURCE_LINK_RULE) */
const fileLink = (p: string) => `[${p.split('/').pop()}](/files/view?path=${encodeURIComponent(p)})`

export function saveWorkFileTool(exec: TurnExec, where: () => WorkFolder | null): Tool {
  const { rt, spec } = exec
  const me = spec.userId
  const own = `users/${me}`
  /** the person is the source of what a work folder holds (it may hold anything they can read) */
  const source: ReadSource[] = [{ type: 'user', id: me }]
  /** what a call's widen hook found as its target, by its arguments: the card named that place */
  const planned = new Map<string, string>()
  const key = (args: unknown) => { try { return JSON.stringify(args ?? null) } catch { return '' } }

  /** Why the save will not run, whatever the person says, or the file and where it goes. */
  function target(a: Args): Refusal | Found {
    const wf = where()
    if (!wf) return { text: 'This chat has no work folder to save from now (no command ran in it yet, or the dev environment is off for you).', summary: `${SAVE_WORK_FILE_TOOL} -> no work folder` }
    let rel: string | null
    try { rel = workRel(a.path.startsWith('/') || a.path.startsWith('$') ? a.path : `$TRINA_WORK/${a.path}`, wf) } catch (e) { return { text: `Not saved: ${(e as Error).message}.`, summary: `${SAVE_WORK_FILE_TOOL} -> refused: bad path` } }
    if (!rel) return { text: `Not saved: '${a.path}' is not a file in this chat's work folder ($TRINA_WORK/…).`, summary: `${SAVE_WORK_FILE_TOOL} -> refused: not in the work folder` }
    const name = rel.split('/').pop()!.normalize('NFC')
    const wanted = (a.save_as ?? '').trim().replace(/^\/+/, '').normalize('NFC')
    let isFolder = false
    try { isFolder = !!wanted && !wanted.endsWith('/') && !!authorize(rt.files.fx, rt.files.rules(), exec.livePrincipal(), wanted, 'list').st?.isDirectory() } catch { /* not one this person sees */ }
    const folder = !wanted ? own : wanted.endsWith('/') || isFolder ? wanted.replace(/\/+$/, '') : null
    let t = folder === null ? wanted : `${folder}/${name}`
    if (inSkills(t)) return { text: 'Not saved: a work file is not put in a skills folder (team, group or project skills and rules); pick another folder.', summary: `${SAVE_WORK_FILE_TOOL} -> refused: skills/` }
    if (instructionLike(t)) return { text: `Not saved: '${t}' is named like an instruction file the AI follows (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md). Pick another name.`, summary: `${SAVE_WORK_FILE_TOOL} -> refused: instruction file` }
    try {
      const w = authorize(rt.files.fx, rt.files.rules(), exec.livePrincipal(), t, 'write', { createDirs: true })
      // the person's own folder: a taken name gets "name (2).ext", never a conflict copy
      if (w.rel === own || w.rel.startsWith(own + '/')) {
        const dir = path.join(rt.files.fx.root, ...w.segs.slice(0, -1))
        if (w.exists || fs.existsSync(path.join(dir, w.segs.at(-1)!))) t = [...w.segs.slice(0, -1), freeName(dir, w.segs.at(-1)!)].join('/')
        else t = w.rel
      }
    } catch (e) {
      if (e instanceof Denied || e instanceof ToolError) return { text: `Not saved: ${e.message}`, summary: `${SAVE_WORK_FILE_TOOL} -> refused: ${e instanceof Denied ? 'access denied' : e.code}` }
      throw e
    }
    return { rel, target: t }
  }

  return {
    name: SAVE_WORK_FILE_TOOL, description: SAVE_WORK_FILE_DESCRIPTION, inputSchema: schema(SaveWorkFileInput),
    label(args: unknown, locale: Locale) {
      const a = SaveWorkFileInput.safeParse(args)
      const verb = FILE_STEP_VERB[SAVE_WORK_FILE_TOOL]![locale]
      if (!a.success) return verb
      const n = a.data.path.split('/').pop()!.slice(0, 60)
      return a.data.save_as?.trim() ? `${verb} · ${n} → ${a.data.save_as.trim().slice(0, 60)}` : `${verb} · ${n}`
    },
    refuse(args) {
      const a = SaveWorkFileInput.safeParse(args)
      if (!a.success) return null
      try { exec.livePrincipal() } catch { return { text: 'Access denied: this account is disabled.', summary: `${SAVE_WORK_FILE_TOOL} -> denied: account disabled` } }
      const t = target(a.data)
      return 'text' in t ? t : null
    },
    widen(args) {
      const a = SaveWorkFileInput.safeParse(args)
      let w: WidenOf | undefined
      try { const t = a.success ? target(a.data) : null; w = t && !('text' in t) ? { target: t.target, extra: [], read: source } : undefined } catch { w = undefined }
      if (w) planned.set(key(args), w.target); else planned.delete(key(args))
      return w
    },
    async call(args, files) {
      const a = SaveWorkFileInput.safeParse(args)
      if (!a.success) return text(zodText(a.error), true)
      return save(files, a.data, planned.get(key(args)), args)
    },
  }

  async function save(files: TurnFiles, a: Args, plannedTarget: string | undefined, args: unknown) {
    try { exec.livePrincipal() } catch { return { ...text('Access denied: this account is disabled.', true), summary: `${SAVE_WORK_FILE_TOOL} -> denied: account disabled` } }
    const checked = target(a)
    if ('text' in checked) return { ...text(checked.text, true), summary: checked.summary }
    const { rel, target: to } = checked
    const shown = shownWorkPath(rel)
    if (plannedTarget !== undefined && plannedTarget !== to && !plannedTarget.startsWith(own + '/')) return { ...text(`Not saved: where the copy would go changed while the user was asked ('${plannedTarget}' is now '${to}'). Ask the user again.`, true), summary: `${SAVE_WORK_FILE_TOOL} -> refused: place changed` }
    const call = { tool: SAVE_WORK_FILE_TOOL, args }
    const refusal = await exec.confirmWidening(to, [], undefined, call, source)
    if (refusal) { const e = endOfText(refusal); return { ...text(refusal, true), summary: `${SAVE_WORK_FILE_TOOL} -> ${e === 'failed' ? 'the check failed' : cardEndShort(e)} (wider audience)` } }
    exec.abort.signal.throwIfAborted()
    // the card may have waited: the work folder looked up again, with every check of the open
    const wf = where()
    if (!wf) return { ...text('Not saved: the work folder of this chat is not available now.', true), summary: `${SAVE_WORK_FILE_TOOL} -> no work folder` }
    const base = path.join(rt.ctx.engineConfig.dataDir, 'work')
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    const work = fs.mkdtempSync(path.join(base, 'work-file-'))
    try {
      const max = turnWriteLimits(rt.ctx.engineConfig, rt.db, me)
      const left = Math.max(0, max.bytes - files.bytesWritten)
      const tmp = path.join(work, 'file')
      const got = await copyWorkFile(wf, rel, tmp, left, exec.abort.signal).catch((e) => {
        if (e instanceof ToolError && e.code === 'too_large') throw new ToolError(`${shown} is larger than what one answer may still save (${(left / 1024 ** 2).toFixed(0)} MB left of ${(max.bytes / 1024 ** 2).toFixed(0)} MB). Make it smaller (a lower bitrate or a shorter cut), or save it in the next answer.`, 'too_large')
        throw e
      })
      if (rt.files.quarantine.hasHash(got.sha256)) return { ...text('Not saved: the team\'s safety check holds this file.', true), summary: `${SAVE_WORK_FILE_TOOL} -> held` }
      const c: ToolCtx = { user: exec.livePrincipal(), turnId: spec.turnId, files, signal: exec.abort.signal, confirmWidening: (t, s, b) => exec.confirmWidening(t, s, b, call, source) }
      const made = await placeProduced(rt.ctx, componentC(rt.ctx).files, c, to.split('/').filter(Boolean), tmp, SAVE_WORK_FILE_TOOL, undefined, { thisAnswerOnly: true, detail: { from: 'work folder' } })
      const mb = (made.size / 1024 ** 2).toFixed(1)
      const note = made.conflictCopyOf ? ` ${made.conflictCopyOf} already existed and was not read in this answer, so this was saved next to it; the original is unchanged.` : ''
      return { ...text(`Saved ${shown} as ${made.path} (${mb} MB).${note} Link it in your answer: ${fileLink(made.path)}`), summary: `${SAVE_WORK_FILE_TOOL} -> ${made.path} (${made.size} B)` }
    } catch (e) {
      exec.abort.signal.throwIfAborted()
      if (e instanceof ToolError || e instanceof Denied) return { ...text(`Not saved: ${e.message}`, true), summary: `${SAVE_WORK_FILE_TOOL} -> refused: ${e instanceof Denied ? 'access denied' : e.code}` }
      throw e
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }
}
