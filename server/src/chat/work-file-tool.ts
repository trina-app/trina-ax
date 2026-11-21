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
// In a chat shared with people (mode 'chat', docs/decisions/20261121-shared-chat-attach-work-file.md) the file goes to
// the chat instead: attached to this answer as a chat file (chat/chat-files.ts createFromAi), which exactly the chat's
// people open; no save_as, no card. Before the copy, what a run there may read joins this answer's record, and the
// work folder must still be the one for the chat's people now; an answer with a k group (hidden from people added
// later) carries no file. Anyone may later save it into a folder with save_chat_file and their own rights.
import fs from 'node:fs'
import path from 'node:path'
import { FILE_STEP_VERB, SaveWorkFileInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { z } from 'zod'
import type { McpContent } from '../turns'
import type { TurnFiles } from '../files/service'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { inSkills } from '../skills/guard'
import { freeName } from '../team-files/place'
import { noWorkText, shownWorkPath, workRel, type WorkFolder } from '../devenv/work-files'
import { workToChat, workToTeam } from './places-copy'
import type { ReadSource } from './read-scope'
import type { Tool } from './tools'
import { instructionLike, type TurnExec, type WidenOf } from './turn'

export const SAVE_WORK_FILE_TOOL = 'save_work_file'
export const SAVE_WORK_FILE_CHAT_DESCRIPTION = 'The same as copy_files with paths ["chat:work/<path>"] and to_folder "chat:files/" (prefer copy_files). Hand over a finished file that your box_shell commands made in this chat\'s work folder ($TRINA_WORK): it is attached to your answer byte for byte (a video, a picture, a PDF, any file up to 1 GB), and everyone in this chat opens or plays it there. path: the file ("$TRINA_WORK/out/promo.mp4"). There is no save_as here: anyone in the chat can put it into a team folder later with save_chat_file. Say in your answer that it is attached to this answer.'
export const SAVE_WORK_FILE_DESCRIPTION = 'The same as copy_files with paths ["chat:work/<path>"] and a team folder (prefer copy_files). Hand over a finished file that your box_shell commands made in this chat\'s work folder ($TRINA_WORK): a copy goes into the team folder byte for byte (a video, a picture, a PDF, a zip, any file), where the user opens or plays it in Trina. path: the file ("$TRINA_WORK/out/promo.mp4"); save_as: a team path, or a folder ending in "/" that keeps the file\'s name; without save_as it goes to the user\'s own folder (users/<id>/). A place more people can see asks the user on a card first. Then link the saved file in your answer.'

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })
const zodText = (e: z.ZodError) => 'Invalid input: ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

type Args = z.output<typeof SaveWorkFileInput>
type Refusal = { text: string; summary: string }
type Found = { rel: string; target: string }


export function saveWorkFileTool(exec: TurnExec, where: () => WorkFolder | null, mode: 'folder' | 'chat' = 'folder'): Tool {
  const { rt, spec } = exec
  const me = spec.userId
  const own = `users/${me}`
  /** the person is the source of what a work folder holds (it may hold anything they can read) */
  const source: ReadSource[] = [{ type: 'user', id: me }]
  /** what a call's widen hook found as its target, by its arguments: the card named that place */
  const planned = new Map<string, string>()
  const key = (args: unknown) => { try { return JSON.stringify(args ?? null) } catch { return '' } }

  /** The file's path in the work folder, or why not. */
  function fileOf(a: Args): Refusal | { rel: string } {
    const wf = where()
    if (!wf) return { text: `Not saved: ${noWorkText(exec.files.workWhy?.())}`, summary: `${SAVE_WORK_FILE_TOOL} -> no work folder` }
    let rel: string | null
    try { rel = workRel(a.path.startsWith('/') || a.path.startsWith('$') ? a.path : `$TRINA_WORK/${a.path}`, wf) } catch (e) { return { text: `Not saved: ${(e as Error).message}.`, summary: `${SAVE_WORK_FILE_TOOL} -> refused: bad path` } }
    if (!rel) return { text: `Not saved: '${a.path}' is not a file in this chat's work folder ($TRINA_WORK/…).`, summary: `${SAVE_WORK_FILE_TOOL} -> refused: not in the work folder` }
    return { rel }
  }

  /** Why the attach will not run in a chat shared with people, or the file. */
  function chatTarget(a: Args): Refusal | { rel: string } {
    if (a.save_as?.trim()) return { text: 'Not attached: in this chat the finished file goes to your answer for everyone here, so there is no save_as. Call it again without save_as; anyone in the chat can put it into a team folder later with save_chat_file.', summary: `${SAVE_WORK_FILE_TOOL} -> refused: save_as in a shared chat` }
    if (exec.hiddenFromLater) return { text: 'Not attached: this answer used a connected service\'s answer that people added to the chat later may not see, so it carries no file. Make the file again in your next answer without that service, or tell the user.', summary: `${SAVE_WORK_FILE_TOOL} -> refused: answer hidden from later people` }
    return fileOf(a)
  }

  /** Why the save will not run, whatever the person says, or the file and where it goes. */
  function target(a: Args): Refusal | Found {
    const f = fileOf(a)
    if ('text' in f) return f
    const rel = f.rel
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
    name: SAVE_WORK_FILE_TOOL, description: mode === 'chat' ? SAVE_WORK_FILE_CHAT_DESCRIPTION : SAVE_WORK_FILE_DESCRIPTION,
    // a chat shared with people has no place to pick: its schema has no save_as (a call that gives one is refused)
    inputSchema: schema(mode === 'chat' ? SaveWorkFileInput.omit({ save_as: true }) : SaveWorkFileInput),
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
      const t = mode === 'chat' ? chatTarget(a.data) : target(a.data)
      return 'text' in t ? t : null
    },
    widen(args) {
      // a chat's file goes to exactly the chat's people: no team place, no wider-audience card
      if (mode === 'chat') return undefined
      const a = SaveWorkFileInput.safeParse(args)
      let w: WidenOf | undefined
      try { const t = a.success ? target(a.data) : null; w = t && !('text' in t) ? { target: t.target, extra: [], read: source } : undefined } catch { w = undefined }
      if (w) planned.set(key(args), w.target); else planned.delete(key(args))
      return w
    },
    async call(args, files) {
      const a = SaveWorkFileInput.safeParse(args)
      if (!a.success) return text(zodText(a.error), true)
      return mode === 'chat' ? attach(files, a.data) : save(files, a.data, planned.get(key(args)), args)
    },
  }

  // the routes are copy_files' own (chat/places-copy.ts): this tool is its alias for the old arguments, so the card, the
  // step line and the audit row are the same as copy_files' for the same copy
  async function attach(files: TurnFiles, a: Args) {
    try { exec.livePrincipal() } catch { return { ...text('Access denied: this account is disabled.', true), summary: `${SAVE_WORK_FILE_TOOL} -> denied: account disabled` } }
    const checked = chatTarget(a)
    if ('text' in checked) return { ...text(checked.text, true), summary: checked.summary }
    const r = await workToChat(exec, files, { rel: checked.rel, where, tool: SAVE_WORK_FILE_TOOL, shown: shownWorkPath(checked.rel) })
    return { ...text(r.text, !r.ok), summary: r.summary }
  }

  async function save(files: TurnFiles, a: Args, plannedTarget: string | undefined, args: unknown) {
    try { exec.livePrincipal() } catch { return { ...text('Access denied: this account is disabled.', true), summary: `${SAVE_WORK_FILE_TOOL} -> denied: account disabled` } }
    const checked = target(a)
    if ('text' in checked) return { ...text(checked.text, true), summary: checked.summary }
    const { rel, target: to } = checked
    if (plannedTarget !== undefined && plannedTarget !== to && !plannedTarget.startsWith(own + '/')) return { ...text(`Not saved: where the copy would go changed while the user was asked ('${plannedTarget}' is now '${to}'). Ask the user again.`, true), summary: `${SAVE_WORK_FILE_TOOL} -> refused: place changed` }
    const r = await workToTeam(exec, files, { rel, target: to, where, tool: SAVE_WORK_FILE_TOOL, args, shown: shownWorkPath(rel) })
    return { ...text(r.text, !r.ok), summary: r.summary }
  }
}
