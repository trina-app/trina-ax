import { confidentialChat, localTool } from "../safe-ops/confidential"
// The tools of one turn besides the six file tools: B's remember / forget / ask_user / connect_service / set_title and the browser pane tools
// (desktop window only), plus whatever other components registered in ctx.services.turnTools (C: make_file,
// share_file, artifact, web_fetch). Served over the same MCP connection as the file tools (mcp__team__<name>).
import path from 'node:path'
import { z } from 'zod'
import { AskUserInput, ConnectServiceInput, EDIT_FILES_DESCRIPTION, EDIT_FILES_TOOL, EditFilesInput, FILE_TOOLS, FindSkillsInput, ForgetInput, RememberInput, SetTitleInput, SkillInput, uuidv7 } from '@mycel/shared'
import type { BrowserToolName, Locale, Step, TurnRequest } from '@mycel/shared/api'
import type { McpContent, TurnToolSet } from '../turns'
import type { TurnTool, TurnToolContext } from '../services'
import { newId } from '../db'
import { PANE_TOOLS, scriptsOf, urlsOf } from '../realtime/browser-tools'
import { browserUrl, isPrivateHost, staticPrivateHost } from '../realtime/private-net'
import { cleanMemoryText, MEMORY_ITEM_MAX, neutralizeTags, skillBlock } from './prompt'
import { isPersonalSkill, listSkills, readSkill, skillFolder, type Skill } from './skills'
import { frequentSkills, matchSkills, resolveSkill, shortDescription, skillTag, usageScores } from './skill-list'
import { addSources, sourceOf } from './read-scope'
import { authorize } from '../policy/authorize'
import type { Principal } from '../policy/access'
import { tr } from './i18n'
import type { TurnExec } from './turn'
import type { TurnFiles } from '../files/service'
import { extractUrls, gateUrl, type ConfirmExtra, type TurnPerson } from '../tools/url-gate'
import { ToolError } from '../policy/errors'
import { visionText } from '../files/vision-text'
import { hwpOutputPath } from '../files/hwpx-check'
import { hwpWritingOffText, hwpWritingOn, writesHangul } from '../tools/hwp-writing'
import { recordSkillRead, recordSkillUse } from '../admin/skill-usage'
import { templateToolRefusal } from './schedule-templates'
import { cleanAiTitle, graphemes, setAiTitle, titleToolOffered } from './title'
import { recordSent } from '../tools/connection-urls'
import { BOX_SHELL_TOOL, boxShellTool } from '../devenv/tool'
import { connectService } from './connect-service'
import { DRAFT_FILE_REFUSAL, draftToolRefusal, draftUrlRefusal } from '../onboarding/draft'
import { ROOM_TOOLS } from '../rooms/ai-tools'
import { SKILL_DRAFT_FILE_REFUSAL } from '../onboarding/skill-draft'
import { roomReadTools, roomSessionFileTools } from './room-tools'
import { hideUrls } from '../tools/audit-url'
import { SHARE_JUDGE_REFUSAL } from '../skills/share-judge'
import { mergeTargets, SHARE_MERGE_REFUSAL } from '../skills/share-merge'

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** the step label (and the room card's words) of a call, when the shared words do not say enough */
  label?(args: unknown, locale: Locale): string
  /** a call the tool will refuse whatever the person says, refused before any card is raised (null: go on) */
  refuse?(args: unknown): { text: string; summary: string } | null
  /** `files`: the calling agent's turn state (the main AI's, or a sub-agent's: TurnFiles.forAgent) */
  call(args: unknown, files: TurnFiles): Promise<{ content: McpContent[]; isError?: boolean; summary?: string }>
}

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })
const zodText = (e: z.ZodError) => 'Invalid input: ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

export const B_TOOL_DESCRIPTIONS = {
  remember: 'Remember one lasting fact or preference about the user for future chats (one short sentence, under 300 characters). Only when the user wants it kept. Returns the memory id.',
  forget: 'Forget one memory by its id (the ids are shown in the memories block of your instructions).',
  ask_user: 'Ask the user a question and wait for the answer. Offer options when you can; allowText also shows a text box on the card. The user can always answer in their own words from the message box instead. Returns {"answer": ...} with an option value or the user\'s own text (a list of them when multiple), or {"skipped": true} when the user does not answer in time.',
  connect_service: 'Connect a service for the user (an MCP server or an HTTP API: Notion, Linear, GitHub, Higgsfield, any other), or their Google Drive (target google_drive). Fill in the service\'s official address from its documentation (prefer its MCP endpoint, and oauth when it offers sign-in); the user then pastes their key into the card or signs in there. The key never reaches you: never ask for it in the chat. Returns {"connected": true, "name", "status", "tools"} once it works, or {"skipped": true} when the user does not finish the card; without a card, a text says why (a field to fix, a connection that already exists, or what is not allowed). Its tools are offered from the user\'s next message, not in this answer.',
  set_title: 'Name this new chat: a short title in the user\'s language that says what the person wants (2-60 characters). Call it once, early in your answer. Never put keys, tokens, passwords, personal data or quotes of the message in it.',
  skill: 'Load one of the user\'s skills (a saved team or personal workflow) by its name as listed under Team skills in your instructions, and get its full steps. Call it when a request matches a skill, before you follow it; then follow the steps and say which skill you used. A folder skill\'s other files are read with read, relative to the folder the result names.',
  find_skills: 'Search the skills the user can use by words (their names, descriptions and folders), best first, at most 10; with no word in common it lists the skills the user uses most. Use it when no skill in your instructions\' list clearly fits but the request looks like a saved workflow (the list may be cut). Then load the one that fits with skill.',
} as const

/** A turn's tool set, plus what per-person tools add: a section for the instructions and their own step labels. */
export interface ChatToolSet extends TurnToolSet {
  /** sections for the AI's instructions from per-person tools (connected services) */
  prompt: string[]
  /** the same for a resumed session's turn context (shorter where a provider says so) */
  context: string[]
  /** the step label a per-person tool gives its call, or null for the shared labels */
  stepLabel(name: string, input: unknown, locale: Locale): string | null
}

/** box_shell's waiting state on its step (Step.devEnvRun). The first write of a call finds the call's step through
 * patchToolStep (it may not exist yet); later writes of the same run go to that step by its id. */
function boxShellQueueStep(exec: TurnExec): (run: NonNullable<Step['devEnvRun']>) => void {
  const stepOf = new Map<string, string>()
  /** the newest state of a run whose step was not found yet: one patch per run, so a second write before the step
   * exists does not land on the step of the next box_shell call (patchToolStep's FIFO) */
  const pending = new Map<string, NonNullable<Step['devEnvRun']>>()
  return (run) => {
    const id = stepOf.get(run.id)
    if (id) { exec.updateStep(id, { devEnvRun: run }); return }
    const first = !pending.has(run.id)
    pending.set(run.id, run)
    if (!first) return
    exec.patchToolStep(BOX_SHELL_TOOL, (s) => {
      stepOf.set(run.id, s.id)
      const latest = pending.get(run.id) ?? run
      pending.delete(run.id)
      return { devEnvRun: latest }
    })
  }
}

export function buildToolSet(exec: TurnExec): ChatToolSet {
  const confidential=confidentialChat(exec.rt.db,exec.spec.chatId)
  const tools = new Map<string, Tool>()
  const labels = new Map<string, (args: unknown, locale: Locale) => string>()
  const templateWrites = new Set<string>()
  const add = (t: Tool): boolean => {
    // a company profile draft (onboarding/draft.ts): web_fetch is its only tool besides the refused file tools, and a
    // draft from pasted text has none
    if (exec.profileDraft && (t.name !== 'web_fetch' || exec.profileDraft.scope.source !== 'website')) return false
    // a team skill draft (onboarding/skill-draft.ts), a skill share's judgement (skills/share-judge.ts) or its merge
    // (skills/share-merge.ts): no tool at all besides the file tools (refused, or for a merge only on its team skills)
    if (exec.skillDraft || exec.shareJudge || exec.shareMerge) return false
    if(confidential && !localTool(t.name)) return false
    // a team chat room's AI session (rooms/ai.ts): only the tools rooms/ai-tools.ts allows there
    if (exec.room && !ROOM_TOOLS.has(t.name)) return false
    if (t.name in FILE_TOOLS || tools.has(t.name)) { exec.rt.log.warn('turn tool name taken, skipped', { tool: t.name }); return false }
    tools.set(t.name, t)
    if (t.label) labels.set(t.name, t.label.bind(t))
    return true
  }
  for (const t of bTools(exec)) add(t)
  for (const t of skillTools(exec)) add(t)
  // the person's own team chat rooms (chat/room-tools.ts): not in a room's session (ROOM_TOOLS does not list them), nor
  // in a confidential or draft chat (add() above keeps those to their own tools)
  // nor in an approved scheduled template's run (its scope is fixed; it would refuse them anyway). A room's own session
  // gets its room's files instead (the asking message's and earlier ones: room_file, save_room_file)
  if (!exec.templateRun) for (const t of exec.room ? roomSessionFileTools(exec) : roomReadTools(exec)) add(t)
  // edit_files is listed here so the engines and the model proxy allow it, but the MCP handler runs it
  // (mcp/protocol.ts editFiles): each file as its own edit call with the checks above. Never offered in confidential
  // chats (add() keeps to the local tools there). Reaching this call() means the handler did not: nothing is changed.
  add({ name: EDIT_FILES_TOOL, description: EDIT_FILES_DESCRIPTION, inputSchema: schema(EditFilesInput),
    async call() { return { ...text('Error: internal error', true), summary: `${EDIT_FILES_TOOL} -> not run (outside the file gate)` } } })
  for (const t of exec.rt.ctx.services.turnTools ?? []) {
    try { if (t.available && !t.available({ userId: exec.spec.userId, chatId: exec.spec.chatId, browser: exec.browser })) continue } catch { continue }
    add(wrapRegistered(exec, t))
  }
  if (exec.devEnv) {
    const person = turnPerson(exec)
    add(boxShellTool({
      queueStep: boxShellQueueStep(exec),
      ctx: exec.rt.ctx, project: exec.devEnv.project, userId: exec.spec.userId, turnId: exec.spec.turnId, chatId: exec.spec.chatId, signal: exec.abort.signal,
      redact: (s) => exec.redact(s),
      unattended: person.unattended,
      confirm: async (question, options, details) => (person.choose
        ? person.choose(question, options, { details: [{ label: 'Changes', text: details.join('\n') }] })
        : (await person.confirm(question, options[0]!.label, options[1]!.label, { details: [{ label: 'Changes', text: details.join('\n') }] })) ? options[0]!.value : null),
      // the site card: a server card for the person who owns the turn, in each of her windows (not only the one that
      // sent the turn); a scheduled run gets no card (waitForPerson answers null = not allowed)
      askSite: async (host, command) => {
        const answer = await exec.waitForPerson({ kind: 'dev_env_site', requestId: uuidv7(), host, command, expiresAt: new Date(Date.now() + exec.rt.askUserTimeoutMs()).toISOString() }, { timeoutMs: exec.rt.askUserTimeoutMs() })
        return answer === 'once' || answer === 'always' || answer === 'deny' ? answer : null
      },
    }))
  }
  if (exec.browser) for (const t of PANE_TOOLS) add(browserTool(exec, t.name as BrowserToolName, t.description, t.inputSchema as unknown as Record<string, unknown>))
  // per-person tools (external-service connections), built from saved data at the start of the turn
  const prompt: string[] = []
  const context: string[] = []
  // no connection's tools in a room (rooms/ai-tools.ts ROOM_TOOLS), and so no "Connected services" section either
  for (const p of confidential || exec.restricted || exec.room ? [] : exec.rt.ctx.services.turnToolProviders ?? []) {
    let built: ReturnType<typeof p.build>
    try { built = p.build({ userId: exec.spec.userId, chatId: exec.spec.chatId, turnId: exec.spec.turnId, browser: exec.browser, scheduled: exec.spec.clientKind === 'schedule' }) }
    catch (e) { exec.rt.log.warn('turn tool provider failed', { provider: p.name, err: e }); continue }
    for (const t of built.tools) if (add(wrapRegistered(exec, t)) && t.label) labels.set(t.name, t.label.bind(t))
    if (built.prompt) prompt.push(built.prompt)
    const ctxText = built.context === undefined ? built.prompt : built.context
    if (ctxText) context.push(ctxText)
  }
  return {
    prompt,
    context,
    stepLabel(name, input, locale) { try { return labels.get(name)?.(input, locale) ?? null } catch { return null } },
    list: () => [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    has: (n) => tools.has(n),
    async call(name, args, caller) {
      const files = caller?.files ?? exec.files
      // a profile draft: the same site and at most 4 pages per answer, counted before the call starts
      if (exec.skillDraft) return { ...text(SKILL_DRAFT_FILE_REFUSAL, true), summary: `${name} -> refused: team skill draft (no tools)` }
      if (exec.shareJudge) return { ...text(SHARE_JUDGE_REFUSAL, true), summary: `${name} -> refused: skill share judgement (no tools)` }
      if (exec.shareMerge) return { ...text(SHARE_MERGE_REFUSAL, true), summary: `${name} -> refused: skill share merge (no tools)` }
      const draftNo = exec.profileDraft ? draftToolRefusal(exec.profileDraft, name, args) : null
      if (draftNo) return { ...text(draftNo, true), summary: `${name} -> refused: company profile draft (${draftNo.slice(0, 80)})` }
      const refusal = templateToolRefusal(exec.rt.ctx, exec.spec.userId, exec.id, name, args, templateWrites)
      if (refusal) return { ...text(refusal, true), summary: 'scheduled template scope refused' }
      if (writesHangul(name, args) && !hwpWritingOn(exec.rt.ctx)) {
        // Hangul writing comes with the HWP plugin (tools/hwp-writing.ts): make_file .hwpx while it is off, or edit_hwp
        // after it was turned off during this turn, is refused before anyone is asked anything (the tool refuses it too)
        return { ...text(hwpWritingOffText(exec.spec.locale), true), summary: `${name} -> refused: Hangul writing is off (HWP plugin)` }
      }
      const t = tools.get(name)!
      // a call the tool refuses anyway asks nobody first and counts as nothing read (save_room_file without a file id,
      // into skills/, …)
      const early = t.refuse?.(args)
      if (early) return { ...text(early.text, true), summary: early.summary }
      exec.noteTaint(name, args)
      exec.noteRoomTool(name, args)
      // a room's AI session: anything that may change something waits for the person's yes (rooms/ai-tools.ts)
      const roomNo = await exec.confirmRoomChange(name, args)
      if (roomNo) return { ...text(roomNo, true), summary: `${name} -> not allowed by the user (${exec.room ? 'room' : 'after a room read'})` }
      // what the AI sends leaves marks, so an address that a connection repeats back is not taken as the service's own
      // (tools/connection-urls.ts; before the call: its own answer is checked against them)
      recordSent(exec.rt.db, exec.spec.chatId, args)
      if (name === 'make_file' || name === 'edit_hwp') {
        // under skills/: the person confirms first (the file layer refuses the save otherwise)
        const no = await exec.confirmSkillWrite(name, args, files)
        if (no) return { content: [{ type: 'text', text: no.refusal }], isError: true, summary: no.summary }
      }
      if (name === 'make_file' && args && typeof args === 'object') {
        // the new file carries what the chat read, and the `source` file it is made from: asked before converting.
        // The images it embeds and its template are only known after parsing; make_file asks again for those
        // (ToolCtx.confirmWidening) before the file is placed.
        const a = args as { output?: unknown; source?: unknown }
        const refusal = typeof a.output === 'string' ? await exec.confirmWidening(a.output, typeof a.source === 'string' ? [a.source] : []) : null
        if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true, summary: 'make_file -> not allowed by the user (wider audience)' }
      }
      if (name === 'edit_hwp' && args && typeof args === 'object') {
        // like write and edit: what the chat read may go where more people see it (asked before the worker runs); a new
        // file also carries the document it is made from
        const a = args as { output?: unknown; file_path?: unknown }
        const target = typeof a.output === 'string' ? hwpOutputPath(a.output, typeof a.file_path === 'string' ? a.file_path : '') : a.file_path
        const refusal = typeof target === 'string' ? await exec.confirmWidening(target, typeof a.output === 'string' && typeof a.file_path === 'string' ? [a.file_path] : []) : null
        if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true, summary: 'edit_hwp -> not allowed by the user (wider audience)' }
      }
      const out = await t.call(args, files)
      // a room session: a link share_file made says the path exists; the path as the server resolved it (actual case and
      // Unicode form) counts like a name read (turn.ts noteReads), besides the path as given (noteRoomTool)
      if (exec.room && name === 'share_file' && !out.isError) {
        const p = (args as { path?: unknown } | null)?.path
        try { if (typeof p === 'string') files.namePaths.add(authorize(exec.rt.files.fx, exec.rt.files.rules(), exec.livePrincipal(), p, 'read').rel) } catch { /* the call already failed for it */ }
      }
      exec.afterTool()
      // the audit line (tool_events) never repeats a stored connection secret (integrations/connections/redact.ts), and
      // in a chat that read team chat rooms keeps of an address only its site (tools/audit-url.ts): admins read it
      const summary = exec.redact(out.summary ?? `${name} -> ${out.isError ? 'error' : 'ok'}`)
      return { content: out.content, isError: out.isError, summary: !exec.room && exec.roomsSeen ? hideUrls(summary) : summary }
    },
    afterFileTool: (name, isError, args) => {
      exec.noteTaint(name, args); exec.noteRoomTool(name, args); exec.noteReads(); exec.afterTool()
      const filePath = (args as { file_path?: unknown } | null)?.file_path
      if (!isError && name === 'read' && typeof filePath === 'string')
        recordSkillRead(exec.rt.db, exec.rt.files, exec.livePrincipal(), exec.id, filePath)
    },
    // edit_files (mcp/protocol.ts): in a room one card for the whole batch, before its first file
    beforeBatch: async (name, args) => {
      const no = await exec.confirmRoomChange(name, args)
      return no ? { refusal: no, summary: `${name} -> not allowed by the user (${exec.room ? 'room' : 'after a room read'})` } : null
    },
    beforeFileTool: async (name, args, caller) => {
      if (exec.profileDraft) return { refusal: DRAFT_FILE_REFUSAL, summary: `${name} -> refused: company profile draft (no team files)` }
      if (exec.skillDraft) return { refusal: SKILL_DRAFT_FILE_REFUSAL, summary: `${name} -> refused: team skill draft (no team files)` }
      if (exec.shareJudge) return { refusal: SHARE_JUDGE_REFUSAL, summary: `${name} -> refused: skill share judgement (no team files)` }
      // a skill share's merge: read, write and edit of exactly the team skills it merges into; write and edit go on to the
      // skill-write card below like anywhere else
      if (exec.shareMerge && !mergeAllows(exec, name, args)) return { refusal: SHARE_MERGE_REFUSAL, summary: `${name} -> refused: skill share merge (only its team skills)` }
      const refusal = templateToolRefusal(exec.rt.ctx, exec.spec.userId, exec.id, name, args, templateWrites)
      if (refusal) return { refusal, summary: 'scheduled template scope refused' }
      recordSent(exec.rt.db, exec.spec.chatId, args)
      // a room's AI session: a write or edit waits for the person's yes on a card first (rooms/ai-tools.ts)
      const roomNo = await exec.confirmRoomChange(name, args)
      if (roomNo) return { refusal: roomNo, summary: `${name} -> not allowed by the user (${exec.room ? 'room' : 'after a room read'})` }
      if (name !== 'write' && name !== 'edit') return null
      // skills/ first (team skills and rules: the person confirms what changes), then the wider-audience check
      const no = await exec.confirmSkillWrite(name, args, caller?.files)
      if (no) return no
      const p = (args as { file_path?: unknown } | null)?.file_path
      return typeof p === 'string' ? exec.confirmWidening(p) : null
    },
  }
}

/** A merge chat's file call: read, write or edit, on one of the team skill files it merges into (the path as the file
 * layer resolves it for this person: its letter case and Unicode form). Anything else is refused. */
function mergeAllows(exec: TurnExec, name: string, args: unknown): boolean {
  if (name !== 'read' && name !== 'write' && name !== 'edit') return false
  const p = (args as { file_path?: unknown } | null)?.file_path
  if (typeof p !== 'string' || !p.trim()) return false
  const targets = mergeTargets(exec.shareMerge!)
  let rel: string
  try { rel = authorize(exec.rt.files.fx, exec.rt.files.rules(), exec.livePrincipal(), p, name === 'read' ? 'read' : 'write', { mustExist: name !== 'write' }).rel } catch { return false }
  return targets.has(rel.normalize('NFC'))
}

/** The person of this turn for tools that need a server-raised confirmation (web_fetch URLs, design tab 7). */
export function turnPerson(exec: TurnExec): TurnPerson {
  const choose = async (question: string, options: { label: string; value: string }[], extra?: ConfirmExtra): Promise<string | null> => {
    const answer = await exec.waitForPerson({
      kind: 'ask_user', origin: 'server', requestId: uuidv7(), question, options,
      multiple: false, allowText: false, expiresAt: new Date(Date.now() + exec.rt.askUserTimeoutMs()).toISOString(),
      ...(extra?.details?.length ? { details: extra.details } : {}),
    } as TurnRequest, { timeoutMs: exec.rt.askUserTimeoutMs() })
    const v = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
    // only one of the card's own answers counts (never free text)
    return typeof v === 'string' && options.some((o) => o.value === v) ? v : null
  }
  return {
    locale: exec.spec.locale,
    choose,
    async confirm(question, allow, deny, extra) {
      return (await choose(question, [{ label: allow, value: 'allow' }, { label: deny, value: 'deny' }], extra)) === 'allow'
    },
    *turnUrls() { for (const s of exec.steps) for (const src of s.sources ?? []) yield src.url },
    // waitForPerson answers "no answer" at once in a scheduled run; tools say why instead of "declined". A company
    // profile draft raises no card either: its screen shows none, so only the typed address and links of its pages open
    unattended: exec.spec.clientKind === 'schedule' || exec.restricted,
    ...(exec.profileDraft ? { unattendedLabel: 'company profile draft answer', scope: (url: string) => draftUrlRefusal(exec.profileDraft!.scope, url), ...(exec.profileDraft.pages ? { pages: exec.profileDraft.pages } : {}) } : {}),
  }
}

function toolContext(exec: TurnExec, files: TurnFiles): TurnToolContext {
  return {
    turnId: exec.spec.turnId, chatId: exec.spec.chatId, userId: exec.spec.userId, messageId: exec.spec.assistantId, locale: exec.spec.locale,
    signal: exec.abort.signal,
    files: {
      signal: exec.abort.signal,
      user: exec.livePrincipal(), turnId: exec.spec.turnId, files, person: turnPerson(exec),
      // files a tool copies bytes from (make_file's embedded images and template), checked before the new file is placed
      confirmWidening: (target, sources, binding) => exec.confirmWidening(target, sources, binding),
    },
  }
}

function wrapRegistered(exec: TurnExec, t: TurnTool): Tool {
  return {
    name: t.name, description: t.description, inputSchema: t.inputSchema,
    async call(args, files) {
      const r = await t.call(args, toolContext(exec, files))
      return { content: r.content, isError: r.isError, ...(r.summary ? { summary: r.summary } : {}) }
    },
  }
}

// ---------------- skill / find_skills ----------------
// Like Claude Code's Skill tool, for every engine and sub-agent (docs/DECISIONS.md "Skills: the whole list, the skill
// tool"): the instructions list every skill by name (chat/skill-list.ts) and the AI loads the one it needs. Each call
// walks the skills of the person as they are now (team skills they can read, their own personal skills), so a skill in
// a folder they cannot read is never named, found or loaded. A loaded skill counts like a read of its file: usage
// (team skills only), the chat's read scope and outside content.
const clipName = (s: string, n = 120) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

function skillTools(exec: TurnExec): Tool[] {
  const { rt, spec } = exec
  const person = (): Principal | null => { try { return exec.livePrincipal() } catch { return null } }
  return [
    {
      name: 'skill', description: B_TOOL_DESCRIPTIONS.skill, inputSchema: schema(SkillInput),
      async call(args) {
        const a = SkillInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const user = person()
        if (!user) return { ...text('Access denied: this account is disabled.', true), summary: 'skill -> denied: account disabled' }
        const skills = listSkills(rt.files, user)
        // in a room the names it offers back are only of skills everyone there may read (they may reach the room), and
        // the answer is as if the others did not exist; a skill named exactly that only the person may read still loads
        // (its folder then joins the read scope), but never one of several of the same name
        const shown = exec.roomReadable ? skills.filter((s) => exec.roomReadable!(s.path)) : skills
        let hit = resolveSkill(shown, a.data.name)
        if (!hit && exec.roomReadable) { const any = resolveSkill(skills, a.data.name); if (any && !('ambiguous' in any)) hit = any }
        if (hit && 'ambiguous' in hit) {
          return { ...text(`Several skills this user can use are called "${neutralizeTags(clipName(a.data.name))}": ${hit.ambiguous.map((s) => s.path).join(', ')}. Call skill again with the path of the one you mean.`, true), summary: `skill -> ambiguous (${hit.ambiguous.length})` }
        }
        // read again through the file checks (the same answer for a missing file and one the person cannot read)
        const skill = hit ? readSkill(rt.files, user, hit.skill.path) : null
        if (!skill) {
          const near = matchSkills(shown, a.data.name, { limit: 5 }).map((m) => `"${neutralizeTags(clipName(m.skill.name, 64))}"`)
          return {
            ...text(`No skill called "${neutralizeTags(clipName(a.data.name))}" that this user can use.${near.length ? ` Similar: ${near.join(', ')}.` : ''} Use a name from the skill list in your instructions, or look with find_skills.`, true),
            summary: 'skill -> not found',
          }
        }
        exec.noteTaint('read', { file_path: skill.path })
        // like a "/name" skill: its folder joins the chat's read scope (what is saved from it asks before going wider)
        addSources(rt.db, spec.chatId, [sourceOf(rt.db, rt.files.rules(), skillFolder(skill.path))])
        // reporting is auxiliary (admin/skill-usage.ts: team and group skills, never a personal one); a loaded skill is a
        // run (the onboarding goal counts it), unlike a plain read of the file
        try { recordSkillUse(rt.db, { turnId: spec.turnId, userId: spec.userId, skill, source: 'tool' }) } catch { rt.log.warn('skill usage recording failed', { turn: spec.turnId }) }
        return { ...text(skillBlock(skill, '', 'loaded')), summary: `skill -> ${isPersonalSkill(skill.path) ? 'a personal skill' : skill.path}` }
      },
    },
    {
      name: 'find_skills', description: B_TOOL_DESCRIPTIONS.find_skills, inputSchema: schema(FindSkillsInput),
      async call(args) {
        const a = FindSkillsInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const user = person()
        if (!user) return { ...text('Access denied: this account is disabled.', true), summary: 'find_skills -> denied: account disabled' }
        // in a room only the skills everyone there may read (their names and descriptions may reach the room)
        const skills = listSkills(rt.files, user).filter((s) => !exec.roomReadable || exec.roomReadable(s.path))
        const scores = usageScores(rt.db, spec.userId, skills.map((s) => s.path))
        const hits = matchSkills(skills, a.data.query, { scores, projectFolder: exec.projectFolder })
        const q = neutralizeTags(clipName(a.data.query, 80))
        const line = (s: Skill) => `- ${neutralizeTags(clipName(s.name, 64))}${skillTag(s, neutralizeTags)}${s.description.trim() ? ': ' + neutralizeTags(shortDescription(s.description, 300)) : ''} (${s.path})`
        const searched = `${skills.length} skill${skills.length === 1 ? '' : 's'} searched`
        if (!hits.length) {
          if (!skills.length) return { ...text(`No skill this user can use matches "${q}" (${searched}).`), summary: 'find_skills -> 0 found' }
          // no word in common (Korean words against English descriptions, other words for the same thing): the skills
          // the person uses most, so the AI can still judge from their descriptions, instead of nothing
          const top = frequentSkills(skills, scores)
          const head = top.used
            ? `No skill matches "${q}" by its words (${searched}). These are the skills this user uses most; their descriptions may be in another language than the request. Load one with skill if it fits; otherwise try other words or go on without a skill:`
            : `No skill matches "${q}" by its words (${searched}). These are skills this user can use; their descriptions may be in another language than the request. Load one with skill if it fits; otherwise try other words or go on without a skill:`
          return { ...text([head, ...top.skills.map(line)].join('\n')), summary: `find_skills -> 0 found, ${top.skills.length} frequent` }
        }
        const lines = hits.map(({ skill: s }) => line(s))
        return { ...text([`${hits.length} skill${hits.length === 1 ? '' : 's'} matching "${q}", best first. Load the one that fits with skill (its name) before you follow it:`, ...lines].join('\n')), summary: `find_skills -> ${hits.length} found` }
      },
    },
  ]
}

// ---------------- remember / forget / ask_user / connect_service / set_title ----------------
function bTools(exec: TurnExec): Tool[] {
  const { rt, spec } = exec
  const L = spec.locale
  const tools: Tool[] = [
    {
      name: 'remember', description: B_TOOL_DESCRIPTIONS.remember, inputSchema: schema(RememberInput),
      async call(args) {
        const a = RememberInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const clean = cleanMemoryText(a.data.text)
        if (!clean.ok) return clean.problem === 'empty' ? text('Invalid input: text is empty', true) : text(`Too long (${clean.length} characters). Keep a memory under ${MEMORY_ITEM_MAX} characters.`, true)
        const value = clean.text
        let source: 'ai' | 'user' = 'ai'
        // this conversation has seen outside content, or once had a team chat room's messages in it (chats.rooms_seen,
        // kept for the rest of the chat): the person confirms before anything is kept (tab 3)
        if (exec.tainted || exec.roomsSeen) {
          const answer = await exec.waitForPerson({
            kind: 'ask_user', origin: 'server', requestId: uuidv7(), question: tr('rememberConfirm', L, { text: value }),
            options: [{ label: tr('yes', L), value: 'yes' }, { label: tr('no', L), value: 'no' }], multiple: false, allowText: false,
          } as TurnRequest, { timeoutMs: rt.askUserTimeoutMs() })
          if (answer !== 'yes' && !(Array.isArray(answer) && answer[0] === 'yes')) {
            exec.patchToolStep('remember', () => ({ label: tr('notRemembered', L, { text: value }).slice(0, 500), detail: tr('notAnswered', L) }))
            return { ...text('The user did not confirm, so nothing was remembered. Do not try again unless the user asks.'), summary: 'remember -> not confirmed' }
          }
          source = 'user'
        }
        const id = newId()
        rt.db.query('INSERT INTO memories (id, user_id, text, source_chat_id, source, created_turn_id, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, spec.userId, value, spec.chatId, source, spec.turnId, new Date().toISOString())
        const row = rt.db.query('SELECT id, text, source_chat_id, created_at FROM memories WHERE id = ?').get(id) as { id: string; text: string; source_chat_id: string | null; created_at: string }
        rt.hub.publish(spec.userId, { type: 'memory.changed', data: { change: 'created', memory: rt.store.toMemory(row) } })
        exec.patchToolStep('remember', () => ({ label: tr('remembered', L, { text: value }).slice(0, 500), detail: `memory:${id}` }))
        return { ...text(JSON.stringify({ id })), summary: `remember -> ${id} (${source})` }
      },
    },
    {
      name: 'forget', description: B_TOOL_DESCRIPTIONS.forget, inputSchema: schema(ForgetInput),
      async call(args) {
        const a = ForgetInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const r = rt.db.query('DELETE FROM memories WHERE id = ? AND user_id = ?').run(a.data.id, spec.userId)
        if (!r.changes) return text(`No memory with id ${a.data.id}.`, true)
        rt.hub.publish(spec.userId, { type: 'memory.changed', data: { change: 'deleted', memory: null } })
        return { ...text(JSON.stringify({ ok: true })), summary: `forget -> ${a.data.id}` }
      },
    },
    {
      name: 'ask_user', description: B_TOOL_DESCRIPTIONS.ask_user, inputSchema: schema(AskUserInput),
      async call(args) {
        const a = AskUserInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const request: TurnRequest = {
          kind: 'ask_user', requestId: uuidv7(), question: a.data.question,
          ...(a.data.options ? { options: a.data.options } : {}), ...(a.data.multiple !== undefined ? { multiple: a.data.multiple } : {}),
          ...(a.data.allowText !== undefined ? { allowText: a.data.allowText } : {}),
          expiresAt: new Date(Date.now() + rt.askUserTimeoutMs()).toISOString(),
        }
        const answer = await exec.waitForPerson(request, { timeoutMs: rt.askUserTimeoutMs() })
        if (answer === null || answer === undefined) {
          exec.patchToolStep('ask_user', () => ({ detail: tr('notAnswered', L) }))
          return { ...text(JSON.stringify({ skipped: true })), summary: 'ask_user -> skipped' }
        }
        exec.patchToolStep('ask_user', () => ({ detail: (Array.isArray(answer) ? answer.join(', ') : String(answer)).slice(0, 4000) }))
        return { ...text(JSON.stringify({ answer })), summary: 'ask_user -> answered' }
      },
    },
    {
      // the AI fills in the connection, the person finishes it on the card: the key goes from the card to the server and
      // never through this call (chat/connect-service.ts, docs/INTEGRATIONS.md "Connecting from a chat")
      name: 'connect_service', description: B_TOOL_DESCRIPTIONS.connect_service, inputSchema: schema(ConnectServiceInput),
      call: (args) => connectService(exec, args),
    },
  ]
  // the answering AI names a new chat (title.ts): no extra model call. The title shows in the sidebar and the header
  // at once (chat.updated); the call is not a step under the answer (turn.ts). The audit keeps no title text.
  if (titleToolOffered(rt.db, spec.chatId, spec.clientKind)) tools.push({
    name: 'set_title', description: B_TOOL_DESCRIPTIONS.set_title, inputSchema: schema(SetTitleInput),
    async call(args) {
      const a = SetTitleInput.safeParse(args)
      if (!a.success) return text(zodText(a.error), true)
      // a title that holds a stored connection secret is refused like one that looks like a secret
      const t = exec.redact(a.data.title) !== a.data.title ? { ok: false as const, reason: 'secret' as const } : cleanAiTitle(a.data.title)
      if (!t.ok) {
        return {
          ...text(t.reason === 'secret'
            ? 'Not set: the title looks like it contains a key, token or password. Call set_title again with a title that only says what the person wants.'
            : 'Not set: nothing is left of the title once markdown, quotes and punctuation are removed. Give 2-60 characters of words.', true),
          summary: `set_title -> refused (${t.reason})`,
        }
      }
      if (!setAiTitle(rt.db, spec.chatId, t.title))
        return { ...text('Not set: this chat already has its title (the user named it, or you already did). Do not call set_title again.'), summary: 'set_title -> kept the existing title' }
      rt.publishChat(spec.userId, spec.chatId, 'updated')
      return { ...text(JSON.stringify({ ok: true, title: t.title })), summary: `set_title -> ok (${graphemes(t.title).length} characters)` }
    },
  })
  return tools
}

// ---------------- browser pane tools ----------------
// Every address the AI opens in the pane goes through the same rules as web_fetch (design tab 7 "프롬프트 주입":
// a GET can carry data out in its address, https://attacker/?d=<secret>): an address that never appeared in the
// conversation, or one with a long query, needs the person to confirm the full URL first, on a card the server raises
// (tools/url-gate.ts). Office-network addresses additionally need the site card below. Addresses written out in code
// the AI runs in the page (javascript_tool) are checked the same way. Links on pages the pane showed are NOT added to
// the "seen" addresses (unlike web_fetch): the AI can put anything on a page it drives (form_input, javascript_tool)
// and read it back, which would launder an address of its own making.
// A name is looked up in DNS (is it the office network?) only after the address card passed: the name itself can
// carry data to the attacker's DNS server even when the person declines (docs/DECISIONS.md "Outbound web channels").
// An IP literal or a local name needs no lookup and gets the office-network card at once.
function browserTool(exec: TurnExec, name: BrowserToolName, description: string, inputSchema: Record<string, unknown>): Tool {
  const { rt, spec } = exec
  return {
    name, description, inputSchema,
    async call(rawArgs) {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>
      const person = turnPerson(exec)
      /** null when the address may be opened; otherwise the refusal for the AI */
      const gate = async (href: string): Promise<string | null> => {
        try {
          await gateUrl(rt.db, spec.chatId, href, person, { turnId: spec.turnId, userId: spec.userId })
          return null
        } catch (e) {
          if (e instanceof ToolError) return e.message
          throw e
        }
      }
      for (const url of urlsOf(name, args)) {
        const u = browserUrl(url)
        if (!u.ok) return { ...text(`Cannot open ${url.slice(0, 200)}: ${u.reason}.`, true), summary: `${name} -> refused url (${u.reason})` }
        const host = u.host
        if (!host || !u.href) continue
        const office = async (): Promise<Awaited<ReturnType<Tool['call']>> | 'ok' | 'shown'> => {
          if (exec.allowedHosts.has(host) || rt.siteGranted(spec.userId, host)) return 'ok'
          const decision = await exec.waitForPerson({ kind: 'browser_site', requestId: uuidv7(), url: url.slice(0, 2000), host, reason: tr('browserSite', spec.locale, { host }) }, { window: spec.windowId, timeoutMs: rt.askUserTimeoutMs() })
          if (decision === 'always') rt.grantSite(spec.userId, host)
          else if (decision === 'once') exec.allowedHosts.add(host)
          else return { ...text(`The user did not allow opening ${host} (an office-network address). Stop and tell the user what you could not do.`, true), summary: `${name} -> site ${host} not allowed` }
          // the office-network card showed the full address (up to 2000 characters)
          return url.length <= 2000 ? 'shown' : 'ok'
        }
        // an IP literal or a local name: the office-network card first (no DNS), and no second card for the address
        if (staticPrivateHost(host) === true) {
          const r = await office()
          if (typeof r === 'object') return r
          if (r === 'shown') continue
        }
        const refusal = await gate(u.href)
        if (refusal) return { ...text(`Cannot open ${u.href.slice(0, 200)}: ${refusal}.`, true), summary: `${name} -> ${u.href.slice(0, 300)} not allowed (address check)` }
        // a name: looked up only now; one that leads into the office network still needs the office-network card
        if (staticPrivateHost(host) === null && await isPrivateHost(host)) {
          const r = await office()
          if (typeof r === 'object') return r
        }
      }
      for (const code of scriptsOf(name, args)) {
        for (const href of new Set(extractUrls(code))) {
          const refusal = await gate(href)
          if (refusal) return { ...text(`The script was not run: it contains the address ${href.slice(0, 200)}, and ${refusal}.`, true), summary: `${name} -> script address ${href.slice(0, 300)} not allowed (address check)` }
        }
      }
      const r = await rt.relay.call({ userId: spec.userId, windowId: spec.windowId!, turnId: spec.turnId, chatId: spec.chatId, tool: name, args, signal: exec.abort.signal })
      const content: McpContent[] = []
      const shared: { path: string; alt?: string }[] = []
      // a screenshot reaches the model like an image read: the team's "Send images, PDF pages and video frames to the AI" switch, an
      // engine that takes images and the per-turn image budget (FileService.toolImage); else a note in its place.
      // One the AI chose to show the person is shown either way (the chat, not the model)
      const notes = new Set<string>()
      for (const c of r.content) {
        if (c.type === 'text') content.push({ type: 'text', text: c.text })
        else {
          const note = rt.files.toolImage({ user: { id: spec.userId }, turnId: spec.turnId, files: exec.files }, Buffer.byteLength(c.data, 'base64'))
          if (!note) content.push({ type: 'image', data: c.data, mimeType: c.mime })
          else if (!notes.has(note)) { notes.add(note); content.push({ type: 'text', text: `${note} ${visionText(rt.db, spec.userId, 'browserInstead')}` }) }
          if (c.shareToChat) { const p = saveScreenshot(exec, c.data, c.mime); if (p) shared.push({ path: p, alt: 'screenshot' }) }
        }
      }
      if (!r.ok) content.push({ type: 'text', text: `Error: ${r.error ?? 'browser tool failed'}` })
      exec.patchToolStep(name, (s) => (shared.length ? { images: [...(s.images ?? []), ...shared] } : {}))
      if (!content.length) content.push({ type: 'text', text: r.ok ? 'OK' : 'Error' })
      return { content, isError: !r.ok, summary: `${name} -> ${r.ok ? 'ok' : 'error: ' + (r.error ?? '').slice(0, 200)}` }
    },
  }
}

/** Screenshots the AI chose to show: saved in the person's chat attachment folder, shown under the step. */
function saveScreenshot(exec: TurnExec, b64: string, mime: string): string | null {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const rel = path.posix.join('users', exec.spec.userId, '.attachments', exec.spec.chatId, `screenshot-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`)
  try {
    exec.rt.files.writeBytes({ user: exec.livePrincipal(), turnId: exec.spec.turnId, files: exec.files }, rel, Buffer.from(b64, 'base64'), new Map(), 'human')
    return rel
  } catch (e) {
    exec.rt.log.warn('saving a shared screenshot failed', { err: e })
    return null
  }
}
