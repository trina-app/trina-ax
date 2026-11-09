// skill_files: the AI's move, copy or rename of one file or folder that touches a skill folder, behind one server card
// (skills/folder-actions.ts; docs/DECISIONS.md "Skill folders: the AI's file actions"). Only the main AI of the
// person's own chat has it: never a team chat room, a shared project chat, a chat someone else wrote in, a scheduled or
// template run, a confidential chat, a draft or a sub-agent (subagents.ts PARENT_ONLY_TOOLS; a call from one is refused
// here too). Those are refused before any card, with the reason and where to do it instead: a card nobody can answer
// is never raised. A chat that read a team chat room puts nothing into a skill folder (other people's words could have
// asked for it). The card is the server's (origin 'server'), raised for every call: no earlier answer, room grant or
// "always" covers it. It shows the full paths, who gains or loses each skill (by name only to who may see that:
// seesWho), every word the AI would follow, and its yes is bound to the plan's token, which the file service checks
// again right before the change. The result tells the AI counts, and names only where the person may see them.
import { z } from 'zod'
import { SkillFilesInput, uuidv7 } from '@mycel/shared'
import type { ConfirmDetail, Locale, TurnRequest } from '@mycel/shared/api'
import type { McpContent } from '../turns'
import type { TurnFiles } from '../files/service'
import { audit } from '../admin/audit'
import { Denied, ToolError } from '../policy/errors'
import { FileError } from '../team-files/errors'
import { confidentialChat } from '../safe-ops/confidential'
import { inSkills } from '../skills/guard'
import { planFolderAction, runFolderAction, type FolderActionInput, type FolderPlan } from '../skills/folder-actions'
import { levelFolder, levelLabel, peopleNames, peopleText, seesWho, type Level } from '../skills/move'
import { st } from '../skills/text'
import { neutralizeTags } from './prompt'
import type { TurnExec } from './turn'

export const SKILL_FILES_TOOL = 'skill_files'

export const SKILL_FILES_DESCRIPTION = 'Move, copy or rename one file or folder that touches a skill folder (skills/, a group\'s or a project\'s skills: what people\'s AI follows), when the user asks: rename a group\'s or a project\'s folder that holds skills (e.g. projects/quotes to "quotes-2026"; only when nobody gains or loses anything) or a skill\'s own folder (its SKILL.md name line changes with it); take files, skills or rules out of a skill folder (move, a file copied out, or the skills folder renamed; the card says who stops getting them); or put a whole SKILL.md folder of text files into one (the card shows every word the AI would follow and who gets it). Never a picture, media or any other file that is not text into a skill folder: the user uploads those on the Files screen. One item per call. Nothing changes until the user says yes on the server\'s card; you do not need to ask first. A whole skill to another level goes with move_skill, a text file or rule in a skill folder with write / edit. Everything else is refused with the reason: tell the user that in their words, with the next step it gives.'

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })
const bad = (t: string, summary: string) => ({ ...text(t, true), summary: `${SKILL_FILES_TOOL} -> ${summary}` })
const clip = (s: string, n = 120) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const nothing = (why: string, next: string) => `Nothing was changed. Why: ${why}. Next step: ${next}.`

/** Why this chat or this caller gets no skill_files card at all (null: go on). `files`: the calling agent's state (a
 * sub-agent's, or a call whose agent is not known, is not the main AI's). */
export function skillFilesRefusal(exec: TurnExec, args: unknown, files?: TurnFiles): { text: string; summary: string } | null {
  const r = (why: string, next: string, summary: string) => ({ text: nothing(why, next), summary: `${SKILL_FILES_TOOL} -> refused: ${summary}` })
  const own = 'the user can ask for it in one of their own chats, or do it on the Files screen'
  if (files && files !== exec.files) return r('only the main AI may change skill folders, where the user answers its card; a helper (sub-agent) cannot ask the user', 'put it in your report; the main AI calls skill_files itself', 'sub-agent')
  if (exec.spec.clientKind === 'schedule') return r('this is a scheduled run with nobody watching, so no card can be answered and nobody was asked. The user did not refuse anything', own, 'scheduled run')
  if (exec.room) return r('this is a team chat room, where skill folders are not changed (other people\'s words could steer it)', own, 'room')
  if (exec.shared) return r('this is a shared project chat; skill folders are changed only in the user\'s own chat', own, 'shared chat')
  if (exec.templateRun) return r('this run is limited to its scheduled task', own, 'template run')
  if (exec.restricted) return r('this is a draft with no tools for team files', own, 'draft')
  if (confidentialChat(exec.rt.db, exec.spec.chatId)) return r('this is a confidential chat, which keeps to local tools', 'the user can ask in another chat, or do it on the Files screen', 'confidential chat')
  // a chat of a Slack thread: its answers may be posted to a channel, whose people may not see who gets a skill
  if (exec.spec.clientKind === 'slack' || exec.rt.db.query('SELECT 1 FROM slack_threads WHERE chat_id = ? LIMIT 1').get(exec.spec.chatId)) return r('this chat answers in Slack, where a channel may read the answer', 'the user can ask in the app, or do it on the Files screen', 'slack')
  // someone else wrote in this chat (it was shared): their words are in it
  if (exec.rt.db.query("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' AND author_id IS NOT NULL AND author_id <> ? LIMIT 1").get(exec.spec.chatId, exec.spec.userId)) return r('other people wrote in this chat; skill folders are changed only in a chat of the user\'s own', 'the user can ask in a new chat of their own, or do it on the Files screen', 'others wrote here')
  // a chat that read a team chat room: nothing goes into a skill folder from here (S7)
  if (exec.roomsSeen && intoSkills(args)) return r('this chat read a team chat room (other people\'s words), so nothing is put into a skill folder from it', 'the user can ask in a new chat, or do it on the Files screen', 'into skills after a room read')
  return null
}

/** Would this call put something into a skill folder (by the paths as given)? */
function intoSkills(args: unknown): boolean {
  const a = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  const p = typeof a.path === 'string' ? a.path : ''
  const name = p.split('/').filter(Boolean).pop() ?? ''
  if (typeof a.to_folder === 'string') return inSkills(`${a.to_folder.replace(/\/+$/, '')}/${name}`)
  return false
}

export function skillFilesTool(exec: TurnExec) {
  const { rt, spec } = exec
  const ctx = rt.ctx
  return {
    name: SKILL_FILES_TOOL, description: SKILL_FILES_DESCRIPTION, inputSchema: schema(SkillFilesInput),
    refuse: (args: unknown, files?: TurnFiles) => skillFilesRefusal(exec, args, files),
    async call(args: unknown, files: TurnFiles) {
      // the same refusals again (a caller that skipped refuse()), before anything is read
      const no = skillFilesRefusal(exec, args, files)
      if (no) return { ...text(no.text, true), summary: no.summary }
      const parsed = SkillFilesInput.safeParse(args)
      if (!parsed.success) return text('Invalid input: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), true)
      const a: FolderActionInput = parsed.data
      const verb = a.action === 'copy' ? 'copied' : a.action === 'rename' ? 'renamed' : 'moved'
      let user
      try { user = exec.livePrincipal() } catch { return bad('Access denied: this account is disabled.', 'denied: account disabled') }
      const plan = planFolderAction(ctx, user, a)
      // a next step the user hears in their own language: given to the AI as it is to be said
      if ('refused' in plan) return bad(`Not ${verb}. Why: ${neutralizeTags(plan.refused.why)}. Next step: ${neutralizeTags(plan.refused.next)}.${plan.refused.say ? ` Say it as: "${st(plan.refused.say, spec.locale)}"` : ''}`, `refused: ${clip(plan.refused.why, 80)}`)
      if (plan.kind === 'in' && exec.roomsSeen) return bad(nothing('this chat read a team chat room (other people\'s words), so nothing is put into a skill folder from it', 'the user can ask in a new chat, or do it on the Files screen'), 'refused: into skills after a room read')
      const L = spec.locale
      // names only now, after every check passed (S3), and only where the person may see who is there (seesWho)
      const names = (ids: readonly string[], l: Level | null) => (l && seesWho(ctx, user, l) ? peopleText(peopleNames(ctx, ids, L, 5), L) : null)
      const card = buildCard(plan, L)
      const fields = [
        plan.lostIds.length ? { name: st('moveWhoLoses', L), value: names(plan.lostIds, plan.level) } : null,
        plan.gainedIds.length ? { name: st('moveWhoGains', L), value: names(plan.gainedIds, plan.level) } : null,
        plan.editorsGainedIds.length ? { name: st('moveWhoEdits', L), value: names(plan.editorsGainedIds, plan.level) } : null,
      ].filter((f): f is { name: string; value: string } => !!f && f.value !== null)
      const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
      const details: ConfirmDetail[] = [
        ...(fields.length ? [{ label: st('moveWho', L), text: '', fields }] : []),
        { label: st('filePaths', L), text: `${plan.from}\n→ ${plan.to}` },
        ...(plan.texts.length ? [{ label: st('fileTexts', L), text: plan.texts.length === 1 ? plan.texts[0]!.text : plan.texts.map((t) => `=== ${t.path} ===\n${t.text}`).join('\n\n') }] : []),
        ...(plan.skills.length ? [{ label: st('fileSkills', L), text: skillLines(plan, L) }] : []),
        ...(plan.files.length ? [{ label: st('fileList', L, { n: String(plan.files.length) }), text: plan.files.map((f) => `${f.path} (${size(f.size)})`).join('\n') }] : []),
      ]
      const yes = a.action === 'copy' ? st('copyYes', L) : a.action === 'rename' ? st('fileYesRename', L) : st('moveYes', L)
      const answer = await exec.waitForPerson({
        kind: 'ask_user', origin: 'server', requestId: uuidv7(), question: card, multiple: false, allowText: false,
        options: [{ label: yes, value: 'yes' }, { label: st('fileNo', L), value: 'no' }], details,
        expiresAt: new Date(Date.now() + rt.askUserTimeoutMs()).toISOString(),
      } as TurnRequest, { timeoutMs: rt.askUserTimeoutMs() })
      const picked = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
      if (picked !== 'yes') {
        const declined = picked === 'no'
        audit(rt.db, { actor: spec.userId, action: 'skills.files_refused', target: plan.from, detail: { kind: plan.kind, action: plan.action, to: plan.to, turnId: spec.turnId, answer: declined ? 'declined' : 'none' } })
        return bad(declined
          ? `The user did not allow this (they said no on the card), so nothing was ${verb}. The card said: ${forAi(plan, user, ctx)} Do not do it another way unless the user asks again; never leave a README or an empty skills folder as a stand-in.`
          : `Nothing was ${verb}: the card closed without an answer (no answer in time, or the answer stopped). This is not a no. Next step: the user can ask again and answer the card.`, declined ? 'not allowed by the user' : 'no answer')
      }
      try {
        const done = await runFolderAction(ctx, user.id, a, plan, { turnId: spec.turnId, tool: SKILL_FILES_TOOL })
        const what = plan.kind === 'rename_skill' ? `Renamed the skill folder ${plan.from} to ${done.path} and set its SKILL.md name line to "${plan.rename!.name}".`
          : `${verb[0]!.toUpperCase()}${verb.slice(1)} ${plan.from} to ${done.path}.`
        return { ...text(`${what} ${forAi(plan, user, ctx)}`), summary: `${SKILL_FILES_TOOL} -> ${plan.kind} ${verb}` }
      } catch (e) {
        const msg = e instanceof Denied || e instanceof ToolError || e instanceof FileError ? e.message : 'it failed'
        if (/what the card showed changed/.test(msg)) return bad(`Not ${verb}: ${neutralizeTags(msg)}. Tell the user what changed; if they still want it, call skill_files again so they see a new card.`, 'refused: changed after the card')
        return bad(`Not ${verb}: ${neutralizeTags(msg)}. Tell the user what is in the way.`, 'failed')
      }
    },
  }

  /** The card's question: what happens, in the person's language, with the counts. */
  function buildCard(p: FolderPlan, L: Locale): string {
    const fromTo = { from: p.from, to: p.to }
    const stops = p.skills.filter((s) => s.effect === 'stops'), changes = p.skills.filter((s) => s.effect === 'changes')
    const lines: string[] = []
    if (p.kind === 'rename_folder') {
      lines.push(st('fileRenameFolder', L, fromTo), p.skills.length ? st('fileRenameKeeps', L, { n: String(p.skills.length) }) : st('fileRenameNone', L))
    } else if (p.kind === 'rename_skill') {
      lines.push(st('fileRenameSkill', L, { name: p.skills[0]!.name, as: p.rename!.name, ...fromTo }), st('fileRenameSkillSame', L, { n: String(p.skills[0]!.followers.length) }))
    } else if (p.kind === 'out') {
      const head = p.action === 'copy' ? 'fileOutCopy' : p.action === 'rename' ? 'fileOutRename' : p.holder ? 'fileOutFolder' : 'fileOutMove'
      lines.push(st(head, L, fromTo))
      if (stops.length) lines.push(st('fileStops', L, { names: skillNames(stops, L) }), st('fileStopsPeople', L, { n: String(p.lostIds.length), k: String(stops.length) }))
      if (changes.length && p.action !== 'copy') lines.push(st('fileChanges', L, { names: skillNames(changes, L) }))
      if (!p.skills.length) lines.push(st('fileNoSkill', L))
    } else {
      lines.push(st(p.action === 'copy' ? 'fileInCopy' : 'fileInMove', L, { where: p.level ? levelFolder(p.level, L) : p.to, ...fromTo }))
      const s = p.skills[0]!
      lines.push(st('fileInNew', L, { name: s.name, n: String(s.followers.length) }))
      lines.push(st(p.editorsGainedIds.length ? 'fileEditorsNew' : 'fileEditors', L, { n: String(p.editorIds.length), gained: String(p.editorsGainedIds.length) }))
    }
    if (p.shadow) lines.push(st('fileShadow', L, { n: String(p.shadow.people), where: p.shadow.projects.length ? ` (${p.shadow.projects.map((x) => st('whereProject', L, { project: x })).join(', ')})` : '' }))
    if (p.hiddenFor) lines.push(st('fileHidden', L, { n: String(p.hiddenFor) }))
    if (p.replaces) lines.push(st('fileReplaces', L, { n: String(p.replaces), name: p.skills[0]!.kind === 'rule' ? '' : (p.rename?.name ?? p.skills[0]!.name) }))
    if (p.seeAdded.length) lines.push(st('fileSeeMore', L, { n: String(p.seeAdded.length) }))
    if (p.seeLost.length) lines.push(st('fileSeeFewer', L, { n: String(p.seeLost.length) }))
    if (p.texts.length) lines.push(st('fileFollow', L))
    return lines.join('\n')
  }
  /** the skills by name, only those the person can read (S2); the rest counted */
  function skillNames(xs: FolderPlan['skills'], L: Locale): string {
    const shown = xs.filter((s) => s.readable).slice(0, 10).map((s) => s.name)
    const rest = xs.length - shown.length
    return [shown.join(', '), rest ? st('fileMoreSkills', L, { n: String(rest) }) : ''].filter(Boolean).join(' ')
  }
  function skillLines(p: FolderPlan, L: Locale): string {
    return p.skills.filter((s) => s.readable).map((s) => `${s.kind === 'rule' ? s.entry : s.name} (${s.entry})`).join('\n') + (p.skills.some((s) => !s.readable) ? `\n${st('fileMoreSkills', L, { n: String(p.skills.filter((s) => !s.readable).length) })}` : '')
  }
}

/** What the card said, for the AI (English): the skills and people by count, names only where the person may see who
 * is there (seesWho). */
function forAi(p: FolderPlan, user: import('../policy/access').Principal, ctx: TurnExec['rt']['ctx']): string {
  const who = (ids: readonly string[]) => {
    if (!p.level || !seesWho(ctx, user, p.level)) return `${ids.length} ${ids.length === 1 ? 'person' : 'people'} (names are shown only to the owner, admins and a project's creator, so do not guess who)`
    const n = peopleNames(ctx, ids, 'en', 20)
    return [...n.names.map((x) => neutralizeTags(x)), ...(n.more ? [`${n.more} more`] : [])].join(', ')
  }
  const named = (xs: FolderPlan['skills']) => xs.filter((s) => s.readable).map((s) => `"${neutralizeTags(s.name)}"`).join(', ') + (xs.some((s) => !s.readable) ? ` and ${xs.filter((s) => !s.readable).length} more` : '')
  const stops = p.skills.filter((s) => s.effect === 'stops')
  const parts: string[] = []
  if (p.level) parts.push(`Level: ${neutralizeTags(levelLabel(p.level, 'en'))}.`)
  if (p.kind === 'rename_folder') parts.push(`The ${p.skills.length} skill(s) in it keep working for the same people.`)
  if (p.kind === 'rename_skill') parts.push(`The same ${p.skills[0]!.followers.length} people use it.`)
  if (stops.length && p.action !== 'copy') parts.push(`The AI stops following ${named(stops)}; lose it: ${who(p.lostIds)}.`)
  if (p.kind === 'in' && p.skills[0]?.effect === 'new') parts.push(`New skill "${neutralizeTags(p.skills[0].name)}"; newly get it: ${who(p.gainedIds)}.`)
  if (p.editorsGainedIds.length) parts.push(`Newly may change it: ${who(p.editorsGainedIds)}.`)
  if (p.shadow) parts.push(`For ${p.shadow.people} of them a project skill of the same name is hidden${p.shadow.projects.length ? ` (${p.shadow.projects.map((x) => neutralizeTags(x)).join(', ')})` : ''}.`)
  if (p.hiddenFor) parts.push(`For ${p.hiddenFor} of them a wider skill of the same name runs instead.`)
  if (p.replaces) parts.push(`For ${p.replaces} of them it replaces the team's skill "${neutralizeTags(p.rename?.name ?? p.skills[0]!.name)}".`)
  if (p.seeAdded.length) parts.push(`${p.seeAdded.length} more people can see the files.`)
  if (p.seeLost.length) parts.push(`${p.seeLost.length} people can no longer see the files.`)
  return parts.join(' ')
}
