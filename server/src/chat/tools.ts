import { confidentialChat, localTool } from "../safe-ops/confidential"
// The tools of one turn besides the six file tools: B's remember / forget / ask_user / connect_service / set_title and the browser pane tools
// (desktop window only), plus whatever other components registered in ctx.services.turnTools (C: make_file,
// share_file, artifact, web_fetch). Served over the same MCP connection as the file tools (mcp__team__<name>).
import path from 'node:path'
import { z } from 'zod'
import { AskUserInput, ConnectServiceInput, EDIT_FILES_DESCRIPTION, EDIT_FILES_TOOL, EditFilesInput, FILE_TOOLS, FindSkillsInput, ForgetInput, MoveSkillInput, RememberInput, SetTitleInput, SkillInput, uuidv7 } from '@mycel/shared'
import type { BrowserToolName, ConfirmDetail, Locale, Step, TurnRequest } from '@mycel/shared/api'
import type { McpContent, TurnToolSet } from '../turns'
import type { TurnTool, TurnToolContext } from '../services'
import { newId } from '../db'
import { PANE_TOOLS, scriptsOf, urlsOf } from '../realtime/browser-tools'
import { browserUrl, isPrivateHost, staticPrivateHost } from '../realtime/private-net'
import { cleanMemoryText, MEMORY_ITEM_MAX, neutralizeTags, skillBlock } from './prompt'
import { isPersonalSkill, listSkills, readSkill, skillFolder, type Skill } from './skills'
import { changeLine, editorsLine, levelFor, levelLabel, levelRef, levelsOf, MOVE_MAX_BYTES, MOVE_MAX_FILES, MOVE_TEXT_MAX, peopleNames, peopleText, planMove, raisesTrust, runCopy, runMove, seesWho, skillAt, type Level, type MovePlan } from '../skills/move'
import { st as skillText } from '../skills/text'
import { audit as auditLog } from '../admin/audit'
import { HttpError } from '../http/errors'
import { foldKey } from '../policy/names'
import { frequentSkills, matchSkills, resolveSkill, shortDescription, skillTag, usageScores } from './skill-list'
import { addSources, sourceOf } from './read-scope'
import { authorize } from '../policy/authorize'
import type { Principal } from '../policy/access'
import { tr } from './i18n'
import type { TurnExec, WidenOf } from './turn'
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
import { ROOM_TOOLS, SEARCH_TOOLS, SHARED_TOOLS } from '../rooms/ai-tools'
import { SKILL_DRAFT_FILE_REFUSAL } from '../onboarding/skill-draft'
import { roomReadTools, roomSessionTools } from './room-tools'
import { skillFilesTool } from './skill-files'
import { projectChatTools } from './room-project-chats'
import { hideUrls } from '../tools/audit-url'
import { SHARE_JUDGE_REFUSAL } from '../skills/share-judge'
import { FILE_RANK_REFUSAL } from '../onboarding/file-rank'
import { mergeTargets, SHARE_MERGE_REFUSAL } from '../skills/share-merge'

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** the step label (and the room card's words) of a call, when the shared words do not say enough */
  label?(args: unknown, locale: Locale): string
  /** a call the tool will refuse whatever the person says, refused before any card is raised (null: go on) */
  refuse?(args: unknown, files?: TurnFiles): { text: string; summary: string } | null
  /** where a call saves and where its bytes come from, so a room change and the wider-audience card are one card
   * (chat/turn.ts confirmRoomChange); for a tool that saves itself after asking confirmWidening (save_room_file) */
  widen?(args: unknown): WidenOf | undefined
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
  move_skill: 'Move one of the user\'s skills to another level, or copy it there when the user asks for a copy (keep: true; the original stays): the whole team, one of the user\'s groups, a project (only that project\'s chats use it) or the user\'s own skills, any move the user could make with the Move item on the Skills page. Nothing moves or is copied until the user says yes on the server\'s card, which says who newly gets the skill, who stops getting it and who newly may change it, lists every file and shows SKILL.md; you do not need to ask first. A copy is every file of the skill, byte for byte, in one card. The same checks as the Skills page: the user can write the target (and, for a move, the skill\'s place), no skill of that name is at the target, a project takes SKILL.md folders and no name a wider skill has. One name runs personal > group > team > project, so a project copy under the name of a skill the user keeps at a wider level would not run for its people, the user included: give the copy another name (name) or move it instead. A refusal says why and what to do: tell the user that in their words. The result says who gains and loses it (by name when the user may see that), so you can answer who. Skills never move or copy with move_files or copy_files, and never write a copy file by file; never leave a README or an empty skills folder as a stand-in. A folder that is not a project yet must be made a project first.',
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
    // (skills/share-merge.ts), 팀 파일's picks (onboarding/file-rank.ts): no tool at all besides the file tools (refused,
    // or for a merge only on its team skills)
    if (exec.skillDraft || exec.shareJudge || exec.shareMerge || exec.fileRank) return false
    if(confidential && !localTool(t.name)) return false
    // a team chat room's AI session (rooms/ai.ts): only the tools rooms/ai-tools.ts allows there
    if (exec.room && !ROOM_TOOLS.has(t.name)) return false
    // a shared project chat (chat/shared.ts): the same allowlist without the room's own tools
    if (exec.shared && !SHARED_TOOLS.has(t.name)) return false
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
  // gets its room's files instead (the asking message's and earlier ones: room_file, save_room_file) and its threads
  // (room_thread: one thread of that room)
  if (!exec.templateRun && !exec.shared) for (const t of exec.room ? roomSessionTools(exec) : roomReadTools(exec)) add(t)
  // a room's own session also finds and reads the shared project chats the asker may view (chat/room-project-chats.ts;
  // ROOM_TOOLS lists them, SHARED_TOOLS does not, and a person's own chat never gets them)
  if (!exec.templateRun && !exec.shared && exec.room) for (const t of projectChatTools(exec)) add(t)
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
  for (const p of confidential || exec.restricted || exec.room || exec.shared ? [] : exec.rt.ctx.services.turnToolProviders ?? []) {
    let built: ReturnType<typeof p.build>
    try { built = p.build({ userId: exec.spec.userId, chatId: exec.spec.chatId, turnId: exec.spec.turnId, browser: exec.browser, scheduled: exec.spec.clientKind === 'schedule' }) }
    catch (e) { exec.rt.log.warn('turn tool provider failed', { provider: p.name, err: e }); continue }
    for (const t of built.tools) if (add(wrapRegistered(exec, t)) && t.label) labels.set(t.name, t.label.bind(t))
    if (built.prompt) prompt.push(built.prompt)
    const ctxText = built.context === undefined ? built.prompt : built.context
    if (ctxText) context.push(ctxText)
  }
  const set: ChatToolSet = {
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
      if (exec.fileRank) return { ...text(FILE_RANK_REFUSAL, true), summary: `${name} -> refused: team file picks (no tools)` }
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
      const early = t.refuse?.(args, files)
      if (early) return { ...text(early.text, true), summary: early.summary }
      // a shared project chat: a search without a path looks in the project folder; then what the call would read that
      // some of the chat's people cannot read waits for the person's yes (chat/turn.ts confirmSharedRead)
      if (exec.shared) {
        args = exec.sharedArgs(name, args)
        // the neutral step line only for the main AI's own call (a sub-agent's step is matched by its id, not here)
        const sharedNo = await exec.confirmSharedRead(name, args, { step: files === exec.files })
        if (sharedNo) return { ...text(sharedNo, true), summary: `${name} -> not read: not shared by the user (shared chat)` }
      }
      exec.noteTaint(name, args)
      exec.noteRoomTool(name, args)
      // a room's AI session: anything that may change something waits for the person's yes (rooms/ai-tools.ts); a call
      // that also needs the wider-audience card below gets that one card (widenOf, or the tool's own widen: where it
      // saves, what it copies, where its bytes come from)
      const roomNo = await exec.confirmRoomChange(name, args, { widen: t.widen ? t.widen(args) : widenOf(name, args), main: files === exec.files })
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
      // a call a room grant or [이번만] let through: checked again now that any card above has waited (chat/turn.ts)
      const again = await exec.recheckRoomCover(name, args, { main: files === exec.files })
      if (again) return { ...text(again, true), summary: `${name} -> not allowed by the user (room)` }
      const out = await t.call(args, files)
      // a room session: a link share_file made says the path exists; the path as the server resolved it (actual case and
      // Unicode form) counts like a name read (turn.ts noteReads), besides the path as given (noteRoomTool)
      if (exec.room && name === 'share_file' && !out.isError) {
        const p = (args as { path?: unknown } | null)?.path
        try { if (typeof p === 'string') files.namePaths.add(authorize(exec.rt.files.fx, exec.rt.files.rules(), exec.livePrincipal(), p, 'read').rel) } catch { /* the call already failed for it */ }
      }
      exec.afterTool()
      // a new file left loose at the top of shared/, a group's folder or the team root: the server's note (chat/file-placement.ts)
      const note = exec.placementNote(tools.has('move_files'))
      // the audit line (tool_events) never repeats a stored connection secret (integrations/connections/redact.ts), and
      // in a chat that read team chat rooms keeps of an address only its site (tools/audit-url.ts): admins read it
      const summary = exec.redact(out.summary ?? `${name} -> ${out.isError ? 'error' : 'ok'}`)
      return { content: note ? [...out.content, { type: 'text', text: note }] : out.content, isError: out.isError, summary: !exec.room && exec.roomsSeen ? hideUrls(summary) : summary }
    },
    afterFileTool: (name, isError, args) => {
      // a skill save's approval is for that call only, saved or not (skills/guard.ts)
      exec.dropSkillApproval(name, args)
      exec.noteTaint(name, args); exec.noteRoomTool(name, args); exec.noteReads(); exec.afterTool()
      const filePath = (args as { file_path?: unknown } | null)?.file_path
      if (!isError && name === 'read' && typeof filePath === 'string')
        recordSkillRead(exec.rt.db, exec.rt.files, exec.livePrincipal(), exec.id, filePath)
      return exec.placementNote(tools.has('move_files'))
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
      if (exec.fileRank) return { refusal: FILE_RANK_REFUSAL, summary: `${name} -> refused: team file picks (no team files)` }
      // a skill share's merge: read, write and edit of exactly the team skills it merges into; write and edit go on to the
      // skill-write card below like anywhere else
      if (exec.shareMerge && !mergeAllows(exec, name, args)) return { refusal: SHARE_MERGE_REFUSAL, summary: `${name} -> refused: skill share merge (only its team skills)` }
      const refusal = templateToolRefusal(exec.rt.ctx, exec.spec.userId, exec.id, name, args, templateWrites)
      if (refusal) return { refusal, summary: 'scheduled template scope refused' }
      // a shared project chat: grep and glob without a path look in the project folder (the call's own arguments are
      // changed: the file tool reads these); what the call would read that some of the chat's people cannot read waits
      // for the person's yes (chat/turn.ts confirmSharedRead)
      if (exec.shared) {
        if (SEARCH_TOOLS.has(name) && args && typeof args === 'object') Object.assign(args, exec.sharedArgs(name, args))
        const sharedNo = await exec.confirmSharedRead(name, args, { step: !caller || caller.files === exec.files })
        if (sharedNo) return { refusal: sharedNo, summary: `${name} -> not read: not shared by the user (shared chat)` }
      }
      recordSent(exec.rt.db, exec.spec.chatId, args)
      // a room's AI session: a write or edit waits for the person's yes on a card first (rooms/ai-tools.ts); one that
      // also needs the wider-audience card below gets that one card
      const roomNo = await exec.confirmRoomChange(name, args, { widen: widenOf(name, args), main: !caller || caller.files === exec.files })
      if (roomNo) return { refusal: roomNo, summary: `${name} -> not allowed by the user (${exec.room ? 'room' : 'after a room read'})` }
      if (name !== 'write' && name !== 'edit') return null
      // skills/ first (team skills and rules: the person confirms what changes), then the wider-audience check
      const no = await exec.confirmSkillWrite(name, args, caller?.files)
      if (no) return no
      const p = (args as { file_path?: unknown } | null)?.file_path
      const widen = typeof p === 'string' ? await exec.confirmWidening(p) : null
      // refused after the skill card: its approval goes with the call (afterFileTool drops it after a save)
      if (widen) { exec.dropSkillApproval(name, args); return widen }
      // a call a room grant or [이번만] let through: checked again now that any card above has waited (chat/turn.ts)
      const again = await exec.recheckRoomCover(name, args, { main: !caller || caller.files === exec.files })
      if (again) exec.dropSkillApproval(name, args)
      return again ? { refusal: again, summary: `${name} -> not allowed by the user (room)` } : null
    },
  }
  // a skill save's approval (make_file, edit_hwp) is for its call only: dropped when the call ends, saved or not
  // (skills/guard.ts; a failed call left one for the rest of the turn)
  const run = set.call
  set.call = async (name, args, caller) => { try { return await run(name, args, caller) } finally { exec.dropSkillApproval(name, args) } }
  return set
}

/** Where a call's wider-audience check (below the room card) saves, and the files it copies bytes from: the same
 * arguments as the checks in call() and beforeFileTool (write and edit: the file; make_file: its output and source;
 * edit_hwp: the new file and the document, or the document itself). undefined for any other tool. */
export function widenOf(name: string, args: unknown): WidenOf | undefined {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : null
  if (!a) return undefined
  if (name === 'write' || name === 'edit') return typeof a.file_path === 'string' ? { target: a.file_path, extra: [] } : undefined
  if (name === 'make_file') return typeof a.output === 'string' ? { target: a.output, extra: typeof a.source === 'string' ? [a.source] : [] } : undefined
  if (name === 'edit_hwp') {
    const target = typeof a.output === 'string' ? hwpOutputPath(a.output, typeof a.file_path === 'string' ? a.file_path : '') : a.file_path
    return typeof target === 'string' ? { target, extra: typeof a.output === 'string' && typeof a.file_path === 'string' ? [a.file_path] : [] } : undefined
  }
  return undefined
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

/** `call`: the tool call this context is for: a room call a grant or [이번만] let through is checked again after the
 * tool's own wider-audience card (it may have waited: make_file's pictures and template) */
function toolContext(exec: TurnExec, files: TurnFiles, call?: { tool: string; args: unknown }): TurnToolContext {
  return {
    turnId: exec.spec.turnId, chatId: exec.spec.chatId, userId: exec.spec.userId, messageId: exec.spec.assistantId, locale: exec.spec.locale,
    signal: exec.abort.signal,
    files: {
      signal: exec.abort.signal,
      user: exec.livePrincipal(), turnId: exec.spec.turnId, files, person: turnPerson(exec),
      // files a tool copies bytes from (make_file's embedded images and template), checked before the new file is placed
      confirmWidening: async (target, sources, binding) => {
        const no = await exec.confirmWidening(target, sources, binding)
        if (no || !call) return no
        return exec.recheckRoomCover(call.tool, call.args, { main: files === exec.files })
      },
    },
  }
}

function wrapRegistered(exec: TurnExec, t: TurnTool): Tool {
  return {
    name: t.name, description: t.description, inputSchema: t.inputSchema,
    async call(args, files) {
      const r = await t.call(args, toolContext(exec, files, { tool: t.name, args }))
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
        const skills = listSkills(rt.files, user, exec.skillScope(false))
        // in a room the names it offers back are only of skills everyone there may read (they may reach the room), and
        // the answer is as if the others did not exist; a skill named exactly that only the person may read still loads
        // (its folder then joins the read scope), but never one of several of the same name. A shared chat picks each
        // name's winner among what everyone who sees it may use (docs/DECISIONS.md "Project skills")
        const shown = exec.shared && exec.roomReadable ? listSkills(rt.files, user, exec.skillScope(true)) : exec.roomReadable ? skills.filter((s) => exec.roomReadable!(s.path)) : skills
        let hit = resolveSkill(shown, a.data.name)
        if (!hit && exec.roomReadable) { const any = resolveSkill(skills, a.data.name); if (any && !('ambiguous' in any)) hit = any }
        if (hit && 'ambiguous' in hit) {
          return { ...text(`Several skills this user can use are called "${neutralizeTags(clipName(a.data.name))}": ${hit.ambiguous.map((s) => s.path).join(', ')}. Call skill again with the path of the one you mean.`, true), summary: `skill -> ambiguous (${hit.ambiguous.length})` }
        }
        // a shared project chat: a skill some of its people cannot read is loaded only after the person's yes
        if (hit && exec.shared) {
          const no = await exec.confirmSharedRead('skill', { path: skillFolder(hit.skill.path) })
          if (no) return { ...text(no, true), summary: 'skill -> not read: not shared by the user (shared chat)' }
        }
        // read again through the file checks (the same answer for a missing file and one the person cannot read)
        const skill = hit ? readSkill(rt.files, user, hit.skill.path, { project: exec.skillProject }) : null
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
        const skills = (exec.shared && exec.roomReadable ? listSkills(rt.files, user, exec.skillScope(true)) : listSkills(rt.files, user, exec.skillScope(false))).filter((s) => !exec.roomReadable || exec.roomReadable(s.path))
        const scores = usageScores(rt.db, spec.userId, skills.map((s) => s.path))
        const hits = matchSkills(skills, a.data.query, { scores })
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
    moveSkillTool(exec),
    skillFilesTool(exec),
  ]
}

// ---------------- move_skill ----------------
// One skill to another level (skills/move.ts, docs/DECISIONS.md "Project skills"), as the Skills page's 옮기기… moves it,
// or a copy of it (`keep`, with `name` for a new name) when the person asks for one: the same checks, then the person's
// yes on the server's card, which the AI cannot write. The card says who newly gets the skill, who stops getting it and
// who newly may change it (by name only to the owner, admins and a project's creator for its side: seesWho; counts for
// everyone else), lists every file and always shows SKILL.md (in full when anyone new gets it or it would be followed
// ahead of where it is now). Its yes is bound to every file's hash, the name and who gets it and may change it
// (`token`), checked again as it moves or is copied. Every refusal tells the AI why and what to do.
// Not offered in rooms or shared chats (rooms/ai-tools.ts); refused in a scheduled run (nobody to ask).
function moveSkillTool(exec: TurnExec): Tool {
  const { rt, spec } = exec
  const ctx = rt.ctx
  const bad = (t: string, summary: string) => ({ ...text(t, true), summary: `move_skill -> ${summary}` })
  const toPage = 'They can also move it with the Move item in the skill\'s menu on the Skills page (shown in their screen language).'
  const list = (xs: string[], max = 10) => (xs.length ? xs.slice(0, max).map((x) => `"${neutralizeTags(clipName(x, 60))}"`).join(', ') + (xs.length > max ? ` and ${xs.length - max} more` : '') : 'none')
  return {
    name: 'move_skill', description: B_TOOL_DESCRIPTIONS.move_skill, inputSchema: schema(MoveSkillInput),
    async call(args) {
      const a = MoveSkillInput.safeParse(args)
      if (!a.success) return text(zodText(a.error), true)
      const copy = a.data.keep === true
      const verb = copy ? 'copied' : 'moved'
      if (a.data.name !== undefined && !copy) return bad('Not moved: name is only for a copy (keep: true). A moved skill keeps its name; to rename one, edit its SKILL.md and folder (the user confirms on a card).', 'refused: name without keep')
      if (spec.clientKind === 'schedule') return bad(`Not ${verb}: a scheduled run has nobody to confirm the card. Tell the user to ${copy ? 'ask for the copy' : 'move the skill'} in a chat${copy ? '' : ' or with the Move item in the skill\'s menu on the Skills page (shown in their screen language)'}.`, 'refused: scheduled run')
      if (exec.room || exec.shared || exec.restricted || exec.templateRun) return bad(`Not ${verb}: a skill is moved or copied only from the user's own chat, where they answer the card (not from a room, a shared chat or a run limited to one task). Tell the user to ask in one of their own chats.${copy ? '' : ' ' + toPage}`, 'refused: not here')
      let user: Principal
      try { user = exec.livePrincipal() } catch { return bad('Access denied: this account is disabled.', 'denied: account disabled') }
      const L = spec.locale
      // the skill: by its name in this chat's list, else by its path (a project's skill from another project too)
      const skills = listSkills(rt.files, user, exec.skillScope(false))
      const hit = resolveSkill(skills, a.data.skill)
      if (hit && 'ambiguous' in hit) return bad(`Several skills this user can use are called "${neutralizeTags(clipName(a.data.skill))}": ${hit.ambiguous.map((s) => s.path).join(', ')}. Call move_skill again with the path of the one you mean.`, `ambiguous (${hit.ambiguous.length})`)
      const have = hit ? skillAt(ctx, user, hit.skill.path) : skillAt(ctx, user, a.data.skill.trim().replace(/^\/+/, ''))
      if (!have) return bad(`No skill called "${neutralizeTags(clipName(a.data.skill))}" that this user can use. Use a name from the skill list in your instructions, or find it with find_skills.`, 'not found')
      // the target level
      const levels = levelsOf(ctx, user)
      const groups = levels.flatMap((l) => (l.level === 'group' ? [l.group.name] : []))
      const projects = levels.flatMap((l) => (l.level === 'project' ? [l.project.name] : []))
      let to: Level | undefined
      const fold = (x: string) => foldKey(x.trim().replace(/^\/+|\/+$/g, ''))
      if (a.data.to === 'team' || a.data.to === 'personal') to = levels.find((l) => l.level === a.data.to)
      else if (a.data.to === 'group') {
        if (!a.data.group) return bad(`Name the group (group) to ${copy ? 'copy' : 'move'} the skill to. The user's groups: ${list(groups)}.`, 'no group named')
        to = levels.find((l) => l.level === 'group' && fold(l.group.name) === fold(a.data.group!))
        if (!to) return bad(`Not ${verb}: "${neutralizeTags(clipName(a.data.group, 60))}" is not one of the user's groups, and a skill goes only into a group the user is in (its members use it). The user's groups: ${list(groups)}. Ask the user which one they mean; an admin can add them to another group in Admin › Groups.`, 'group not found')
      } else {
        const want = a.data.project ?? exec.skillProject?.name
        if (!want) return bad(`This chat has no project: name the project (project) to ${copy ? 'copy' : 'move'} the skill to. Projects the user sees: ${list(projects)}.`, 'no project named')
        to = levels.find((l) => l.level === 'project' && (fold(l.project.name) === fold(want) || fold(l.folder) === fold(want)))
        if (!to) {
          // a folder that is not a project (yet), a project without skills of its own, or nothing the person sees
          const row = rt.db.query('SELECT id, folder_path FROM projects WHERE trashed_with IS NULL').all() as { id: string; folder_path: string }[]
          const named = row.find((r) => fold(r.folder_path) === fold(want))
          if (named) return bad(`Not ${verb}: ${skillText('moveNoLevel', 'en')} Tell the user; a team project made with Projects › New project lives in projects/<name>/ and can have skills.`, 'project has no skills level')
          let folder = false
          try { folder = !!authorize(rt.files.fx, rt.files.rules(), user, want.trim(), 'list').st?.isDirectory() } catch { folder = false }
          if (folder) return bad(`'${neutralizeTags(clipName(want, 120))}' is not a project yet, so it has no project skills. Tell the user: ${skillText('moveNotProject', L, { folder: neutralizeTags(clipName(want, 120)) })} (Projects › New project, on that folder). Then ask again. Never leave a README or an empty skills folder there as a stand-in.`, 'refused: not a project')
          return bad(`Not ${verb}: no project called "${neutralizeTags(clipName(want, 80))}" that the user sees. Projects they see: ${list(projects)}. Ask the user which one they mean.`, 'project not found')
        }
      }
      if (!to) return bad(`Not ${verb}: that level cannot be used.`, 'no level')
      const said = (e: unknown, other: string) => (e instanceof HttpError && e.message ? e.message : other).replace(/\.+$/, '')
      let plan: MovePlan
      try { plan = planMove(ctx, user, have, to, L, { copy, name: a.data.name }) } catch (e) {
        if (e instanceof HttpError && e.extra.params?.reason === 'skill_too_large') return bad(`Not ${verb}: the skill folder is too large here (more than ${MOVE_MAX_FILES} files or ${MOVE_MAX_BYTES / 1024 / 1024} MB). Tell the user to ${copy ? 'copy' : 'move'} it on the Files screen.`, 'refused: too large')
        return bad(`Not ${verb}: ${said(e, 'the skill\'s files could not be read')}. Tell the user what is in the way.`, 'refused: files')
      }
      const en = (l: Level) => neutralizeTags(levelLabel(l, 'en'))
      // people for the AI, by the card's rule: names (up to 20) where the user may see who is at that level, else a count
      const who = (ids: readonly string[], at: Level) => {
        if (!seesWho(ctx, user, at)) return `${ids.length} ${ids.length === 1 ? 'person' : 'people'} (names are shown only to the owner, admins and a project's creator, so do not guess who)`
        const p = peopleNames(ctx, ids, 'en', 20)
        return [...p.names.map((n) => neutralizeTags(n)), ...(p.more ? [`${p.more} more`] : [])].join(', ')
      }
      const people = (p: MovePlan) => [
        changeLine(p, 'en'),
        p.gained ? `Newly get it: ${who(p.gainedIds, p.to)}.` : '',
        p.lost ? `Lose it: ${who(p.lostIds, p.from)}.` : '',
        p.editorsGained ? `Newly may change it: ${who(p.editorsGainedIds, p.to)}.` : '',
        p.shadows ? `A project skill of the same name in ${neutralizeTags(p.shadows)} is hidden for the people who get this one (one name runs personal > group > team > project).` : '',
      ].filter(Boolean).join(' ')
      if (plan.blocked) {
        // why, and what to do about it (who may write there, when it is the user's rights)
        let help = ''
        const k = plan.blocked.key
        if (k === 'moveNoWrite') {
          const fromSide = !copy && rt.files.rules().access(user, plan.source.split('/')) !== 'write'
          const ids = fromSide ? plan.fromEditorIds : plan.editorIds
          help = ` ${ids.length ? `Who can write there: ${who(ids, fromSide ? plan.from : plan.to)}.` : 'Nobody but an admin can write there.'} Tell the user: someone who can write there or an admin can do it, or an admin can give the user write access to that folder (Admin › Folder permissions).`
        } else if (k === 'moveTaken') help = ' Tell the user which skill has that name there; they decide which of the two to rename or remove first' + (copy ? ', or give the copy another name (name).' : '.')
        else if (k === 'moveHidden') help = ' In a project a wider skill of the same name always wins. Tell the user to rename this skill first if they want it in the project.'
        else if (k === 'copyHidden') help = ' Tell the user this plainly, then suggest a name for the copy and call move_skill again with keep and that name once they agree, or move the skill instead (move_skill without keep).'
        else if (k === 'copyRuled') help = ` It is ${neutralizeTags(plan.source)}. Tell the user; an admin can see that folder's permissions in Admin › Folder permissions.`
        else if (k === 'moveNotFolder') help = ` It is ${neutralizeTags(plan.skill.path)}. Tell the user.`
        else if (k === 'folderName') help = ' Call move_skill again with a name like "estimate-docs-quotation".'
        return bad(`Not ${verb}: ${neutralizeTags(skillText(k, 'en', plan.blocked.vars))}${help}`, `refused: ${k}`)
      }
      const from = levelLabel(plan.from, L), dest = levelLabel(plan.to, L)
      // SKILL.md is always on the card, from the bytes the token binds; in full when anyone new gets it or it would be
      // followed ahead of where it is now (out of a project's chats, into a group or the user's own)
      const full = plan.gained > 0 || raisesTrust(plan)
      const why = plan.gained > 0 ? skillText('moveGained', L) : plan.from.level === 'project' && plan.to.level !== 'project' ? skillText('moveLeavesProject', L, { project: plan.from.project.name }) : raisesTrust(plan) ? skillText('moveTrust', L, { to: dest }) : ''
      const head = copy
        ? plan.name !== plan.skill.name ? skillText('copyConfirmNamed', L, { name: plan.skill.name, as: plan.name, from, to: dest }) : skillText('copyConfirm', L, { name: plan.skill.name, from, to: dest })
        : skillText('moveConfirm', L, { name: plan.skill.name, from, to: dest })
      const question = [
        `${head}\n${changeLine(plan, L)}\n${editorsLine(plan, L)}`,
        plan.shadows ? skillText('moveShadows', L, { name: plan.name, where: plan.shadows }) : '',
        why,
      ].filter(Boolean).join('\n\n')
      // names only where the person may see who is there; the counts are in the line above
      const card = (ids: readonly string[]) => peopleText(peopleNames(ctx, ids, L, 5), L)
      const fields = [
        plan.gained && seesWho(ctx, user, plan.to) ? { name: skillText('moveWhoGains', L), value: card(plan.gainedIds) } : null,
        plan.lost && seesWho(ctx, user, plan.from) ? { name: skillText('moveWhoLoses', L), value: card(plan.lostIds) } : null,
        plan.editorsGained && seesWho(ctx, user, plan.to) ? { name: skillText('moveWhoEdits', L), value: card(plan.editorsGainedIds) } : null,
      ].filter((x): x is { name: string; value: string } => !!x)
      const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
      const cut = plan.text.length > MOVE_TEXT_MAX
      const details: ConfirmDetail[] = [
        ...(fields.length ? [{ label: skillText('moveWho', L), text: '', fields }] : []),
        { label: `${skillText('moveText', L, { file: plan.entry.split('/').pop()! })}${cut ? ' ' + skillText('moveTextCut', L) : ''}`, text: plan.text.slice(0, MOVE_TEXT_MAX), ...(full ? {} : { collapsedAt: 600 }) },
        { label: skillText('moveFiles', L), text: plan.files.map((f) => `${f.path} (${size(f.size)})`).join('\n') },
      ]
      const base = plan.source.split('/').pop()!
      const answer = await exec.waitForPerson({
        kind: 'ask_user', origin: 'server', requestId: uuidv7(), question, multiple: false, allowText: false,
        options: copy ? [{ label: skillText('copyYes', L), value: 'copy' }, { label: skillText('copyNo', L), value: 'skip' }] : [{ label: skillText('moveYes', L), value: 'move' }, { label: skillText('moveNo', L), value: 'skip' }],
        details,
        ...(!copy && plan.from.level === 'team' && plan.to.level !== 'personal' ? { note: skillText('moveNarrowHint', L, { name: base }).slice(0, 300) } : {}),
        expiresAt: new Date(Date.now() + rt.askUserTimeoutMs()).toISOString(),
      } as TurnRequest, { timeoutMs: rt.askUserTimeoutMs() })
      const yesValue = copy ? 'copy' : 'move'
      const yes = answer === yesValue || (Array.isArray(answer) && answer.length === 1 && answer[0] === yesValue)
      if (!yes) {
        auditLog(rt.db, { actor: spec.userId, action: 'skills.move_refused', target: plan.skill.path.startsWith('users/') ? plan.entry : plan.skill.path, detail: { name: plan.skill.name, to: levelRef(plan.to), copy, turnId: spec.turnId, answer: answer === null || answer === undefined ? 'none' : 'declined' } })
        return bad(`The user did not allow ${copy ? 'copying' : 'moving'} the skill "${neutralizeTags(plan.skill.name)}" from ${en(plan.from)} to ${en(plan.to)}, so nothing was ${verb}. The card said: ${people(plan)} Do not do it another way unless the user asks again, and never leave a README or an empty skills folder as a stand-in.`, 'not allowed by the user')
      }
      try {
        // checked again as it moves or is copied (the files, the name, the target, the rights, who gets it); its answer is
        // for the AI: in English
        const done = copy
          ? runCopy(ctx, user.id, plan.skill.path, levelRef(plan.to), plan.token, 'en', { name: a.data.name, turnId: spec.turnId, tool: 'move_skill' })
          : runMove(ctx, user.id, plan.skill.path, levelRef(plan.to), plan.token, 'en', { turnId: spec.turnId, tool: 'move_skill' })
        const what = copy ? `Copied the skill "${neutralizeTags(done.skill.name)}"${done.name !== done.skill.name ? ` as "${neutralizeTags(done.name)}"` : ''} from ${en(done.from)} to ${en(done.to)} (${done.toPeople} people): ${done.entry}. The original stays.` : `Moved the skill "${neutralizeTags(done.skill.name)}" from ${en(done.from)} (${done.fromPeople} people) to ${en(done.to)} (${done.toPeople} people): ${done.entry}.`
        return { ...text(`${what}${done.to.level === 'project' ? ' The AI follows it there only in that project\'s chats.' : ''} ${people(done)}`), summary: `move_skill -> ${verb} to ${done.to.level}` }
      } catch (e) {
        if (e instanceof HttpError && e.extra.params?.reason === 'skill_move_changed') return bad(`Not ${verb}: since the card was shown, ${changedSince(plan)}. Tell the user what changed; if they still want it, call move_skill again so they see a new card.`, 'refused: changed after the card')
        return bad(`Not ${verb}: ${said(e, 'it failed')}. Tell the user what is in the way.`, 'failed')
      }

      /** What differs from the card the person answered: files, who would get it, who could change it. */
      function changedSince(old: MovePlan): string {
        const now = skillAt(ctx, user, old.skill.path)
        if (!now) return 'the skill is no longer there'
        const lv = levelFor(ctx, user, levelRef(old.to))
        if (!lv) return `the user can no longer put skills at ${en(old.to)}`
        let p: MovePlan
        try { p = planMove(ctx, user, now, lv, 'en', { copy: old.copy, name: old.copy ? old.name : undefined }) } catch { return 'the skill\'s files changed' }
        const parts: string[] = []
        const fa = new Map(old.files.map((f) => [f.path, f.sha])), fb = new Map(p.files.map((f) => [f.path, f.sha]))
        const files = [...new Set([...fa.keys(), ...fb.keys()])].filter((k) => fa.get(k) !== fb.get(k))
        if (files.length) parts.push(`${files.length === 1 ? 'a file changed' : 'files changed'}: ${files.slice(0, 10).map((f) => neutralizeTags(f)).join(', ')}${files.length > 10 ? ` and ${files.length - 10} more` : ''}`)
        const added = (x: string[], y: string[]) => y.filter((id) => !x.includes(id))
        const reach = added(old.readerIds, p.readerIds), leave = added(p.readerIds, old.readerIds)
        const edit = added(old.editorIds, p.editorIds), stop = added(p.editorIds, old.editorIds)
        if (reach.length) parts.push(`it would now also reach ${who(reach, old.to)}`)
        if (leave.length) parts.push(`it would no longer reach ${who(leave, old.to)}`)
        if (edit.length) parts.push(`${who(edit, old.to)} could now also change it there`)
        if (stop.length) parts.push(`${who(stop, old.to)} could no longer change it there`)
        return parts.join('; ') || 'what the card showed changed'
      }
    },
  }
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
