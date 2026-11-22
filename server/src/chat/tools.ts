import { confidentialChat, localTool } from "../safe-ops/confidential"
// The tools of one turn besides the six file tools: B's remember / forget / ask_user / connect_service / set_title and the browser pane tools
// (desktop window only), plus whatever other components registered in ctx.services.turnTools (C: make_file,
// share_file, artifact, web_fetch). Served over the same MCP connection as the file tools (mcp__team__<name>).
import { trashHint } from './trash-hint'
import { isReservedPlace, parsePlace, type Place } from '@mycel/shared/places'
import { chatPlaces } from './place-ctx'
import { PLACE_WORDS } from '../files/places'
import { PLACE_PRODUCE_TOOLS } from '../files/place-output'
import { isFreeRoam } from '../app-config'
import { freeRoamToolCallRefused, freeRoamToolFenced } from '../demo/guard'
import { stampOutputOf } from '../tools/stamp-pdf'
import { commentDocxOutput } from '../tools/comment-docx'
import { editOfficeOutput } from '../tools/edit-office'
import { chatFileOffered, chatFileTool, chatPlaceHooks, saveChatFileTool } from './chat-file-tool'
import { answerCommentsOff, answerCommentsTool } from './answer-comments'
import path from 'node:path'
import { z } from 'zod'
import { AskUserInput, TodoWriteInput, ConnectServiceInput, EDIT_FILES_DESCRIPTION, EDIT_FILES_TOOL, EditFilesInput, FILE_TOOLS, FindSkillsInput, ForgetInput, MoveSkillInput, RememberInput, SetTitleInput, SkillInput, uuidv7 } from '@mycel/shared'
import { MEMORY_TEXT_MAX } from '@mycel/shared/api'
import type { BrowserToolName, ConfirmDetail, Locale, Step, TurnRequest } from '@mycel/shared/api'
import type { McpContent, TurnToolSet } from '../turns'
import type { ToolCard, TurnTool, TurnToolContext } from '../services'
import { newId } from '../db'
import { PANE_TOOLS, scriptsOf, urlsOf } from '../realtime/browser-tools'
import { browserUrl, isPrivateHost, staticPrivateHost } from '../realtime/private-net'
import { cleanMemoryText, MEMORY_ITEM_MAX, neutralizeTags, skillBlock, SKILL_TOOL_LIMIT } from './prompt'
import { isGroupSkill, isPersonalSkill, isProjectSkill, listSkills, ownPersonalSkill, readSkill, sameSkillName, skillAlias, skillFolder, skillIssues, type Skill, otherGroupSkills } from './skills'
import { changeLine, editorsLine, levelFor, levelLabel, levelRef, levelsOf, MOVE_MAX_BYTES, MOVE_MAX_FILES, MOVE_TEXT_MAX, peopleNames, peopleText, planMove, raisesTrust, runCopy, runMove, seesWho, skillAt, type Level, type MovePlan } from '../skills/move'
import { st as skillText } from '../skills/text'
import { audit as auditLog } from '../admin/audit'
import { HttpError } from '../http/errors'
import { foldKey } from '../policy/names'
import { frequentSkills, matchSkills, resolveSkill, shortDescription, skillTag, skillTitleText, usageScores } from './skill-list'
import { addSources, audiencePeople, pathAudience, sourceOf, type ReadSource } from './read-scope'
import { authorize } from '../policy/authorize'
import { atLeast, isStaff, type Principal } from '../policy/access'
import { walk } from '../policy/resolve'
import { sideRoomOf } from './side-room'
import { tr } from './i18n'
import { CARD_LATER_TOOLS, questionsWaitInCall } from './open-questions'
import { optionWords, threadOptionWords } from './share-words'
import { threadLook } from './thread-look'
import { alwaysHere, withAlways } from './always-allow'
import { fromAsker, othersWordsIn } from './shared-actions'
import type { CardAnswer, TurnExec, WidenOf } from './turn'
import { inProjectOnly, SKIP_OWN, wholeTeamPath } from './search-path'
import type { StoredStep } from './store'
import { cardEndShort, endOfText, projectNotFoundNote, readOnlyNote, readOnlySkillLine, type CardOutcome } from '../policy/refusal'
import { chatVersionPlace, mayReplace, placeArg, placeWriteRefusal, type TurnFiles } from '../files/service'
import { extractUrls, gateUrl, type ConfirmExtra, type TurnPerson } from '../tools/url-gate'
import { ToolError } from '../policy/errors'
import { callKey } from './schedule-cover'
import { visionText } from '../files/vision-text'
import { hwpOutputPath } from '../files/hwpx-check'
import { hwpWritingOffText, hwpWritingOn, writesHangul } from '../tools/hwp-writing'
import { recordSkillRead, recordSkillUse } from '../admin/skill-usage'
import { templateToolRefusal } from './schedule-templates'
import { cleanAiTitle, graphemes, setAiTitle, titleToolOffered } from './title'
import { recordSent } from '../tools/connection-urls'
import { BOX_SHELL_TOOL, boxShellTool, callerOf } from '../devenv/tool'
import { mayUseDevEnv } from '../devenv/setting'
import { inOldWorkFolder, noteSharedReads, runsInWorkFolder, spaceOf, workFolderAt, workFolderChange } from '../devenv/srt/runner'
import { NO_WORK_WORDS, workUnavailableText } from '../devenv/work-files'
import { saveWorkFileTool } from './work-file-tool'
import { COPY_FILES_TOOL, stagePlaceInput, withPlaces } from './places-copy'
import { connectService } from './connect-service'
import { DRAFT_FILE_REFUSAL, draftToolRefusal, draftUrlRefusal } from '../onboarding/draft'
import { namedPaths, SEARCH_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS } from '../rooms/ai-tools'
import { steerableWriteRefusal } from './shared-run'
import { SKILL_DRAFT_FILE_REFUSAL } from '../onboarding/skill-draft'
import { projectRoomOfChat, projectRoomTools, roomReadTools } from './room-tools'
import { hintsHere, roomHint } from './room-hint'
import { fileNote, fileNoteOnce } from './file-notes'
import { skillFilesTool } from './skill-files'
import { postToRoomOff, postToRoomTool } from './post-to-room'
import { shareWithPersonOff, shareWithPersonTool } from './share-with-person'
import { stopSharingOff, stopSharingTool } from './stop-sharing'
import { shareFolderOff, shareFolderTool } from './share-folder'
import { whoCanOpenOff, whoCanOpenTool } from './who-can-open'
import { sharedWithMeOff, sharedWithMeTool } from './shared-with-me-tool'
import { lookingAtOff, lookingAtTool } from './looking-at'
import { hideUrls } from '../tools/audit-url'
import { SHARE_JUDGE_REFUSAL } from '../skills/share-judge'
import { FILE_RANK_REFUSAL } from '../onboarding/file-rank'
import { mergeTargets, SHARE_MERGE_REFUSAL } from '../skills/share-merge'
import { deleteFilesTool } from './delete-files'
import { BULK_CARD_MS, bulkCard, type BulkAsk, type BulkWho } from '../devenv/bulk'
import { WALK_MAX } from '../files/access-routes'
import { projectMembersTool } from './project-members'
import { folderAccessOff, folderAccessTool } from './folder-access-tool'
import { readRooms } from './read-rooms'
import { seenWhy } from './grant-reads'
import { WEB_ACCESS_CHANGED } from '../admin/settings'
import { isGuestUser } from '../credentials/guest-ai'
import { GUEST_ROOM_TOOLS, GUEST_TURN_TOOLS, guestToolDescription } from './guest-tools'
import { guestPlace } from '../auth/guests'
import type { GuestPlace } from '@mycel/shared/api'
import { hideAllArgs, hideKeysInArgs, KEY_HIDING_TOOLS, KeyRefusal, UNCHECKED_REFUSAL } from '../integrations/connections/hide-args'
import { completeRedactorFor } from '../integrations/connections/redact'

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
  /** the connection a call writes to (a connection's tool that changes something there), else null: a scheduled run that
   * read a room skips the room card for it only when its task's card allowed both (chat/schedule-cover.ts) */
  sendsTo?(args: unknown): string | null
  /** `files`: the calling agent's turn state (the main AI's, or a sub-agent's: TurnFiles.forAgent) */
  call(args: unknown, files: TurnFiles): Promise<{ content: McpContent[]; isError?: boolean; summary?: string; beforeDelivery?: () => void }>
}

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })
const zodText = (e: z.ZodError) => 'Invalid input: ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

/** a safety card's call result when the card waits after the answer ends */
export const CARD_LATER_NOTE = 'Nothing was done yet: this needs the user\'s answer on the card that is now open for them, and the card waits until they answer. End your answer now: write at most one short line, call no more tools, and do not try another way. When they answer, this same call runs again with their answer and you get its result with their next message.'

/** ask_user's result when its card waits after the answer ends (chat/open-questions.ts) */
export const ASK_USER_LATER_NOTE = 'The card is open for the user and waits until they answer. End your answer now: write at most one short line, call no more tools, and do not answer the question yourself. Their answer comes as their next message in this chat; go on with the work from there.'

export const B_TOOL_DESCRIPTIONS = {
  remember: `Remember one lasting fact or preference about the user for future chats (one line, under ${MEMORY_TEXT_MAX} characters). Only when the user wants it kept. Returns the memory id.`,
  forget: 'Forget one memory by its id (the ids are shown in the memories block of your instructions).',
  ask_user: 'Ask the user a question on a card. When more than one thing is unclear (which file, and to whom or where), ask about all of them in this one question (options for the likeliest pairs, and allowText for the rest) rather than guessing the rest. Offer options when you can; allowText also shows a text box on the card. The user can always answer in their own words from the message box instead. In a chat the user watches the card waits as long as they need (minutes or days) and the call returns {"asked": true} at once: end your answer right after it; their answer comes as their next message in this chat (or {"skipped": true} for a skipped question), and you go on from there. Elsewhere (a scheduled run, a question from Slack) it waits for the answer and returns {"answer": ...} with an option value or the user\'s own text (a list of them when multiple), or {"skipped": true} when nobody answers in time.',
  todo_write: 'Keep a to-do list for this answer: the user sees it as a checklist under your answer that updates in place. Use it for work of 3 or more steps, or when the user gives several things to do: write the list before you start, mark an item in_progress just before you work on it (one at a time) and completed as soon as it is done, and add items you find on the way. Each call replaces the whole list. content: the task in the imperative ("Read the March invoices"); activeForm: the same while under way ("Reading the March invoices"). Skip it for a single or quick task, or a plain question.',
  connect_service: 'Connect a service for the user (by its MCP endpoint or HTTP API: Notion, Linear, GitHub, Higgsfield, any other), or their Google Drive (target google_drive). Gmail, Google Calendar, Google Docs and Google Sheets are built into the app: give only the name (no address; never look one up), and the result says how they connect. For others, fill in the service\'s official address from its documentation (prefer its MCP endpoint, and oauth when it offers sign-in); the user then pastes their key into the card or signs in there. The key never reaches you: never ask for it in the chat. Returns {"connected": true, "name", "status", "tools"} once it works, or {"skipped": true} when the user does not finish the card; without a card, a text says why (a field to fix, a connection that already exists, or what is not allowed). The result says when its tools are offered: in most chats this same answer goes on with them (then do what the request needed them for), else from the user\'s next message.',
  set_title: 'Name this new chat: a short title in the user\'s language that says what the person wants (2-60 characters). Call it once, early in your answer. Never put keys, tokens, passwords, personal data or quotes of the message in it.',
  skill: 'Load one of the user\'s skills (a saved team or personal workflow) by its name as listed under Team skills in your instructions, and get its full steps. Call it when a request matches a skill, before you follow it; then follow the steps and say which skill you used. A folder skill\'s other files are read with read, relative to the folder the result names.',
  find_skills: 'Search the skills the user can use by words (their names, descriptions and folders), best first, at most 10; with no word in common it lists the skills the user uses most. Use it when no skill in your instructions\' list clearly fits but the request looks like a saved workflow (the list may be cut). Then load the one that fits with skill.',
  move_skill: 'Move one of the user\'s skills to another level, or copy it there when the user asks for a copy (keep: true; the original stays): the whole team, one of the user\'s groups (an owner or admin: any group), a project (only that project\'s chats use it) or the user\'s own skills, any move the user could make with the Move item on the Skills page. Nothing moves or is copied until the user says yes on the server\'s card, which says who newly gets the skill, who stops getting it and who newly may change it, lists every file and shows SKILL.md; you do not need to ask first. A copy is every file of the skill, byte for byte, in one card. The same checks as the Skills page: the user can write the target (and, for a move, the skill\'s place), no skill of that name is at the target, a project takes SKILL.md folders and no name a wider skill has. One name runs personal > group > team > project, so a project copy under the name of a skill the user keeps at a wider level would not run for its people, the user included: give the copy another name (name) or move it instead. A refusal says why and what to do: tell the user that in their words. The result says who gains and loses it (by name when the user may see that), so you can answer who. Skills never move or copy with move_files or copy_files, and never write a copy file by file; never leave a README or an empty skills folder as a stand-in. A folder that is not a project yet must be made a project first.',
} as const

/** intro_deck's "read" step in a free-roam demo (demo/guard.ts freeRoamToolCallRefused) */
const DEMO_SITE_READER_OFF = 'Error: reading web pages is not available in this demo. Build the deck from the team\'s files and what the user tells you (step "outline" with sources from them).'

/** A turn's tool set, plus what per-person tools add: a section for the instructions and their own step labels. */
export interface ChatToolSet extends TurnToolSet {
  /** sections for the AI's instructions from per-person tools (connected services) */
  prompt: string[]
  /** outside content those sections carry (TurnToolProvider seen): marked by the turn once its session starts */
  seen: ReadSource[]
  /** the same for a resumed session's turn context (shorter where a provider says so) */
  context: string[]
  /** the step label a per-person tool gives its call, or null for the shared labels */
  stepLabel(name: string, input: unknown, locale: Locale): string | null
  /** a connection's tool (the integrations provider's, saying whether a call reads: TurnTool.readOnly); any other is not */
  connection(name: string): boolean
  /** a connection tool's call that only reads; false for a write and for any tool that is not a connection's */
  readsOnly(name: string, input: unknown): boolean
  /** ...and that may go without the room card after a room read (the service's own mark, not api_request's method) */
  readsFree(name: string, input: unknown): boolean
  /** a per-person tool's own words for the room card (TurnTool.card), or null for the shared ones */
  card?(name: string, input: unknown, locale: Locale): ToolCard | null
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

/** What steerableWriteRefusal weighs (chat/shared-run.ts): the write targets of each tool, and the tools that change in
 * place the files they name (Office edits, Word comments; save_promo_video's save_as) */
const RUN_WRITES = { writeArgs: { ...WRITE_TARGET_ARGS, edit_hwp: ['output'], save_promo_video: ['save_as'], generate_video: ['save_as'] }, named: namedPaths,
  inPlace: new Set(['edit_office', 'comment_docx', 'edit_hwp', 'edit_files']) } as const

export function buildToolSet(exec: TurnExec): ChatToolSet {
  const confidential=confidentialChat(exec.rt.db,exec.spec.chatId)
  // a guest's turn: only the tools of chat/guest-tools.ts, and no connection provider at all
  const guest = isGuestUser(exec.rt.db, exec.spec.userId)
  const guestInRoom = guest && ([guestPlace(exec.rt.db, exec.spec.userId)].flat() as (GuestPlace | null)[]).some((p) => p?.kind === 'room')
  const tools = new Map<string, Tool>()
  const labels = new Map<string, (args: unknown, locale: Locale) => string>()
  const cards = new Map<string, NonNullable<TurnTool['card']>>()
  const templateWrites = new Set<string>()
  /** a room session's connection tools: the asker's own Google apps (integrations/connections/tools.ts) */
  const add = (t: Tool, o: { connection?: boolean; projectRoom?: boolean } = {}): boolean => {
    // a company profile draft (onboarding/draft.ts): web_fetch is its only tool besides the refused file tools, and a
    // draft from pasted text has none
    if (exec.profileDraft && (t.name !== 'web_fetch' || exec.profileDraft.scope.source !== 'website')) return false
    // a team skill draft (onboarding/skill-draft.ts), a skill share's judgement (skills/share-judge.ts) or its merge
    // (skills/share-merge.ts), 팀 파일's picks (onboarding/file-rank.ts): no tool at all besides the file tools (refused,
    // or for a merge only on its team skills)
    if (exec.skillDraft || exec.shareJudge || exec.shareMerge || exec.fileRank) return false
    // a free-roam demo (demo/guard.ts FREE_ROAM_REFUSED_TOOLS): no new connections, no background work, nothing that
    // fetches an address the visitor picks, no dev environment, no video render; intro_deck without its site reader
    if (freeRoamToolFenced(exec.rt.ctx, t.name)) return false
    if (t.name === 'intro_deck' && freeRoamToolCallRefused(exec.rt.ctx, t.name, { step: 'read' })) {
      const inner = t
      t = { ...inner, async call(args, files) {
        if (freeRoamToolCallRefused(exec.rt.ctx, inner.name, args)) return { ...text(DEMO_SITE_READER_OFF, true), summary: 'intro_deck read -> refused: not in the demo' }
        return inner.call(args, files)
      } }
    }
    if(confidential && !localTool(t.name)) return false
    if (guest && !GUEST_TURN_TOOLS.has(t.name)) return false
    // ...and the room tools only for a guest whose place is a group chat (the one room they may read, chat/room-tools.ts)
    if (guest && GUEST_ROOM_TOOLS.has(t.name) && !guestInRoom) return false
    // ...and none of its words about what only team members have (Admin, plugins, skills, the browser)
    if (guest) t = { ...t, description: guestToolDescription(t.description) }
    // a shared project chat (chat/shared.ts): its allowlist (rooms/ai-tools.ts), and the connection tools built for it
    // (each call behind the asker's card where some people here could not see the answer:
    // docs/decisions/20261118-shared-chat-connections.md)
    // (and a project's shared chat reads its own chat room: projectRoomTools, scoped to that one room)
    if (exec.shared && !SHARED_TOOLS.has(t.name) && !o.connection && !o.projectRoom) return false
    // edit_office in a shared chat changes only the chat's own files (a new version); a project chat's chat files are
    // read-only and its team files are not changed from a shared chat, so there it could do nothing
    if (t.name === 'edit_office' && exec.shared?.kind === 'project') return false
    if (t.name in FILE_TOOLS || tools.has(t.name)) { exec.rt.log.warn('turn tool name taken, skipped', { tool: t.name }); return false }
    tools.set(t.name, t)
    if (t.label) labels.set(t.name, t.label.bind(t))
    return true
  }
  for (const t of bTools(exec)) add(t)
  for (const t of skillTools(exec, () => tools.has(BOX_SHELL_TOOL))) add(t)
  // the team trash behind the server's card (chat/delete-files.ts): not offered in confidential or draft chats (add()
  // above) nor in an approved template run (its scope is fixed); in a shared chat (SHARED_TOOLS) only the AI's own files
  // of this chat go (no card), anything else is refused up front, as everywhere but the person's own chat with the
  // person there (docs/decisions/20261121-ai-scratch-files.md rule 4, QA TC-7332)
  if (!exec.templateRun) add(deleteFilesTool(exec))
  // a team project's members behind the server's card (chat/project-members.ts): not offered in
  // shared, confidential or draft chats (add() above) nor in an approved template run, refused up front
  // everywhere else but the person's own chat with the person there
  if (!exec.templateRun) add(projectMembersTool(exec))
  // a team folder's access for one person or group behind the server's card every time (chat/folder-access-tool.ts):
  // only in the person's own chat (never shared, confidential, Slack, scheduled, template or restricted, a guest's)
  if (!folderAccessOff(exec)) add(folderAccessTool(exec))
  // the person's own team chat rooms (chat/room-tools.ts): not in a shared, confidential or draft chat (add() above
  // keeps those to their own tools) nor in an approved scheduled template's run (its scope is fixed; it would refuse
  // them anyway)
  if (!exec.templateRun && !exec.shared) for (const t of roomReadTools(exec)) add(t)
  // a project's shared chat reads that project's own chat room, and no other (chat/room-tools.ts projectRoomTools:
  // room_read and room_file for its one room id, only what everyone who sees the chat sees there; no rooms list, no
  // save; docs/decisions/20261120-project-is-room.md D4)
  else if (!exec.templateRun && exec.shared?.kind === 'project') {
    const roomId = projectRoomOfChat(exec)
    if (roomId) for (const t of projectRoomTools(exec, roomId)) add(t, { projectRoom: true })
  }
  // a file sent from the computer in a chat shared with people (chat/chat-file-tool.ts): read as this person while they
  // see the chat; only where the chat holds such files or is shared with people. save_chat_file copies one into the team
  // folder behind the wider-audience card (docs/decisions/20261118-chat-files-full-read-and-save.md)
  if (chatFileOffered(exec)) {
    add(chatFileTool(exec)); add(saveChatFileTool(exec))
    // the same files as the chat place chat:files/ of read, list, glob and grep (shared/src/places.ts): the main AI
    // only (a sub-agent's view of the turn has no chatPlace)
    exec.files.chatPlace = chatPlaceHooks(exec)
  }
  // the comments under answers in this chat, read as this person while they see the chat (chat/answer-comments.ts):
  // a shared chat or one that still holds replies; never a scheduled run, Slack, a confidential, template or restricted
  // run, nor a sub-agent (PARENT_ONLY_TOOLS)
  if (!answerCommentsOff(exec)) add(answerCommentsTool(exec))
  // the AI posts to one of the person's rooms, a thread there or a teammate, after their yes on one server card
  // (chat/post-to-room.ts): in their own chat and in a shared one (as the turn's own person, SHARED_TOOLS), never in a
  // confidential, draft or template chat, a scheduled run or a question from Slack (postToRoomOff)
  if (!postToRoomOff(exec)) add(postToRoomTool(exec))
  // the person's own files for teammates, view only, after their yes on one server card every time
  // (chat/share-with-person.ts): the same places as post_to_room (SHARED_TOOLS in a shared chat), never a scheduled run
  if (!shareWithPersonOff(exec)) add(shareWithPersonTool(exec))
  // ...and taking that access away again (chat/stop-sharing.ts): the same places, never a scheduled run
  if (!stopSharingOff(exec)) add(stopSharingTool(exec))
  // a folder in the person's own files (chat/share-folder.ts): an add always
  // behind its card; never a scheduled run, Slack, a confidential, template or restricted run, a guest
  if (!shareFolderOff(exec)) add(shareFolderTool(exec))
  // who can open a file, a folder or this chat, and how (chat/who-can-open.ts): read-only; in a shared chat only for
  // the chat itself and a file the asker named or attached; never a scheduled run, Slack, a template or restricted run
  if (!whoCanOpenOff(exec)) add(whoCanOpenTool(exec))
  // the files shared with the person one by one, as a list the AI asks for (chat/shared-with-me-tool.ts), and what the
  // person has open now (chat/looking-at.ts): only in the person's own chat (add() keeps them out of shared,
  // confidential, guest and draft chats too)
  if (!sharedWithMeOff(exec)) add(sharedWithMeTool(exec))
  if (!lookingAtOff(exec)) add(lookingAtTool(exec))
  // edit_files is listed here so the engines and the model proxy allow it, but the MCP handler runs it
  // (mcp/protocol.ts editFiles): each file as its own edit call with the checks above. Never offered in confidential
  // chats (add() keeps to the local tools there). Reaching this call() means the handler did not: nothing is changed.
  add({ name: EDIT_FILES_TOOL, description: EDIT_FILES_DESCRIPTION, inputSchema: schema(EditFilesInput),
    async call() { return { ...text('Error: internal error', true), summary: `${EDIT_FILES_TOOL} -> not run (outside the file gate)` } } })
  for (const t of exec.rt.ctx.services.turnTools ?? []) {
    try { if (t.available && !t.available({ userId: exec.spec.userId, chatId: exec.spec.chatId, browser: exec.browser })) continue } catch { continue }
    add(wrapRegistered(exec, t))
  }
  // copy_files between the team folder, this chat's files (chat:files/) and its work folder (chat:work/): a call that
  // names a chat place runs the places copy (chat/places-copy.ts); any other the team copy, unchanged
  const teamCopy = tools.get(COPY_FILES_TOOL)
  if (teamCopy) tools.set(COPY_FILES_TOOL, withPlaces(exec, teamCopy, (files, call) => toolContext(exec, files, call).files.person))
  // a chat place as an input file of a registered tool (query_data): the main AI only (a sub-agent's view has none)
  // (a tool set built for a listing only, as tests and the tool-list check do, has no turn files)
  if (exec.files) exec.files.placeInput = (value, dest, max, signal) => stagePlaceInput(exec, exec.files, value, dest, max, signal)
  if (exec.devEnv) {
    const person = turnPerson(exec)
    add(boxShellTool({
      queueStep: boxShellQueueStep(exec),
      ctx: exec.rt.ctx, project: exec.devEnv.project, userId: exec.spec.userId, turnId: exec.spec.turnId, chatId: exec.spec.chatId, signal: exec.abort.signal,
      ...(exec.devEnv.shared ? { shared: exec.devEnv.shared } : {}),
      // a sub-agent's call comes with its own turn state (files/service.ts forAgent), the main AI's with the turn's
      caller: (files) => callerOf(files, exec.files),
      redact: (s) => exec.redact(s),
      unattended: person.unattended,
      // the bulk card (devenv/bulk.ts): keep many new files in the project folder? "Always allow" keeps them from then
      // on (kind bulk_files); a scheduled run asks nobody (false unless that choice was made)
      keepBulk: async (ask) => {
        // the project's name and who sees its folder, from its real rules (QA TC-7335: "the whole team" for a project
        // only its creator sees, and "My files › projects › <name>" for its name)
        const card = bulkCard(ask, exec.spec.locale, bulkCardFacts(exec, ask))
        // a short wait: the project's other commands wait while the card is open (no answer: the files move)
        return person.confirm(card.question, card.keep, card.move, { always: 'bulk_files', details: card.details, timeoutMs: BULK_CARD_MS })
      },
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
  // the chat's work folder (devenv/work-files.ts): read opens what box_shell's commands made there, and
  // save_work_file hands a finished file over. Only where box_shell itself was offered (not a confidential chat, where
  // it is dropped as a non-local tool though exec.devEnv is set) and the commands run in a work folder (a project chat's
  // run in the project folder, which read reaches already); looked up again at every call, never made by a read
  if (exec.devEnv && tools.has(BOX_SHELL_TOOL)) {
    const d = exec.devEnv
    const where = () => {
      if (!mayUseDevEnv(exec.rt.db, exec.rt.files, exec.spec.userId)) return null
      return workFolderAt(exec.rt.ctx, { userId: exec.spec.userId, chatId: exec.spec.chatId, project: d.project ? { id: d.project.id, folderPath: d.project.folderPath } : null, ...(d.shared ? { shared: d.shared } : {}) })
    }
    exec.files.workFolder = where
    // why there is none now, the same words for every spelling of its path (devenv/work-files.ts NO_WORK_WORDS)
    const at0 = { userId: exec.spec.userId, chatId: exec.spec.chatId, ...(d.shared ? { shared: d.shared } : {}) }
    const change = () => { try { return workFolderChange(exec.rt.ctx, at0) } catch { return null } }
    exec.files.workWhy = () => {
      if (!mayUseDevEnv(exec.rt.db, exec.rt.files, exec.spec.userId)) return 'off'
      let here = false
      try { here = runsInWorkFolder(exec.rt.ctx, { ...at0, project: d.project ? { id: d.project.id, folderPath: d.project.folderPath } : null }) } catch { here = false }
      if (!here) return 'elsewhere'
      return change() === 'fresh' ? 'changed' : 'none'
    }
    exec.files.workRenewed = () => change() === 'after'
    exec.files.workOldPath = (p) => { try { return inOldWorkFolder(exec.rt.ctx, at0, p) } catch { return false } }
    // the hand-over: only where the commands run in a work folder (not a project folder, which is a team folder
    // already); a personal chat saves into the team folder, a chat shared with people attaches it to the answer
    const at = { userId: exec.spec.userId, chatId: exec.spec.chatId, project: d.project ? { id: d.project.id, folderPath: d.project.folderPath } : null, ...(d.shared ? { shared: d.shared } : {}) }
    let work = false
    try { work = runsInWorkFolder(exec.rt.ctx, at) } catch { work = false }
    if (work && !d.shared) add(saveWorkFileTool(exec, where, 'folder'))
    else if (work && exec.shared?.kind === 'people') add(saveWorkFileTool(exec, where, 'chat'))
  }
  if (exec.browser) for (const t of PANE_TOOLS) add(browserTool(exec, t.name as BrowserToolName, t.description, t.inputSchema as unknown as Record<string, unknown>))
  // per-person tools (external-service connections), built from saved data at the start of the turn
  const prompt: string[] = []
  const context: string[] = []
  const seen: ReadSource[] = []
  // the connections' tools by name, with whether a call only reads (integrations/connections/tools.ts): after a room
  // read their reads skip the room card and their writes ask on their own card (chat/turn.ts confirmRoomChange). Only
  // the integrations provider's, and only those that say: any other tool keeps the room card (fails closed)
  const connections = new Map<string, { readOnly: NonNullable<TurnTool['readOnly']>; card: boolean }>()
  // every tool a provider added (they act at outside services): their arguments have stored keys hidden (hideKeys)
  const outside = new Set<string>()
  const providers = exec.rt.ctx.services.turnToolProviders ?? []
  // a shared chat: only the connections' provider, in its shared mode (the asker's card before a call some people here
  // could not see the answer of; no team connection while a guest is here; docs/decisions/20261118-shared-chat-connections.md).
  // Slack reading stays off there
  // a free-roam demo: no Slack reading (its API calls go out directly: docs/decisions/20261119-demo-free-roam-a.md)
  const kept = isFreeRoam(exec.rt.ctx.config) ? providers.filter((p) => p.name !== 'slack') : providers
  const offered = confidential || exec.restricted || guest ? [] : exec.shared ? kept.filter((p) => p.name === 'integrations') : kept
  const sharedConn = exec.shared ? exec.sharedConnections() : undefined
  for (const p of offered) {
    let built: ReturnType<typeof p.build>
    try { built = p.build({ userId: exec.spec.userId, chatId: exec.spec.chatId, turnId: exec.spec.turnId, browser: exec.browser, desktop: exec.desktop, scheduled: exec.spec.clientKind === 'schedule', ...(sharedConn ? { shared: sharedConn } : {}) }) }
    catch (e) { exec.rt.log.warn('turn tool provider failed', { provider: p.name, err: e }); continue }
    for (const t of built.tools) {
      if (!add(wrapRegistered(exec, t), { connection: !!sharedConn })) continue
      outside.add(t.name)
      if (t.label) labels.set(t.name, t.label.bind(t))
      if (t.card) cards.set(t.name, t.card.bind(t))
      if (p.name === 'integrations' && t.readOnly !== undefined) connections.set(t.name, { readOnly: t.readOnly, card: t.readsNeedCard === true })
    }
    if (built.prompt) prompt.push(built.prompt)
    if (built.seen?.length) seen.push(...built.seen)
    const ctxText = built.context === undefined ? built.prompt : built.context
    if (ctxText) context.push(ctxText)
  }
  /** a connection tool's call that only reads (its readOnly, asked of the call's arguments); false for anything else */
  const readsOnly = (name: string, input: unknown): boolean => {
    const ro = connections.get(name)?.readOnly
    try { return typeof ro === 'function' ? ro(input) === true : ro === true } catch { return false }
  }
  /** this turn's searches that a shared project chat kept in the project folder (beforeFileTool, read by afterFileTool) */
  const projectOnly = new WeakSet<object>()
  const set: ChatToolSet = {
    prompt,
    seen,
    context,
    stepLabel(name, input, locale) { try { return labels.get(name)?.(input, locale) ?? null } catch { return null } },
    card(name, input, locale) { try { return cards.get(name)?.(input, locale) ?? null } catch { return null } },
    connection: (name) => connections.has(name),
    readsOnly: (name, input) => readsOnly(name, input),
    readsFree: (name, input) => connections.get(name)?.card === false && readsOnly(name, input),
    list: () => [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    has: (n) => tools.has(n),
    callStarted: () => exec.ownCallStarted(),
    // the person's stored connection keys in what a tool saves (a file, an artifact, a name): hidden before every
    // other check, card and write (integrations/connections/hide-args.ts; QA TC-3041). write keeps a form the file it
    // overwrites already holds
    hideKeys: (name, args) => {
      // a call to a connected service (an MCP tool, Gmail, Drive, Notion, api_request, Slack): every value, so the
      // card shows exactly what is sent and the service never gets the key (QA TC-3081)
      // Fails closed: a stored secret that cannot be read now stops the call (completeRedactorFor)
      if (outside.has(name)) {
        const r = completeRedactorFor(exec.rt.ctx, exec.spec.userId)
        if (!r) throw new KeyRefusal(UNCHECKED_REFUSAL, 'stored keys could not be read')
        return hideAllArgs(args, r)
      }
      if (!KEY_HIDING_TOOLS.includes(name)) return { args, hidden: false }
      return hideKeysInArgs(name, args, exec.redactor(), (p) => exec.rt.files.textNow(exec.livePrincipal(), p))
    },
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
      // a scheduled run in a shared chat others wrote in: writes only in its save folder or the maker's own folder
      const runWrite = steerableWriteRefusal(exec.rt.db, exec.spec.turnId, name, args, RUN_WRITES)
      if (runWrite) return { ...text(runWrite, true), summary: `${name} -> refused: scheduled run in a shared chat writes only in its own places` }
      if (writesHangul(name, args) && !hwpWritingOn(exec.rt.ctx)) {
        // Hangul writing comes with the HWP plugin (tools/hwp-writing.ts): make_file .hwpx while it is off, or edit_hwp
        // after it was turned off during this turn, is refused before anyone is asked anything (the tool refuses it too)
        return { ...text(hwpWritingOffText(exec.spec.locale), true), summary: `${name} -> refused: Hangul writing is off (HWP plugin)` }
      }
      // a chat place (chat:files/…, chat:work/…) in a tool that does not take one yet: refused before any card, never taken
      // as a team path or a web address (docs/decisions/20261121-chat-places-as-paths.md)
      const placeNo = placeRefusal(name, args)
      if (placeNo) return { ...text(placeNo, true), summary: `${name} -> refused: chat place` }
      // edit_office on a chat file without output saves a new version of it (P4): who may, checked before any card
      const versionAt = name === 'edit_office' ? officeVersionPlace(args) : null
      // a shared chat offers edit_office for its own chat files only (a team Office file is not changed from here yet:
      // docs/decisions/20261121-ai-edits-chat-files.md)
      if (name === 'edit_office' && exec.shared && !versionAt) return { ...text(`Not done (${name}): in a shared chat edit_office changes only this chat's own files (file_path chat:files/<file_id>/<name>, without output), as a new version. A team Office file is not changed from here: make a changed copy with make_file, or ask again in a chat only you see.`, true), summary: `${name} -> refused: team file in a shared chat` }
      if (versionAt) {
        const no = chatVersionRefusal(exec, files, versionAt)
        if (no) return { ...text(`Not done (${name}): ${no}`, true), summary: `${name} -> refused: chat file not changed here` }
      }
      const t = tools.get(name)!
      // a call the tool refuses anyway asks nobody first and counts as nothing read (save_room_file without a file id,
      // into skills/, …)
      const early = t.refuse?.(args, files)
      if (early) return { ...text(early.text, true), summary: early.summary }
      // a shared project chat: a search without a path looks in the project folder; then what the call would read that
      // some of the chat's people cannot read waits for the person's yes (chat/turn.ts confirmSharedRead)
      // (a connection's tool names no team path: its own card comes from the tool, integrations/connections/tools.ts
      // sharedGate, before anything is fetched)
      if (exec.shared && !outside.has(name)) {
        // a chat shared with people and groups: a search without a path only where everyone in it may read, else refused
        const noPlace = exec.sharedSearchRefusal(name, args)
        if (noPlace) return { ...text(noPlace, true), summary: `${name} -> not searched: no folder everyone in the shared chat reads` }
        args = exec.sharedArgs(name, args)
        // the neutral step line only for the main AI's own call (a sub-agent's step is matched by its id, not here)
        const sharedNo = await exec.confirmSharedRead(name, args, { step: files === exec.files })
        if (sharedNo) return { ...text(sharedNo, true), summary: `${name} -> not read: ${sharedShort(sharedNo)} (shared chat)` }
      }
      exec.noteTaint(name, args)
      exec.noteRoomTool(name, args)
      // after a room read: anything that may change something waits for the person's yes (rooms/ai-tools.ts); a call
      // that also needs the wider-audience card below gets that one card (widenOf, or the tool's own widen: where it
      // saves, what it copies, where its bytes come from)
      const roomNo = await exec.confirmRoomChange(name, args, { widen: t.widen ? t.widen(args) : widenOf(name, args, (x) => exec.hwpTarget(x)), main: files === exec.files, send: t.sendsTo?.(args) ?? null })
      if (roomNo) return { ...text(roomNo, true), summary: `${name} -> ${roomShort(roomNo)} (after a room read)` }
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
        const refusal = typeof a.output === 'string' ? await exec.confirmWidening(a.output, typeof a.source === 'string' ? [a.source] : [], undefined, { tool: name, args, main: files === exec.files }) : null
        if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true, summary: `make_file -> ${roomShort(refusal)} (wider audience)` }
      }
      if (name === 'edit_hwp' && args && typeof args === 'object') {
        // like write and edit: what the chat read may go where more people see it (asked before the worker runs); a new
        // file also carries the document it is made from
        const a = args as { output?: unknown; file_path?: unknown }
        // where the tool writes, as it decides it (the document's extension as the file layer resolves it: turn.ts hwpTarget)
        const target = exec.hwpTarget(a)
        const refusal = typeof target === 'string' ? await exec.confirmWidening(target, typeof a.output === 'string' && typeof a.file_path === 'string' ? [a.file_path] : [], undefined, { tool: name, args, main: files === exec.files }) : null
        if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true, summary: `edit_hwp -> ${roomShort(refusal)} (wider audience)` }
      }
      // a call a room grant or [이번만] let through: checked again now that any card above has waited (chat/turn.ts)
      const again = await exec.recheckRoomCover(name, args, { main: files === exec.files })
      if (again) return { ...text(again, true), summary: `${name} -> ${roomShort(again)} (room)` }
      const out = await t.call(args, files)
      // a read-only refusal of a registered tool (make_file, edit_hwp, save_url…): who can give write access (B2)
      const roText = out.isError ? out.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') : ''
      const ro = readOnlyFor(exec, roText)
      if (ro) out.content = [...out.content, { type: 'text', text: ro }]
      // what the call read (search passages, make_file's sources) counts now, as the file tools' reads do (afterFileTool):
      // a file of the person's own folder may carry outside content (turn.ts noteOwnReads) before the next card or memory
      exec.noteReads()
      exec.afterTool()
      // a new file left loose at the top of shared/, a group's folder or the team root: the server's note (chat/file-placement.ts)
      const placed = exec.placementNote(tools.has('move_files'))
      // a skill saved in a shared chat (make_file, edit_hwp into a skill folder): one quiet line in the answer
      const skillNote = name === 'make_file' || name === 'edit_hwp' ? exec.sharedSkillNote(name, args, !!out.isError) : null
      // who can open what it saved, from the real folder (chat/save-audience.ts); the main AI's own call, not a guest's,
      // and only where who_can_open is offered (no confidential chat, scheduled run, Slack question or template run)
      const audience = exec.audienceNote(files === exec.files && !guest && !whoCanOpenOff(exec))
      const note = [placed, skillNote, audience].filter(Boolean).join('\n')
      // the audit line (tool_events) never repeats a stored connection secret (integrations/connections/redact.ts), and
      // in a chat that read team chat rooms keeps of an address only its site (tools/audit-url.ts): admins read it
      const summary = exec.redact(out.summary ?? `${name} -> ${out.isError ? 'error' : 'ok'}`)
      return { content: note ? [...out.content, { type: 'text', text: note }] : out.content, isError: out.isError, summary: exec.roomsSeen ? hideUrls(summary) : summary, ...(out.beforeDelivery ? { beforeDelivery: out.beforeDelivery } : {}) }
    },
    afterFileTool: (name, isError, args, text, caller) => {
      // a skill save's approval is for that call only, saved or not (skills/guard.ts); so is a scheduled run's claim on
      // a path (chat/schedule-cover.ts)
      exec.dropSkillApproval(name, args)
      exec.releaseScheduleCover(name, args)
      exec.noteTaint(name, args); exec.noteRoomTool(name, args); exec.noteReads(); exec.afterTool()
      const filePath = (args as { file_path?: unknown } | null)?.file_path
      if (!isError && name === 'read' && typeof filePath === 'string')
        recordSkillRead(exec.rt.db, exec.rt.files, exec.livePrincipal(), exec.id, filePath)
      // a read-only refusal: who can give write access, and the person's own folder (B2, policy/refusal.ts); the
      // tool's own text stays as it is (the same for every caller)
      if (isError && text) { const ro = readOnlyFor(exec, text); if (ro) return ro }
      // "not found or no access" on a team project the person is not in: they are not a member (the same for a missing
      // project; policy/refusal.ts projectNotFoundNote). A guest's AI says who invited them instead (guestSection).
      if (isError && text && !guest) { const pn = notMemberFor(exec, text); if (pn) return pn }
      // a skill saved in a shared chat: one quiet line in the answer that the people here can see it
      const skillNote = exec.sharedSkillNote(name, args, isError)
      // a new skill's SKILL.md saved with held files on its card: write them again unchanged (chat/skill-held.ts)
      const heldNote = exec.heldSaveNote(name, args, isError)
      const placed = exec.placementNote(tools.has('move_files'))
      // a search of the team files by the main AI (a sub-agent has no rooms tool): the person's rooms that mention the
      // same words, counted (chat/room-hint.ts); only where the rooms tool is offered (never a shared, confidential,
      // draft, template or guest chat) and a room read stays in this chat (no scheduled run, Slack or side chat)
      const main = !caller || caller.files === exec.files
      const rooms = name === 'grep' && !isError && main && !guest && hintsHere(exec, tools.has('rooms')) ? roomHint(exec, (args as { pattern?: unknown } | null)?.pattern) : null
      // the version an edit keeps, a Hangul document that cannot be changed here (chat/file-notes.ts), once a turn
      // the main AI's own call only: a sub-agent reports to it (its Word copy would be a second one), and a guest has no
      // Files screen with a version history
      const fact = !main || guest ? null : fileNoteOnce(exec, fileNote({ name, isError, args, text, hangulOff: () => !hwpWritingOn(exec.rt.ctx), makeFile: tools.has('make_file') }), exec.spec.locale)
      // a shared project chat's search that stayed in the project folder: that it did, and how to look further, once
      // (the main AI's own call: a sub-agent's search must not use up the one note: review finding 5)
      const scope = main && !isError && args && typeof args === 'object' && projectOnly.has(args) ? exec.projectSearchNote() : null
      // who can open what it saved, from the real folder (chat/save-audience.ts), with who_can_open's gates
      const audience = exec.audienceNote(main && !guest && !whoCanOpenOff(exec))
      // a search that found nothing while a file of that name is in the person's trash (chat/trash-hint.ts, QA TC-7242)
      const trashed = name === 'glob' && !isError && main && !guest && !exec.shared && !exec.restricted && !exec.templateRun && !exec.otherAuthors && hintsHere(exec, true) && text?.startsWith('No files found') ? trashHint(exec.rt.ctx, exec.spec.userId, (args as { pattern?: unknown } | null)?.pattern, exec.spec.locale) : null
      return [placed, skillNote, heldNote, rooms, fact, scope, audience, trashed].filter(Boolean).join('\n') || undefined
    },
    // edit_files (mcp/protocol.ts): after a room read one card for the whole batch, before its first file
    beforeBatch: async (name, args) => {
      // a chat place among its files: no file tool edits one (files/service.ts placeWriteRefusal), so the batch is refused
      // before its card asks the person (one room card for the whole batch)
      // (an existing chat file goes on: each file runs as its own edit, which saves a new version of it: P4)
      const paths = (args as { file_paths?: unknown } | null)?.file_paths
      const place = Array.isArray(paths) ? paths.map((p) => placeArg('edit', { file_path: p })).find((pl) => pl && !chatVersionPlace(pl)) : null
      if (place) return { refusal: `Not done (${name}): ${placeWriteRefusal(place)} Leave it out of file_paths; nothing was changed.`, summary: `${name} -> refused: chat place` }
      const no = await exec.confirmRoomChange(name, args)
      return no ? { refusal: no, summary: `${name} -> ${roomShort(no)} (after a room read)` } : null
    },
    // edit_files names a chat file once however it is spelled (chat:files/<id>/…, an older version's id, its name):
    // an edit run twice would apply a replacement whose new text holds the old one again
    batchKey: (p) => {
      const place = placeArg('edit', { file_path: p })
      if (!chatVersionPlace(place)) return null
      try { return chatPlaces(exec, exec.files).head(place.id, place.name ?? '').path } catch { return null }
    },
    // a shared project chat: its sub-folders some of its people may not open are not there in any call (QA TC-4945)
    hiddenFolders: () => exec.sharedHiddenScope(),
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
      // a scheduled run in a shared chat others wrote in: writes only in its save folder or the maker's own folder
      const runWrite = steerableWriteRefusal(exec.rt.db, exec.spec.turnId, name, args, RUN_WRITES)
      if (runWrite) return { refusal: runWrite, summary: `${name} -> refused: scheduled run in a shared chat writes only in its own places` }
      // a shared project chat: grep and glob without a path look in the project folder (the call's own arguments are
      // changed: the file tool reads these); what the call would read that some of the chat's people cannot read waits
      // for the person's yes (chat/turn.ts confirmSharedRead)
      // a read of the chat's work folder (devenv/work-files.ts) names no team path: in a shared chat what a run there may
      // read joins the answer's record first, with who sees the chat now (as a command does), and the chat is its
      // source; no read card (everyone here sees that folder's people's view)
      // write or edit of a chat place (chat:files/…, chat:work/…): the file tool refuses it (files/service.ts callPlace),
      // so it is refused here, before any card asks the person about it (a room card, a skill card, the widening card)
      // An existing chat file is the exception (P4, chat/chat-file-write.ts): a new version of it, after the same checks
      // here before any card (who may change it in this turn, the file itself), and the cards below as for any save.
      const writePlace = name === 'write' || name === 'edit' ? placeArg(name, args) : null
      if (writePlace && !chatVersionPlace(writePlace)) return { refusal: `Not done (${name}): ${placeWriteRefusal(writePlace)}`, summary: `${name} -> refused: chat place` }
      if (writePlace) {
        const no = chatVersionRefusal(exec, caller?.files ?? exec.files, writePlace, name === 'write' ? 'write' : 'edit')
        if (no) return { refusal: `Not done (${name}): ${no}`, summary: `${name} -> refused: chat file not changed here` }
      }
      const work = exec.workRead(name, args)
      // (no work folder yet: the read itself refuses, and nothing is made here)
      if (work && exec.shared && exec.files.workFolder?.()) {
        if (!(caller ? caller.files === exec.files : true)) return { refusal: NO_WORK_WORDS.helper, summary: `${name} -> refused: work folder (sub-agent)` }
        const d = exec.devEnv
        // a shared project chat: its runs' space (the project folder) with its scratch folder (srt/runner.ts scratchOf)
        const space = d?.shared ? spaceOf(exec.rt.ctx, { userId: exec.spec.userId, chatId: exec.spec.chatId, project: d.project ? { id: d.project.id, folderPath: d.project.folderPath } : null, shared: d.shared }) : null
        if (!space || !noteSharedReads(exec.rt.ctx, space)) return { refusal: workUnavailableText(exec.files.workWhy?.()), summary: `${name} -> refused: work folder not recorded (shared chat)` }
        addSources(exec.rt.db, exec.spec.chatId, [{ type: 'chat', id: exec.spec.chatId }])
      }
      if (exec.shared && !work) {
        const noPlace = exec.sharedSearchRefusal(name, args)
        if (noPlace) return { refusal: noPlace, summary: `${name} -> not searched: no folder everyone in the shared chat reads` }
        if (SEARCH_TOOLS.has(name) && args && typeof args === 'object') {
          // a project chat's search in the project folder (no path, or a path in it): its result says it looked only
          // there (afterFileTool; AI scenario FIND-01.project also named the project folder itself)
          if (exec.shared.kind === 'project' && inProjectOnly((args as { path?: unknown }).path, exec.shared.project.folder_path)) projectOnly.add(args)
          // "/" in a project chat: every team folder the asker can open, never their own folder (SKIP_OWN)
          if (exec.shared.kind === 'project' && wholeTeamPath((args as { path?: unknown }).path)) SKIP_OWN.add(args)
          Object.assign(args, exec.sharedArgs(name, args))
        }
        const sharedNo = await exec.confirmSharedRead(name, args, { step: !caller || caller.files === exec.files })
        if (sharedNo) return { refusal: sharedNo, summary: `${name} -> not read: ${sharedShort(sharedNo)} (shared chat)` }
      }
      recordSent(exec.rt.db, exec.spec.chatId, args)
      // after a room read: a write or edit waits for the person's yes on a card first (rooms/ai-tools.ts); one that
      // also needs the wider-audience card below gets that one card
      const roomNo = await exec.confirmRoomChange(name, args, { widen: widenOf(name, args, (x) => exec.hwpTarget(x)), main: !caller || caller.files === exec.files })
      if (roomNo) return { refusal: roomNo, summary: `${name} -> ${roomShort(roomNo)} (after a room read)` }
      if (name !== 'write' && name !== 'edit') return null
      // skills/ first (team skills and rules: the person confirms what changes), then the wider-audience check
      const no = await exec.confirmSkillWrite(name, args, caller?.files)
      if (no) return no
      const p = (args as { file_path?: unknown } | null)?.file_path
      const widen = typeof p === 'string' ? await exec.confirmWidening(p, [], undefined, { tool: name, args, main: !caller || caller.files === exec.files }) : null
      // refused after the skill card: its approval goes with the call (afterFileTool drops it after a save)
      if (widen) { exec.dropSkillApproval(name, args); return widen }
      // a call a room grant or [이번만] let through: checked again now that any card above has waited (chat/turn.ts)
      const again = await exec.recheckRoomCover(name, args, { main: !caller || caller.files === exec.files })
      if (again) exec.dropSkillApproval(name, args)
      return again ? { refusal: again, summary: `${name} -> ${roomShort(again)} (room)` } : null
    },
  }
  // a skill save's approval (make_file, edit_hwp) is for its call only: dropped when the call ends, saved or not
  // (skills/guard.ts; a failed call left one for the rest of the turn)
  const run = set.call
  set.call = async (name, args, caller) => { try { return await run(name, args, caller) } finally { exec.dropSkillApproval(name, args); exec.releaseScheduleCover(name, args) } }
  // a safety card of these tools waits after the answer ends (chat/open-questions.ts; TurnExec.cardLater): the call
  // ends having done nothing, and the AI is told to end its answer; the next turn runs the call again with the answer
  const once = set.call
  set.call = async (name, args, caller) => {
    const track = CARD_LATER_TOOLS.has(name) && (caller?.files ?? exec.files) === exec.files
    if (!track) return once(name, args, caller)
    const was = exec.callNow
    const call = { name, args, deferred: null as string | null }
    exec.callNow = call
    try {
      const out = await once(name, args, caller)
      if (!call.deferred) return out
      exec.markCallWaiting(name)
      return { ...text(JSON.stringify({ waiting_for_user: true, note: CARD_LATER_NOTE })), summary: `${name} -> waits for the user's card (runs again with their answer)` }
    } finally { exec.callNow = was }
  }
  return set
}

/** Where a call's wider-audience check (below the room card) saves, and the files it copies bytes from: the same
 * arguments as the checks in call() and beforeFileTool (write and edit: the file; make_file: its output and source;
 * edit_hwp: the new file and the document, or the document itself). undefined for any other tool. */
export function widenOf(name: string, args: unknown, hwpTarget?: (args: unknown) => string | null): WidenOf | undefined {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : null
  if (!a) return undefined
  if (name === 'write' || name === 'edit') return typeof a.file_path === 'string' ? { target: a.file_path, extra: [] } : undefined
  // make_file: its source and template are both copied into the output (one card for both, QA TC-4948)
  if (name === 'make_file') return typeof a.output === 'string' ? { target: a.output, extra: [a.source, a.template].filter((x): x is string => typeof x === 'string') } : undefined
  if (name === 'edit_hwp') {
    const target = hwpTarget ? hwpTarget(a) : typeof a.output === 'string' ? hwpOutputPath(a.output, typeof a.file_path === 'string' ? a.file_path : '') : a.file_path
    return typeof target === 'string' ? { target, extra: typeof a.output === 'string' && typeof a.file_path === 'string' ? [a.file_path] : [] } : undefined
  }
  // stamp_pdf (tools/stamp-pdf.ts) with an output: the stamped copy carries the PDF's and the picture's bytes; asked
  // here so that after a room read its room card and its wider-audience card are one card (the tool's own check then
  // finds this yes). Without an output it saves a new name next to the PDF, which only the tool knows: its own card
  const stampOut = name === 'stamp_pdf' ? stampOutputOf(a.output) : null
  if (stampOut !== null && typeof a.file_path === 'string') {
    return { target: stampOut, extra: [...(stampOut === a.file_path.trim() ? [] : [a.file_path]), ...(typeof a.image === 'string' ? [a.image] : [])] }
  }
  // comment_docx (tools/comment-docx.ts): the document itself, or a new .docx made from it
  if (name === 'comment_docx' && typeof a.file_path === 'string') return typeof a.output === 'string' ? { target: commentDocxOutput(a.output), extra: [a.file_path] } : { target: a.file_path, extra: [] }
  // edit_office (tools/edit-office.ts): the file itself, or a new file made from it; a replacement picture's bytes too
  if (name === 'edit_office' && typeof a.file_path === 'string') {
    const pics = Array.isArray(a.changes) ? a.changes.flatMap((c) => { const img = (c as { replace_picture?: { image?: unknown } })?.replace_picture?.image; return typeof img === 'string' ? [img] : [] }) : []
    return typeof a.output === 'string' ? { target: editOfficeOutput(a.output, a.file_path), extra: [a.file_path, ...pics] } : { target: a.file_path, extra: pics }
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

/** B2's note after a policy refusal "Access denied: read-only…" (only that: never another tool's or a connection's
 * text that happens to say so). A project's creator is mentioned only when the person may read that project folder, and
 * named only where everyone who sees the answer may: in a shared chat the answer reaches all of them, so only when every
 * one of them may read that folder (roomReadable; none known: never), else "the project's creator". */
export function readOnlyFor(exec: Pick<TurnExec, 'rt' | 'livePrincipal' | 'spec' | 'shared' | 'roomReadable'> & { restricted?: boolean }, text: string): string | null {
  if (!text.startsWith('Access denied: read-only')) return null
  const rules = exec.rt.files.rules(), me = exec.livePrincipal()
  const group = !!exec.shared
  return readOnlyNote(exec.rt.db, text, exec.spec.locale, {
    userId: exec.spec.userId, sees: (segs) => atLeast(rules.access(me, segs), 'read'), button: answerHasButtons(exec),
    nameable: (segs) => !group || !!exec.roomReadable?.(segs.join('/')),
  })
}

/** After "not found or no access" on projects/ or a team project the person cannot read: they are not a member of a
 * project there (policy/refusal.ts projectNotFoundNote; scenario PRJ-01.outsider). */
export function notMemberFor(exec: Pick<TurnExec, 'rt' | 'livePrincipal'>, text: string): string | null {
  if (!text.startsWith('Access denied: not found or no access')) return null
  const rules = exec.rt.files.rules(), me = exec.livePrincipal(), fx = exec.rt.files.fx
  // the rules compare real folder names, and authorize finds a folder ignoring case on a case-insensitive disk (an
  // office Mac) but names the path as typed: decide on the real name, as authorize did
  const real = (segs: string[]) => { const w = walk(fx.root, segs, fx.caseInsensitive); return [...w.actual, ...w.missing] }
  return projectNotFoundNote(text, { sees: (segs) => atLeast(rules.access(me, real(segs)), 'read'), lists: () => rules.canList(me, real(['projects'])) })
}

/** Does the answer get the buttons under it ("save in my folder", "Suggest as skill")? Only in a person's own chat in
 * the app (web Chat.tsx canSuggest={!shared}): not a shared chat, a ✦ side chat (SideChatPanel canSuggest={false}), a
 * scheduled run, Slack or a restricted turn (a draft or a judge). */
export function answerHasButtons(exec: Pick<TurnExec, 'rt' | 'spec' | 'shared'> & { restricted?: boolean }): boolean {
  if (exec.shared || exec.restricted) return false
  const kind = exec.spec.clientKind
  if (kind && !LIVE_CLIENTS.has(kind)) return false
  try { return !sideRoomOf(exec.rt.db, exec.spec.chatId, exec.spec.userId) } catch { return true }
}

/** The audit line's words for a room card's refusal and a shared chat's read refusal: what happened (a scheduled run
 * asks nobody, a card can time out), not always "not allowed by the user" (policy/refusal.ts endOfText). */
const roomShort = (refusalText: string) => { const e = endOfText(refusalText); return e === 'failed' ? 'the check failed' : cardEndShort(e) }
const sharedShort = (refusalText: string) => { const e = endOfText(refusalText); return e === 'declined' ? 'not shared by the user' : e === 'failed' ? 'the check failed' : cardEndShort(e) }

/** The apps a person asks from and watches the answer in (session clients, shared ClientKind) */
const LIVE_CLIENTS: ReadonlySet<string> = new Set(['web', 'desktop', 'mobile'])

/** The person of this turn for tools that need a server-raised confirmation (web_fetch URLs, design tab 7). */
export function turnPerson(exec: TurnExec): TurnPerson {
  // the value picked (one of the card's own answers, never free text), or null with why there was none
  const pick = async (question: string, options: { label: string; value: string }[], extra?: ConfirmExtra): Promise<{ value: string | null; missing: CardAnswer['missing'] }> => {
    const wait = extra?.timeoutMs ? Math.min(extra.timeoutMs, exec.rt.askUserTimeoutMs()) : exec.rt.askUserTimeoutMs()
    const { value: answer, missing } = await exec.askPerson({
      kind: 'ask_user', origin: 'server', requestId: uuidv7(), question, options,
      multiple: false, allowText: false, expiresAt: new Date(Date.now() + wait).toISOString(),
      ...(extra?.details?.length ? { details: extra.details } : {}),
      ...(extra?.buttons && options.length === 3 ? { buttons: true as const } : {}),
      ...(extra?.note ? { note: extra.note } : {}),
    } as TurnRequest, { timeoutMs: wait })
    const v = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
    return { value: typeof v === 'string' && options.some((o) => o.value === v) ? v : null, missing }
  }
  const choose = async (question: string, options: { label: string; value: string }[], extra?: ConfirmExtra): Promise<string | null> => (await pick(question, options, extra)).value
  const confirmWhy = async (question: string, allow: string, deny: string, extra?: ConfirmExtra): Promise<CardOutcome> => {
    // "Always allow" for this kind of card (chat/always-allow.ts): on, no card; else the card offers it
    let missing: CardAnswer['missing'] | undefined
    const ask = async (options: { label: string; value: string }[], more: { buttons?: true; note?: string }) => {
      const r = await pick(question, options, { ...extra, ...more })
      missing = r.missing
      return r.value
    }
    const options = [{ label: allow, value: 'allow' }, { label: deny, value: 'deny' }]
    const v = extra?.always ? await withAlways(exec.alwaysPlace?.(), extra.always, options, 'allow', ask) : await ask(options, {})
    return v === 'allow' ? 'yes' : missing ?? 'declined'
  }
  return {
    locale: exec.spec.locale,
    choose,
    async confirm(question, allow, deny, extra) {
      return (await confirmWhy(question, allow, deny, extra)) === 'yes'
    },
    confirmWhy,
    *turnUrls() { for (const s of exec.steps) for (const src of s.sources ?? []) yield src.url },
    // waitForPerson answers "no answer" at once in a scheduled run; tools say why instead of "declined". A company
    // profile draft raises no card either: its screen shows none, so only the typed address and links of its pages open
    unattended: exec.spec.clientKind === 'schedule' || exec.restricted,
    // "Allow all websites" (tools/url-gate.ts ①d), the switch of this turn's own person: asked from their app with the
    // steps shown as they run (not a scheduled run, a Slack question, a draft or a turn the server started). Rooms,
    // shared chats and chats that read rooms too (the owner's call, 2026-11-11)
    allSitesHere: () => LIVE_CLIENTS.has(exec.spec.clientKind ?? '') && !exec.restricted,
    cardApprovals: () => exec.mayUseApprovals(),
    // a team file attached to a connection's send (integrations/connections/tools.ts): a file the person's own
    // message did not bring (named or attached it, or the AI wrote it new in this answer) keeps the card, in every
    // chat: a file name a teammate chose reaches the AI in a chat that read nothing too (chat/shared-actions.ts)
    // ...and any team file where other people's words are in the chat (othersWordsIn); the person's own Always allow for
    // the connection still goes without the card (docs/decisions/20261116-always-allow-final-rule-a.md)
    attachAsks: (paths) => othersWordsIn(exec) || !fromAsker(exec.rt.db, exec.spec, paths),
    othersWords: () => othersWordsIn(exec),
    webAccessChanged: () => exec.rt.hub.publish(exec.spec.userId, WEB_ACCESS_CHANGED),
    ...(exec.profileDraft ? { unattendedLabel: 'company profile draft answer', scope: (url: string) => draftUrlRefusal(exec.profileDraft!.scope, url), ...(exec.profileDraft.pages ? { pages: exec.profileDraft.pages } : {}) } : {}),
  }
}

/** The person for a call whose own card stands in for the room card after a room read (chat/turn.ts ownCard): the
 * tool asks every time (roomsSeen), each of its cards leads with the room card's line, and a card that shows no details
 * of its own shows what the room card would have (the folder and every file of a move, a video's file), so its one yes
 * is given seeing all of it. */
function roomLinePerson(exec: TurnExec, p: TurnPerson, call: { tool: string; args: unknown }): TurnPerson {
  const lead = `${tr(seenWhy(exec, 'roomsSeenWhy'), p.locale)}\n\n`
  const extra = (e?: ConfirmExtra): ConfirmExtra => (e?.details?.length ? e : { ...e, details: exec.roomCardDetails(call.tool, call.args) })
  return {
    ...p, roomsSeen: true,
    // every way a card is raised (askConfirm uses confirmWhy first): a method left unwrapped would show a card without
    // the line or the details
    confirm: (question, allow, deny, e) => p.confirm(lead + question, allow, deny, extra(e)),
    ...(p.confirmWhy ? { confirmWhy: (question: string, allow: string, deny: string, e?: ConfirmExtra) => p.confirmWhy!(lead + question, allow, deny, extra(e)) } : {}),
    ...(p.choose ? { choose: (question: string, options: { label: string; value: string }[], e?: ConfirmExtra) => p.choose!(lead + question, options, extra(e)) } : {}),
  }
}

/** `call`: the tool call this context is for: a room call a grant or [이번만] let through is checked again after the
 * tool's own wider-audience card (it may have waited: make_file's pictures and template) */
export function toolContext(exec: TurnExec, files: TurnFiles, call?: { tool: string; args: unknown }): TurnToolContext {
  return {
    turnId: exec.spec.turnId, chatId: exec.spec.chatId, userId: exec.spec.userId, messageId: exec.spec.assistantId, locale: exec.spec.locale,
    signal: exec.abort.signal,
    files: {
      signal: exec.abort.signal,
      // after a room read, a tool with its own card asks there alone, with the room card's line (chat/turn.ts ownCard)
      user: exec.livePrincipal(), turnId: exec.spec.turnId, files, person: call && exec.ownCard(call.tool) ? roomLinePerson(exec, turnPerson(exec), call) : turnPerson(exec),
      // files a tool copies bytes from (make_file's embedded images and template), checked before the new file is placed
      // a save a scheduled task's card covered: checked again right before the file is placed (after a conversion)
      ...(call ? { beforePlace: () => { const no = exec.scheduleCover?.recheck(callKey(call.tool, call.args)); if (no) throw new ToolError(no) } } : {}),
      // this chat's places (chat:files/, chat:work/): a produce tool's output attaches through it (files/place-output.ts)
      places: chatPlaces(exec, files),
      confirmWidening: async (target, sources, binding) => {
        const no = await exec.confirmWidening(target, sources, binding, call ? { tool: call.tool, args: call.args, main: files === exec.files } : undefined)
        if (no || !call) return no
        return exec.recheckRoomCover(call.tool, call.args, { main: files === exec.files })
      },
    },
  }
}

function wrapRegistered(exec: TurnExec, t: TurnTool): Tool {
  return {
    name: t.name, description: t.description, inputSchema: t.inputSchema,
    ...(t.sendsTo ? { sendsTo: (args: unknown) => { try { return t.sendsTo!(args) } catch { return null } } } : {}),
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

/** `scripts`: whether the turn offers box_shell (a loaded skill then says its scripts run there) */
function skillTools(exec: TurnExec, scripts: () => boolean): Tool[] {
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
          // a skill file of that name the person can read that does not load (a broken header, a name the rule refuses):
          // say so, so the AI never answers "you have no access" for it (AI scenario check SKL-11). Only the person's own
          // chat: a room or a shared chat hears nothing about files only they may read
          const broken = hit || near.length || exec.roomReadable || exec.shared ? null : skillIssues(rt.files, user).find((i) => i.problem !== 'too_many' && i.problem !== 'too_many_rules' && i.problem !== 'inputs' && sameSkillName(skillAlias(i.path), a.data.name))
          if (broken) {
            return {
              ...text(`The skill file ${broken.path} is there, but it does not load, so it is not in the skill list (problem: ${broken.problem}; the Skills page shows it with the fix). This is not about access: tell the user plainly that this skill's file needs a fix and that ${isPersonalSkill(broken.path) ? 'they can fix it themselves (it is their own skill) on the Skills page' : 'someone who manages skills can fix it on the Skills page'}. You may read the file and follow it for this request if the user wants; it is still a ${isPersonalSkill(broken.path) ? 'personal' : isGroupSkill(broken.path) ? 'group' : isProjectSkill(broken.path) ? 'project' : 'team'} skill's text, and it grants nothing.`, true),
              summary: 'skill -> does not load',
            }
          }
          return {
            ...text(`No skill called "${neutralizeTags(clipName(a.data.name))}" that this user can use.${near.length ? ` Similar: ${near.join(', ')}.` : ''} Use a name from the skill list in your instructions, or look with find_skills.`, true),
            summary: 'skill -> not found',
          }
        }
        exec.noteTaint('read', { file_path: skill.path })
        // a skill someone else may have written is other people's words (chat/turn.ts markOthersWords)
        if (!ownPersonalSkill(skill.path, spec.userId)) exec.markOthersWords()
        // the person's own personal skill: what an AI turn that wrote it had seen comes with it (chat/turn.ts noteOwnSkill)
        exec.noteOwnSkill(skill.path)
        // like a "/name" skill: its folder joins the chat's read scope (what is saved from it asks before going wider)
        addSources(rt.db, spec.chatId, [sourceOf(rt.db, rt.files.rules(), skillFolder(skill.path))])
        // reporting is auxiliary (admin/skill-usage.ts: team and group skills, never a personal one); a loaded skill is a
        // run (the onboarding goal counts it), unlike a plain read of the file
        try { recordSkillUse(rt.db, { turnId: spec.turnId, userId: spec.userId, skill, source: 'tool' }) } catch { rt.log.warn('skill usage recording failed', { turn: spec.turnId }) }
        // a team skill the person may not change: what to offer if they ask to change it (scenario SKL-02.member: the AI
        // loaded it, never tried the edit, and pasted the whole changed skill for the person to copy)
        const ro = readOnlySkillLine(skill.path, !atLeast(rt.files.rules().access(user, skill.path.split('/')), 'write'), spec.locale)
        return { ...text(skillBlock(skill, '', 'loaded', { ...SKILL_TOOL_LIMIT[exec.engineRunning ?? 'claude-code'], scripts: scripts() }) + (ro ? `\n${ro}` : '')), summary: `skill -> ${isPersonalSkill(skill.path) ? 'a personal skill' : skill.path}` }
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
        // an owner or admin also finds the skills of groups they are not in, apart from the ones they use: to move or edit
        // them, never to follow them (the skill tool refuses them)
        const managedLines = (u: Principal, query: string, fmt: (s: Skill) => string): string[] => {
          if (exec.shared || exec.roomReadable) return []
          const others = matchSkills(otherGroupSkills(rt.files, u), query, {}).map((h) => h.skill)
          return others.length ? ['Skills of groups this user is not in (they manage them as an owner or admin; these do not run for them, so do not follow them; move one with move_skill or change its files with the file tools):', ...others.map(fmt)] : []
        }
        const scores = usageScores(rt.db, spec.userId, skills.map((s) => s.path))
        const hits = matchSkills(skills, a.data.query, { scores })
        const q = neutralizeTags(clipName(a.data.query, 80))
        const line = (s: Skill) => `- ${neutralizeTags(clipName(s.name, 64))}${skillTitleText(s, neutralizeTags)}${skillTag(s, neutralizeTags)}${s.description.trim() ? ': ' + neutralizeTags(shortDescription(s.description, 300)) : ''} (${s.path})`
        const searched = `${skills.length} skill${skills.length === 1 ? '' : 's'} searched`
        if (!hits.length) {
          if (!skills.length) return { ...text([`No skill this user can use matches "${q}" (${searched}).`, ...managedLines(user, a.data.query, line)].join('\n')), summary: 'find_skills -> 0 found' }
          // no word in common (Korean words against English descriptions, other words for the same thing): the skills
          // the person uses most, so the AI can still judge from their descriptions, instead of nothing
          const top = frequentSkills(skills, scores)
          const head = top.used
            ? `No skill matches "${q}" by its words (${searched}). These are the skills this user uses most; their descriptions may be in another language than the request. Load one with skill if it fits; otherwise try other words or go on without a skill:`
            : `No skill matches "${q}" by its words (${searched}). These are skills this user can use; their descriptions may be in another language than the request. Load one with skill if it fits; otherwise try other words or go on without a skill:`
          return { ...text([head, ...top.skills.map(line), ...managedLines(user, a.data.query, line)].join('\n')), summary: `find_skills -> 0 found, ${top.skills.length} frequent` }
        }
        const lines = hits.map(({ skill: s }) => line(s))
        return { ...text([`${hits.length} skill${hits.length === 1 ? '' : 's'} matching "${q}", best first. Load the one that fits with skill (its name) before you follow it:`, ...lines, ...managedLines(user, a.data.query, line)].join('\n')), summary: `find_skills -> ${hits.length} found` }
      },
    },
    moveSkillTool(exec),
    skillFilesTool(exec),
  ]
}

// ---------------- move_skill ----------------
/** A group's or project's skill that holds code (files that are not Markdown), copied or moved into the team's or the
 * person's own skills: the card says who wrote that code and that it can run with the access of whoever uses it there
 * (QA TC-4932: a group or project skill's scripts never run where they are; a team or own skill's do). '' otherwise. */
export function copyCodeLine(plan: Pick<MovePlan, 'from' | 'to' | 'files'>, L: Locale): string {
  if (plan.to.level !== 'team' && plan.to.level !== 'personal') return ''
  const n = plan.files.filter((f) => !/\.md$/i.test(f.path)).length
  if (!n) return ''
  if (plan.from.level === 'group') return skillText('copyCodeGroup', L, { group: plan.from.group.name, n: String(n) })
  if (plan.from.level === 'project') return skillText('copyCodeProject', L, { project: plan.from.project.name, n: String(n) })
  return ''
}

// ---------------- move_skill ----------------
// One skill to another level (skills/move.ts, docs/DECISIONS.md "Project skills"), as the Skills page's 옮기기 moves it,
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
      if (spec.clientKind === 'schedule' && alwaysHere(exec.alwaysPlace?.(), 'skill_files') !== 'on') return bad(`Not ${verb}: a scheduled run has nobody to confirm the card. Tell the user to ${copy ? 'ask for the copy' : 'move the skill'} in a chat${copy ? '' : ' or with the Move item in the skill\'s menu on the Skills page (shown in their screen language)'}.`, 'refused: scheduled run')
      if (exec.shared || exec.restricted || exec.templateRun) return bad(`Not ${verb}: a skill is moved or copied only from the user's own chat, where they answer the card (not from a shared chat or a run limited to one task). Tell the user to ask in one of their own chats.${copy ? '' : ' ' + toPage}`, 'refused: not here')
      let user: Principal
      try { user = exec.livePrincipal() } catch { return bad('Access denied: this account is disabled.', 'denied: account disabled') }
      const L = spec.locale
      // the skill: by its name in this chat's list, else by its path (a project's skill from another project too)
      const skills = listSkills(rt.files, user, exec.skillScope(false))
      // the owner and admins also name a skill of a group they are not in (to move it back or elsewhere), after their own
      const hit = resolveSkill(skills, a.data.skill) ?? resolveSkill(otherGroupSkills(rt.files, user), a.data.skill)
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
        if (!a.data.group) return bad(`Name the group (group) to ${copy ? 'copy' : 'move'} the skill to. ${isStaff(user) ? 'Groups' : "The user's groups"}: ${list(groups)}.`, 'no group named')
        to = levels.find((l) => l.level === 'group' && fold(l.group.name) === fold(a.data.group!))
        if (!to) return bad(`Not ${verb}: "${neutralizeTags(clipName(a.data.group, 60))}" is not ${isStaff(user) ? 'a group of this team' : "one of the user's groups, and a skill goes only into a group the user is in (its members use it)"}. ${isStaff(user) ? 'Groups' : "The user's groups"}: ${list(groups)}. Ask the user which one they mean${isStaff(user) ? '.' : '; an admin can add them to another group in Admin › Groups.'}`, 'group not found')
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
      // after a room read this card is the call's only one (chat/turn.ts ownCard): it leads with the room card's line
      const question = [
        exec.ownCard('move_skill') ? tr(seenWhy(exec, 'roomsSeenWhy'), L) : '',
        `${head}\n${changeLine(plan, L)}\n${editorsLine(plan, L)}`,
        plan.shadows ? skillText('moveShadows', L, { name: plan.name, where: plan.shadows }) : '',
        why,
        copyCodeLine(plan, L),
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
        // where each file lands (a renamed copy: under its new name)
        { label: skillText(copy ? 'copyFiles' : 'moveFiles', L), text: plan.files.map((f) => `${plan.target}${f.path.slice(plan.source.length)} (${size(f.size)})`).join('\n'), noSize: true },
      ]
      const base = plan.source.split('/').pop()!
      const narrowHint = !copy && plan.from.level === 'team' && plan.to.level !== 'personal' ? skillText('moveNarrowHint', L, { name: base }).slice(0, 300) : null
      // "Always allow" for skill moves and copies (chat/always-allow.ts)
      const answer = await withAlways(exec.alwaysPlace?.(), 'skill_files',
        copy ? [{ label: skillText('copyYes', L), value: 'copy' }, { label: skillText('copyNo', L), value: 'skip' }] : [{ label: skillText('moveYes', L), value: 'move' }, { label: skillText('moveNo', L), value: 'skip' }],
        copy ? 'copy' : 'move', (options, more) => exec.waitForPerson({
          kind: 'ask_user', origin: 'server', requestId: uuidv7(), question, multiple: false, allowText: false,
          options, details, ...more,
          ...(narrowHint ? { note: more.note ? `${narrowHint}\n${more.note}`.slice(0, 300) : narrowHint } : {}),
          expiresAt: new Date(Date.now() + rt.askUserTimeoutMs()).toISOString(),
        } as TurnRequest, { timeoutMs: rt.askUserTimeoutMs() }))
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
        // the person's stored connection keys are hidden before the card asks and before it is saved, as in the answer
        // and the steps (redact.ts; QA TC-2981: the step said [hidden key], the saved memory had the key)
        const value = exec.redact(clean.text)
        let source: 'ai' | 'user' = 'ai'
        // the step's final words: patched onto it once (patchToolStep), or, when its card already changed it, onto the
        // same step again by its id
        let settle = (p: Partial<StoredStep>) => exec.patchToolStep('remember', () => p)
        // this conversation has seen outside content, or has read rooms (chat/read-rooms.ts: a room read, kept for the
        // rest of the chat; a side chat; another person's message quoted): the person confirms before anything is
        // kept (tab 3)
        if (exec.tainted || readRooms(exec)) {
          // while the card waits, the step says so (not "remembered" yet). The step may not have started when the
          // answer comes: then its one queued patch brings the final words.
          let stepId: string | null = null, final: Partial<StoredStep> | null = null
          exec.patchToolStep('remember', (st) => { stepId = st.id; return final ?? { label: tr('rememberAsking', L, { text: value }).slice(0, 500) } })
          settle = (p) => { final = p; if (stepId) exec.updateStep(stepId, p) }
          const notKept = (answered: boolean) => settle({ label: tr('notRemembered', L, { text: value }).slice(0, 500), ...(answered ? {} : { detail: tr('notAnswered', L) }) })
          let answer: unknown
          try {
            // "Always allow" for memories (chat/always-allow.ts): on, kept without the card
            answer = await withAlways(exec.alwaysPlace?.(), 'remember', [{ label: tr('yes', L), value: 'yes' }, { label: tr('no', L), value: 'no' }], 'yes', (options, more) => exec.waitForPerson({
              kind: 'ask_user', origin: 'server', requestId: uuidv7(), question: tr('rememberConfirm', L, { text: value }),
              options, multiple: false, allowText: false, ...more,
            } as TurnRequest, { timeoutMs: rt.askUserTimeoutMs() }))
          } catch (e) { notKept(false); throw e }
          if (answer !== 'yes' && !(Array.isArray(answer) && answer[0] === 'yes')) {
            // "답하지 않음" only when the card ran out; a "no" is an answer
            notKept(answer !== null && answer !== undefined)
            return { ...text('The user did not confirm, so nothing was remembered. Do not try again unless the user asks.'), summary: 'remember -> not confirmed' }
          }
          source = 'user'
        }
        const id = newId()
        rt.db.query('INSERT INTO memories (id, user_id, text, source_chat_id, source, created_turn_id, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, spec.userId, value, spec.chatId, source, spec.turnId, new Date().toISOString())
        const row = rt.db.query('SELECT id, text, source_chat_id, created_at FROM memories WHERE id = ?').get(id) as { id: string; text: string; source_chat_id: string | null; created_at: string }
        rt.hub.publish(spec.userId, { type: 'memory.changed', data: { change: 'created', memory: rt.store.toMemory(row) } })
        settle({ label: tr('remembered', L, { text: value }).slice(0, 500), detail: `memory:${id}` })
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
          // a label that is a team path is said in place words (chat/share-words.ts); the values stay as the AI gave them
          // (and an option that points at a thread: by who started it and its first words, QA TC-4054)
          ...(a.data.options ? { options: threadOptionWords(rt.db, optionWords(rt.db, a.data.options, L, spec.userId), threadLook(rt.ctx, spec.userId)) } : {}), ...(a.data.multiple !== undefined ? { multiple: a.data.multiple } : {}),
          ...(a.data.allowText !== undefined ? { allowText: a.data.allowText } : {}),
          expiresAt: new Date(Date.now() + rt.askUserTimeoutMs()).toISOString(),
        }
        // a chat a person watches: the card waits as long as it takes, after this answer ends (chat/open-questions.ts).
        // A shared chat too: its answer becomes the asker's message there, which everyone in the chat reads (owner
        // 2026-11-19: in a shared chat everything is shared); only the asker answers it
        if (!questionsWaitInCall(spec.clientKind)) {
          const { expiresAt: _no, ...open } = request
          if (!exec.askLater(open as typeof request & { kind: 'ask_user' })) return { ...text(JSON.stringify({ skipped: true })), summary: 'ask_user -> skipped' }
          return { ...text(JSON.stringify({ asked: true, note: ASK_USER_LATER_NOTE })), summary: 'ask_user -> asked' }
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
      // the answer's checklist (TurnExec.setTodos): no files, no network, only the AI's own words on its answer
      name: 'todo_write', description: B_TOOL_DESCRIPTIONS.todo_write, inputSchema: schema(TodoWriteInput),
      async call(args) {
        const a = TodoWriteInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        exec.setTodos(a.data.todos)
        const done = a.data.todos.filter((x) => x.status === 'completed').length
        return { ...text(`To-do list updated (${done} of ${a.data.todos.length} done). The user sees it under your answer. Keep it current as you work: one item in_progress at a time, each marked completed as soon as it is done.`), summary: `todo_write -> ${done}/${a.data.todos.length}` }
      },
    },
    {
      // the AI fills in the connection, the person finishes it on the card: the key goes from the card to the server and
      // never through this call (chat/connect-service.ts, docs/INTEGRATIONS.md "Connecting from a chat")
      name: 'connect_service', description: B_TOOL_DESCRIPTIONS.connect_service, inputSchema: schema(ConnectServiceInput),
      call: (args) => connectService(exec, args),
    },
  ]
  // the answering AI names a new chat (title.ts): no extra model call. The title shows in the Trina list and the header
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
      let allSites = false
      const gate = async (href: string): Promise<string | null> => {
        try {
          // an address "Allow all websites" opened is named in the audit line (plan §3)
          if (await gateUrl(rt.db, spec.chatId, href, person, { turnId: spec.turnId, userId: spec.userId }) === 'all') allSites = true
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
      return { content, isError: !r.ok, summary: `${name} -> ${r.ok ? 'ok' : 'error: ' + (r.error ?? '').slice(0, 200)}${allSites ? ' (all websites allowed)' : ''}` }
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

/** The arguments that take a chat place (shared/src/places.ts) in tools other than the file tools (files/service.ts
 * callPlace takes read, list, glob and grep): copy_files' sources and target (chat/places-copy.ts), query_data's inputs
 * (tools/query-data.ts), and the old save_work_file's path. Every other path argument refuses one. */
const PLACE_ARGS: Readonly<Record<string, readonly string[]>> = { copy_files: ['paths', 'to_folder'], query_data: ['paths'], save_work_file: ['path'] }

/** The produce tools whose output may be chat:files/<name> (attached to the answer: files/place-output.ts) */
export { PLACE_PRODUCE_TOOLS }

/**
 * A call of a registered tool (not read, list, glob or grep: files/service.ts callPlace takes those) that names a chat
 * place (shared/src/places.ts) where this build does not take one: the words for the AI, or null. copy_files and
 * query_data take them (P2); the produce tools and in-place edits follow (plan 20261121-0615-chat-places-as-paths.md
 * P3-P4).
 */
export function placeRefusal(name: string, args: unknown): string | null {
  for (const { key, value } of namedPaths(name, args)) {
    if (!isReservedPlace(value)) continue
    const place = parsePlace(value)
    if (place?.kind === 'reserved') return `Not done (${name}): ${place.why}.`
    if ((PLACE_ARGS[name] ?? []).includes(key) && !(name === 'save_work_file' && place?.kind !== 'work')) continue
    // P3 (docs/AGENTS/plan/20261121-0652-places-outputs.md): a produce tool's output (or split_pdf's and resize_images'
    // folder) and make_file's source and template; the tool's own place check decides (files/place-output.ts: who may
    // attach, chat:work/ outputs not yet, a chat file by id not changed in place yet)
    if (PLACE_PRODUCE_TOOLS.has(name) && (key === 'output' || key === 'output_folder')) continue
    if (name === 'make_file' && (key === 'source' || key === 'template')) continue
    // edit_office's document may be a chat file (P4): changed in place (a new version), or a new file made from it
    if (name === 'edit_office' && key === 'file_path' && place?.kind === 'chatFiles') continue
    if (name === 'move_files' || name === 'rename_file' || name === 'rename_files') return `Not done (${name}): chat files and work-folder files keep their names and places; copy one with copy_files (paths ["${value}"], to_folder a team folder, "chat:files/" or "chat:work/…") instead.`
    return place?.kind === 'work'
      ? `Not done (${name}): this tool does not take a work-folder path (${value}) yet. Read it with read, or copy it into a team folder with copy_files first (to_folder a team folder), then use that copy.`
      : `Not done (${name}): this tool does not take a chat file (${value}) yet. Copy it into a team folder with copy_files first (paths ["${value}"], to_folder a team folder), then use that copy.`
  }
  return null
}

/** edit_office's chat file changed in place (a new version, P4): its file_path when it names one and no output is given */
export function officeVersionPlace(args: unknown): Extract<Place, { kind: 'chatFiles' }> | null {
  const a = args && typeof args === 'object' ? args as { file_path?: unknown; output?: unknown } : {}
  if (a.output !== undefined) return null
  const p = parsePlace(a.file_path)
  return chatVersionPlace(p) ? p : null
}

/**
 * May this call save a new version of that chat file (P4)? The main AI only (a sub-agent: no chat place), and the
 * turn's chat places' own rule (chat/place-ctx.ts head: mayWriteChatVersion, the person continuing the chat, the file
 * there and not carried by a hidden answer). The words for the AI, or null. Checked here before any card, and again by
 * the save itself.
 */
export function chatVersionRefusal(exec: TurnExec, files: TurnFiles, place: Extract<Place, { kind: 'chatFiles' }>, tool?: 'write' | 'edit'): string | null {
  if (files !== exec.files) return PLACE_WORDS.noChat
  try {
    const h = chatPlaces(exec, files).head(place.id, place.name ?? '')
    // a save that would need a read first asks nobody anything (the tool says the same: chat/chat-file-write.ts)
    if (tool === 'write' && !mayReplace(files, h.path)) return `read '${h.path}' first (with read) before overwriting it`
    if (tool === 'edit' && !files.readHashes.has(h.path)) return `read '${h.path}' first (with read) before editing it`
    return null
  } catch (e) {
    if (e instanceof ToolError) return e.message
    return 'The chat file could not be checked, so nothing was changed. Try again.'
  }
}

/** The bulk card's facts (devenv/bulk.ts bulkCard): the project's name, and who can see its folder from the folder's real
 * rules (only the person, the whole team or a count; unsaid on a team past WALK_MAX or when it cannot be worked out). */
export function bulkCardFacts(exec: Pick<TurnExec, 'rt' | 'spec'>, ask: Pick<BulkAsk, 'project' | 'projectId'>): { name: string | null; who: BulkWho } {
  const db = exec.rt.db
  const row = (ask.projectId ? db.query('SELECT name FROM projects WHERE id = ?').get(ask.projectId) : db.query('SELECT name FROM projects WHERE folder_path = ? AND trashed_with IS NULL').get(ask.project)) as { name: string } | null
  let who: BulkWho = null
  try {
    const everyone = audiencePeople(db, WALK_MAX)
    if (everyone) {
      const a = pathAudience(db, exec.rt.files.rules(), ask.project.split('/').filter(Boolean), everyone)
      const n = a.ids.size
      who = n <= 1 ? { kind: 'only' } : a.wholeTeam ? { kind: 'team' } : { kind: 'some', n }
    }
  } catch { who = null }
  return { name: row?.name ?? null, who }
}
