// who_can_open (docs/decisions/20261116-ai-share-who-can-open.md, plan docs/AGENTS/plan/20261116-1150-ai-share-who-can-open.md):
// the AI reads who can open a file, a folder or this chat and by which route, or whether one teammate can and why not.
// "Why can't Jun see this?" used to get a guess; now it gets the server's answer and, when the person cannot fix it
// themselves, one button under the step (files/share-fixes.ts): Ask <owner>, Ask an admin, Share with project.
//
// Read-only. It decides nothing: files/access-routes.ts explains what the folder rules and the file shares decide.
//
// What the person may learn is what the screens show them:
// - a file: its owner, or whoever may share it, gets who it is shared with (the Share dialog's rows) and how many
//   people the folder lets in (their names for the owner and admins only: the folder access screen is theirs).
//   Anyone else gets their own access and who to ask.
// - a folder: the owner and admins get the people; a member their own access and the count the Files screen shows.
// - this chat: whoever sees the chat gets who else sees it (the chat's own "who sees this" shows it).
// - one named person: answered only where the list is the asker's to see (and always for this chat).
// A file or folder the person cannot open reads exactly like one that does not exist.
//
// Where it runs: a person's own chat, and a shared chat only for the chat itself and for a file the asker named or
// attached in their own message (its answer is read by everyone in that chat). Never for a guest, in a scheduled run,
// from Slack, in a confidential chat, in a template's or a restricted run, or for a sub-agent (the gates of the actions
// that reach others: chat/shared-actions.ts actionOff, mainOnly; chat/tools.ts add()).
//
// Its answer holds names other people chose (a person's, a group's, a folder's, a file's), so every call marks the chat
// as holding other people's words (chats.others_words; it is deliberately NOT in rooms/ai-tools.ts OWN_WORDS_TOOLS,
// which fails closed): the person's "Always allow" for shares and posts then counts only for what their own message
// names. The offers it hangs under its step are run by the person's own press (POST /api/share-fixes/:id/run), never by
// a tool: no AI turn can run one.
import { WhoCanOpenInput } from '@mycel/shared'
import type { Step, StepFix } from '@mycel/shared/api'
import { z } from 'zod'
import { accessRouteFor, fileAccess, folderAccess, nameOf, NAMES_MAX, routeWords, sharedWithMeAccess, type AccessRoute } from '../files/access-routes'
import { shareFixesOf } from '../files/share-fixes'
import { fileSharesOf } from '../files/shares'
import { findPeople, PERSON_REF, type Teammate } from '../rooms/reader'
import { confidentialChat } from '../safe-ops/confidential'
import { isPeopleRow, peopleAudience, subjectsOf } from './chat-audience'
import { neutralizeTags } from './prompt'
import { isPersonalFolder } from './projects'
import { chatAudienceOf, isProjectSharedRow, projectCanShare } from './shared'
import { actionOff, askerText, attachedPaths, mainOnly, namesFile } from './shared-actions'
import type { Tool } from './tools'
import type { TurnExec } from './turn'
import { FIND_FOLDER_LINE } from './share-words'

export const WHO_CAN_OPEN_TOOL = 'who_can_open'
export const WHO_CAN_OPEN_DESCRIPTION = 'See who can open a file, a folder or this chat and how (it is theirs, shared with them by name, through a group, through a folder, as a project member), or whether one teammate can and why not. Read-only: it changes nothing. Use it for "why can\'t Jun see this?", "who can see this?" and before you tell the user who can or cannot open something (never "only you can open it" without it). Names are given only for things whose access list the user may see on screen (their own files, a chat they are in, team folders for admins); for anything else you get the user\'s own access and who to ask. When the result says a button is shown under this step, tell the user in one short sentence that they can press it. Never show a folder path: use the words the result uses.' + FIND_FOLDER_LINE

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })
const zodText = (e: z.ZodError) => 'Invalid input: ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
const oneLine = (s: string, n: number) => { const v = s.replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v }
/** a name or a place as the AI is given it: one line, our block tags neutralized, quoted by the caller */
const safe = (s: string, n = 120) => neutralizeTags(oneLine(s, n))
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
const BUTTON = 'A button for it is shown to the user under this step'
const NOT_FOUND = 'Not found, or the user cannot open it (the same answer for both, on purpose). Check the path with list or glob; if the user means a file someone shared with them, use its link.'

/** Why who_can_open is not offered in this turn (and refused when reached anyway), or null: it is. */
export function whoCanOpenOff(exec: Pick<TurnExec, 'restricted' | 'templateRun' | 'spec' | 'rt'>): { text: string; summary: string } | null {
  const off = actionOff(exec, null)
  if (!off) return null
  const why = off === 'schedule' ? 'a scheduled run' : off === 'confidential' ? 'a confidential conversation' : off === 'slack' ? 'a question from Slack' : 'a run limited to one task'
  return { text: `Not available here (${why}). Tell the user to ask in one of their own chats, or to look at Share on the file.`, summary: `${WHO_CAN_OPEN_TOOL} -> refused: ${off}` }
}

export function whoCanOpenTool(exec: TurnExec): Tool {
  const { rt, spec } = exec
  const ctx = rt.ctx, db = rt.db
  const no = (t: string, summary: string) => ({ ...text(t, true), summary: `${WHO_CAN_OPEN_TOOL} -> ${summary}` })
  const ok = (lines: string[], summary: string) => ({ ...text(lines.filter(Boolean).join('\n')), summary: `${WHO_CAN_OPEN_TOOL} -> ${summary}` })
  const words = (r: AccessRoute) => routeWords(ctx, r, spec.userId)

  /** The one teammate asked about: found, several (the AI asks which), or nobody by that name. In a shared chat the
   * candidates are never listed (the AI writes where everyone in the chat reads). */
  const personOf = (ref: string | undefined): { one: Teammate | { id: string; name: string } } | { refuse: ReturnType<typeof no> } | null => {
    if (ref === undefined) return null
    const me = nameOf(ctx, spec.userId)
    const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
    if (me && fold(ref) === fold(me)) return { one: { id: spec.userId, name: me } }
    const p = findPeople(db, spec.userId, ref)
    const refAi = safe(ref, 80)
    if (!p) return { refuse: no(`Nobody on the team matches "${refAi}" (someone who is not an active member reads the same). Ask the user who they mean.`, 'refused: nobody matches') }
    if ('one' in p) return { one: p.one }
    if (exec.shared) return { refuse: no(`Several people match "${refAi}". Ask the user for the full name.`, `refused: ${p.total} match`) }
    return { refuse: no(`Several people match "${refAi}". Ask the user which one they mean, then call who_can_open again with person "${PERSON_REF}<id>":\n${p.many.map((t) => `- ${safe(t.name, 80)} · "${PERSON_REF}${t.id}"`).join('\n')}`, `refused: ${p.total} match`) }
  }

  const chat = (who: { id: string; name: string } | null): { out: ReturnType<typeof ok>; fixes: StepFix[] } => {
    const row = rt.store.chatRow(spec.chatId)
    if (!row) return { out: no('This chat was not found.', 'refused: no chat'), fixes: [] }
    const list = (ids: readonly string[]) => {
      const names = ids.filter((id) => id !== spec.userId).slice(0, NAMES_MAX).map((id) => nameOf(ctx, id) ?? '').filter(Boolean).map((n) => safe(n, 80))
      const more = Math.max(0, ids.filter((id) => id !== spec.userId).length - names.length)
      return `${names.join(', ')}${more ? ` and ${more} more` : ''}`
    }
    const whoName = who ? safe(who.name, 80) : ''
    // ---- shared with chosen people and groups ----
    if (isPeopleRow(row)) {
      const ids = peopleAudience(db, row)
      const subjects = subjectsOf(db, row.id)
      const groups = subjects.filter((s) => s.type === 'group').map((s) => ({ id: s.id, name: (db.query('SELECT name FROM groups WHERE id = ?').get(s.id) as { name: string } | null)?.name ?? '' })).filter((g) => g.name)
      const lines = [`This chat is shared with chosen people and groups: ${people(ids.length)} can see it (the user and ${list(ids) || 'nobody else'}).`,
        groups.length ? `Groups it is shared with: ${groups.map((g) => `"${safe(g.name, 80)}"`).join(', ')} (their members see it, new members too).` : '']
      if (who) {
        if (ids.includes(who.id)) {
          const g = groups.find((x) => db.query('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(x.id, who.id))
          lines.push(`${whoName} can see this chat: ${who.id === row.user_id ? 'they made it' : subjects.some((s) => s.type === 'user' && s.id === who.id) ? 'it is shared with them by name' : g ? `through the "${safe(g.name, 80)}" group` : 'it is shared with them'}.`)
        } else lines.push(`${whoName} cannot see this chat: it is not shared with them or with a group they are in. ${row.user_id === spec.userId ? 'The user can add them with Share at the top of the chat.' : 'Only the person who made the chat can add them, with Share at the top of the chat.'}`)
      }
      return { out: ok(lines, `chat, ${ids.length} people`), fixes: [] }
    }
    const project = row.project_id ? rt.store.projectRow(row.project_id) : null
    const team = !!project && projectCanShare(project) && !project.trashed_with
    // ---- a shared project chat ----
    if (isProjectSharedRow(row) && project) {
      const ids = chatAudienceOf(db, rt.files, project, row.user_id)
      const lines = [`This chat is shared with the project "${safe(project.name, 80)}": its ${people(ids.length)} can see it (the user and ${list(ids) || 'nobody else'}). People added to the project later see it too.`]
      if (who) lines.push(ids.includes(who.id) ? `${whoName} can see this chat: they are in the project.` : `${whoName} cannot see this chat: they are not in the project "${safe(project.name, 80)}". Adding them to the project (change_project_members, when the user asks) lets them see it.`)
      return { out: ok(lines, `project chat, ${ids.length} people`), fixes: [] }
    }
    // ---- private ----
    const lines = ['Only the user can see this chat.']
    const fixes: StepFix[] = []
    if (team && project && row.user_id === spec.userId && !row.side_room_id && !confidentialChat(db, row.id)) {
      const ids = chatAudienceOf(db, rt.files, project, row.user_id)
      const inProject = who ? ids.includes(who.id) : false
      lines.push(`It is in the project "${safe(project.name, 80)}" but was not shared with it: a chat moved into a project stays private until its owner shares it.`)
      if (who) lines.push(`${whoName} cannot see this chat${inProject ? `, although they are in the project "${safe(project.name, 80)}"` : `, and is not in the project "${safe(project.name, 80)}" either (sharing the chat with the project would not reach them; they would have to be added to the project)`}.`)
      fixes.push(shareFixesOf(ctx).forChat(spec.userId, row.id, { id: project.id, name: project.name }))
      lines.push(`${BUTTON}: "Share with project". It shows the whole chat to the project's ${people(ids.length)} and cannot be undone; the user decides there. Tell them in one short sentence.`)
    } else {
      if (who) lines.push(`${whoName} cannot see this chat.`)
      lines.push(project && isPersonalFolder(project.folder_path) ? 'It is in a project of the user\'s own. To let others see it, the user can share the chat with people or groups: Share at the top of the chat.' : 'To let others see it, the user can share it with people or groups: Share at the top of the chat.')
    }
    return { out: ok(lines, 'private chat'), fixes }
  }

  return {
    name: WHO_CAN_OPEN_TOOL, description: WHO_CAN_OPEN_DESCRIPTION, inputSchema: schema(WhoCanOpenInput),
    async call(args, files) {
      let fixes: StepFix[] = []
      try {
        const a = WhoCanOpenInput.safeParse(args)
        if (!a.success) return text(zodText(a.error), true)
        const off = whoCanOpenOff(exec)
        if (off) return { ...text(off.text, true), summary: off.summary }
        const main = mainOnly(exec, files)
        if (main === 'sub-agent') return no('Only the main assistant can look this up. Say in your result what the user asked about.', 'refused: sub-agent')
        if (main === 'disabled') return no('Access denied: this account is disabled.', 'denied: account disabled')
        const p = personOf(a.data.person)
        if (p && 'refuse' in p) return p.refuse
        const who = p ? p.one : null
        const whoName = who ? safe(who.name, 80) : ''

        if (a.data.path === undefined) { const r = chat(who); fixes = r.fixes; return r.out }

        // a shared chat: only a file the asker brought into this turn themselves (everyone in the chat reads the answer,
        // and another member's message must not point the AI at the asker's files)
        // (a file link, /f/<id>, is its file: by its path when the folder lets the user read it, else as shared with them)
        const viaLink = sharedWithMeAccess(ctx, spec.userId, a.data.path)
        const input = viaLink?.path ?? a.data.path
        const f = fileAccess(ctx, spec.userId, input)
        const shared = f ? null : viaLink
        const d = f || shared ? null : folderAccess(ctx, spec.userId, input)
        if (exec.shared) {
          const asked = askerText(db, spec.userMessageId)
          const attached = attachedPaths(db, spec.userMessageId)
          const rel = f?.path ?? d?.path ?? ''
          if (!f || !(attached.has(rel) || namesFile(asked, rel))) return no('In a chat other people can see, this works only for the chat itself and for a file the user named or attached in their own message. For anything else, tell the user to ask in one of their own chats.', 'refused: shared chat')
        }
        if (!f && !d && !shared) return no(NOT_FOUND, 'not found')

        // ---- a file the person has only through a share ----
        if (shared) {
          const lines = [`"${safe(shared.name)}" is a file shared with the user: they can view it (${words(shared.self)}).`,
            shared.owner ? `It is ${safe(shared.owner.name, 80)}'s file: only they see and change who else can open it.` : 'Who else can open it is for its owner to see.']
          if (who && who.id !== spec.userId) {
            fixes = shareFixesOf(ctx).forFiles(spec.userId, spec.chatId, [{ share: shared.shareId, people: [who.id] }], { named: true })
            const fix = fixes[0]
            lines.push(fix ? `Whether ${whoName} can open it is not the user's to see. ${BUTTON}: "Ask ${safe(fix.owner ?? 'the owner', 80)}" (it asks them to let ${whoName} view the file; they decide). Tell the user in one short sentence.`
              : `Whether ${whoName} can open it is not the user's to see.`)
          }
          return ok(lines, 'file shared with the user')
        }

        // ---- a folder ----
        if (d) {
          const lines: string[] = []
          const name = `The folder "${safe(d.place, 160)}"`
          if (d.personal) {
            // the folder's own share, as its owner's dialog says it
            let folderShare: string | null = null
            if (d.path.split('/')[1] === spec.userId) {
              try {
                const v = fileSharesOf(ctx).view(spec.userId, d.path, spec.locale)
                folderShare = v.people.length
                  ? `${name} is in the user's own files and shared with ${v.people.length === 1 ? 'one person or group' : `${v.people.length} people or groups`} (view only, files added later included): ${v.people.slice(0, NAMES_MAX).map((p) => safe(p.name, 80)).join(', ')}. share_folder takes people off it.`
                  : `${name} is in the user's own files: only they can open it. It can be shared as a whole with share_folder, when the user asks.`
              } catch { folderShare = null }
            }
            lines.push(folderShare ?? `${name} is in the user's own files: only they can open it.`)
            if (who && who.id !== spec.userId) lines.push(`${whoName} cannot open it.`)
            return ok(lines, 'own folder')
          }
          lines.push(`${name}: the user can open it${d.self ? ` (${words(d.self)})` : ''}.${d.people !== null ? ` ${people(d.people)} on the team can open it.` : ''}`)
          if (d.full && d.names) lines.push(`They are the user and: ${d.names.map((n) => safe(n, 80)).join(', ') || 'nobody else'}${d.people !== null && d.people - 1 > d.names.length ? ` and ${d.people - 1 - d.names.length} more` : ''}.`)
          let target: string | null = null
          if (who && who.id !== spec.userId) {
            if (d.full) {
              const r = accessRouteFor(ctx, who.id, d.path)
              lines.push(r ? `${whoName} can open it: ${words(r)}.` : `${whoName} cannot open it: the folder's access does not include them or a group they are in. The user is an admin and can add them: Share on the folder in Files.`)
            } else {
              lines.push(`Whether ${whoName} can open it is for the team's owner and admins to see.`)
              target = who.id
            }
          }
          // "Ask an admin" only when one teammate was asked about and cannot open it: its message asks to let exactly them
          // in. A plain "who can open it?" is a question, not a request: no button (its message would ask to share the
          // folder with more people, which nobody asked for)
          if (!d.full && target && !accessRouteFor(ctx, target, d.path)) {
            const fix = shareFixesOf(ctx).forFolder(spec.userId, spec.chatId, d.path, [target], spec.locale)
            if (fix) { fixes = [fix]; lines.push(`Only the team's owner and admins can change who can open a team folder. ${BUTTON}: "Ask an admin" (it sends ${safe(fix.owner ?? 'an admin', 120)} a message from the user; nothing changes by itself). Tell them in one short sentence.`) }
            else lines.push('Only the team\'s owner and admins can change who can open a team folder.')
          } else if (!d.full) lines.push('Only the team\'s owner and admins can change who can open a team folder.')
          return ok(lines, `folder${d.people !== null ? `, ${d.people} people` : ''}`)
        }

        // ---- a file the person can open by the folder rules ----
        const file = f!
        const lines: string[] = []
        // the shared folders above it (its owner only; merge of AI and folder sharing)
        let through: { name: string; people: { subjectType: 'user' | 'group'; subjectId: string; name: string; everyone?: boolean }[] }[] = []
        if (file.mine) { try { through = fileSharesOf(ctx).view(spec.userId, file.path, spec.locale).through ?? [] } catch {} }
        const owner = file.mine ? 'the user\'s own file' : file.owner ? `${safe(file.owner.name, 80)}'s file` : 'a team file with no known owner'
        lines.push(`"${safe(file.name)}" in "${safe(file.place, 160)}" is ${owner}. The user can open it${file.self ? ` (${words(file.self)})` : ''}.`)
        if (file.full) {
          lines.push(file.shared.length
            ? `Shared with (view only): ${file.shared.map((s) => s.kind === 'group' ? `the "${safe(s.who, 80)}" group (${people(s.people ?? 0)})` : s.kind === 'everyone' ? 'everyone on the team' : safe(s.who, 80)).join(', ')}.`
            : 'It is not shared with anyone by name or group.')
          if (file.byFolder) lines.push(`${people(file.byFolder.people)} besides the user can open it through its folder${file.byFolder.names ? `: ${file.byFolder.names.map((n) => safe(n, 80)).join(', ') || 'nobody'}${file.byFolder.people > file.byFolder.names.length ? ` and ${file.byFolder.people - file.byFolder.names.length} more` : ''}` : ''}.`)
          if (file.total !== null) lines.push(`In all, ${people(file.total)} can open it now${through.length ? ', besides the people of the shared folder below' : ''}.`)
          // a file inside a folder the user shared (folder sharing; its owner only: FolderShares.throughOf)
          for (const t of through) lines.push(`It is inside the user's shared folder "${safe(t.name, 80)}", so ${t.people.length ? t.people.slice(0, NAMES_MAX).map((p) => safe(p.name, 80)).join(', ') : 'nobody yet'} can view it too (view only; share_folder changes that).`)
        } else lines.push(file.owner ? `Who else can open it is for its owner (${safe(file.owner.name, 80)}) to see.` : 'Who else can open it is for the team\'s owner and admins to see.')
        if (who && who.id !== spec.userId) {
          if (file.full) {
            const r = accessRouteFor(ctx, who.id, file.path)
            const inFolder = r ? null : through.find((t) => t.people.some((p) => p.subjectType === 'user' ? p.subjectId === who.id
              : p.everyone || !!db.query('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(p.subjectId, who.id)))
            if (r) lines.push(`${whoName} can already open it: ${words(r)}.`)
            else if (inFolder) lines.push(`${whoName} can already open it: through the shared folder "${safe(inFolder.name, 80)}" (view only).`)
            else if (file.canShare) lines.push(`${whoName} cannot open it: it is not shared with them or a group they are in, and its folder does not let them in. The user can share it with them (share_with_person, when the user asks: they get a card).`)
            else lines.push(`${whoName} cannot open it. ${file.shareOff ? 'The team turned off sharing files for members, so the user cannot share it; an admin can.' : 'The user cannot share it now.'}`)
          } else {
            fixes = shareFixesOf(ctx).forFiles(spec.userId, spec.chatId, [{ path: file.path, people: [who.id] }], { named: true })
            const fix = fixes[0]
            lines.push(fix ? `Only its owner can share it. ${BUTTON}: "Ask ${safe(fix.owner ?? 'the owner', 80)}" (it asks them to let ${whoName} view the file; they decide). If ${whoName} can open it already, the button does nothing. Tell the user in one short sentence.`
              : `Whether ${whoName} can open it is not the user's to see, and only its owner can share it.`)
          }
        }
        return ok(lines, `file${file.total !== null ? `, ${file.total} people` : ''}`)
      } finally {
        // (every call patches its own step exactly once: TurnExec.patchToolStep is first in, first out per tool)
        exec.patchToolStep(WHO_CAN_OPEN_TOOL, (): Partial<Step> => (fixes.length ? { fixes } : {}))
      }
    },
  }
}
