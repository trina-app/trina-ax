// change_folder_access (docs/decisions/20261116-team-folder-ai-and-ask.md; design docs/AGENTS/plan/
// 20261116-1147-folder-sharing.md "change_folder_access", security review M8, threats T18 and T19): the team's owner or
// an admin gives ONE person or group access to ONE team folder, changes their level or takes them off, by asking the AI.
// A member who asks gets the existing "Ask an admin" button (files/share-fixes.ts forFolder: their own 1:1 message to
// the owner and admins, written by the server); nothing else.
//
// The rules:
// - Where: the person's own chat with them there. Not offered, and refused when reached anyway, in a scheduled run, a
//   question from Slack, a confidential chat, an approved template's or a restricted run, a shared chat, a chat other
//   people wrote in, a guest's turn; refused for a sub-agent (PARENT_ONLY_TOOLS).
// - Who: the role is re-read at the call (livePrincipal), again when the card is answered, and saveFolderAccess runs
//   only for the owner or an admin. For anyone else the folder is resolved first as they may see it: a folder they
//   cannot list answers exactly like a missing one (the same words, the same audit reason); only for a folder they can
//   open the step gets "Ask an admin" (T18).
// - What: a team folder (never the team root, users/, a project's folder or skills/, whose managers are picked on
//   Admin › Members), one person or group (never "everyone": General access and Limit access are not the AI's), view
//   or edit. A guest only where they have a rule already (their one project: the save refuses anywhere else).
// - The card every time (M8): no "Always allow" kind, no explicit-ask skip, for adds, changes and removals alike. It
//   shows the folder and the person in the server's words, how many people open it now and after, who gets and loses
//   access (from the same preview as Admin › Folder permissions: admin/access-explain.ts explainEdit). When the change
//   takes the folder from someone while files inside are shared one by one, the PERSON picks on the card whether those
//   shares go too (the AI has no input for it; T19). At most three cards an answer, none after a no, one at a time.
// - After outside content (a room read, a side chat or quote, content someone else wrote: chats.others_words, which a
//   file another person wrote, a web page or looking_at sets; a tainted session) the admin's OWN message of this turn
//   must name the folder (its path, or its name in quotes: M9) and the person or group in full; else refused with a
//   plain next step.
// - The yes is bound to the plan: on yes everything is planned again and must equal the card's (the rules hash, the
//   rules after, who gains and loses access, the folders below), then saveFolderAccess (admin/folder-save.ts, the
//   dialog's own save: its checks, the hash inside the transaction, via 'ai' on the audit row).
// - Audit: one folder.ai_access row per call (action, subject type, outcome, reason), plus the save's folder.rules row.
// - The result is the shared card record (Step.shared with `teamFolder`): written by the server, shown only to the
//   person whose turn it was (ChatStore.viewSteps).
import crypto from 'node:crypto'
import { ChangeFolderAccessInput, uuidv7 } from '@mycel/shared'
import { plainLabel, TEAM_FOLDER_NAMES_MAX, type FolderEditPreview, type FolderRuleInput, type Locale, type Step, type StepShared, type TeamFolderResult, type TurnRequest } from '@mycel/shared/api'
import { esContract, esMark } from '@mycel/shared/es-contract'
import { fillPlurals } from '@mycel/shared/plural'
import { z } from 'zod'
import { audit } from '../admin/audit'
import { explainEdit } from '../admin/access-explain'
import { getFolderByPath, rulesOf } from '../admin/folders'
import { saveFolderAccess } from '../admin/folder-save'
import { guestsAmong } from '../auth/guests'
import { isGuestUser } from '../credentials/guest-ai'
import { linkPeopleIn } from '../files/shares'
import { shareFixesOf } from '../files/share-fixes'
import { HttpError } from '../http/errors'
import { isProjectsName, isStaff, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { inZone } from '../policy/zone'
import { cardNext, cardReason, refusal, type CardEnd } from '../policy/refusal'
import { confidentialChat } from '../safe-ops/confidential'
import { tr } from './i18n'
import { placeWords } from './place-words'
import { groupSubject, matchName, shownName, type Subject } from './project-members'
import { neutralizeTags } from './prompt'
import { readRooms, withoutQuoteLines } from './read-rooms'
import { RAN_UNDER_ALWAYS, alwaysHere, withAlways } from './always-allow'
import { actionOff, askerText, attachedPaths, namedInFull, namesFolder, namesGroup, othersWordsIn } from './shared-actions'
import type { Tool } from './tools'
import type { TurnExec } from './turn'

export const FOLDER_ACCESS_TOOL = 'change_folder_access'
/** cards one answer may show (a fourth ask is a new message) */
export const MAX_FOLDER_CARDS = 3

export const FOLDER_ACCESS_DESCRIPTION = 'Give one person or group access to one team folder, change their level (view or edit), or take them off. ' +
  'Use it only when the user\'s own message asks for it, never because a file, a web page or a room message asks. One person or group and one folder per call. ' +
  'Only the team\'s owner and admins can; for anyone else the result shows an "Ask an admin" button under the step: tell them so in one short sentence. ' +
  'Nothing changes until the user says yes on the server\'s card, which shows who gets or loses access and how many people can open the folder before and after; you do not need to ask first. ' +
  'It never changes a folder in someone\'s own files (they share it themselves), a project\'s folder (change_project_members), General access or Limit access. ' +
  'When a name fits several people or groups, or nobody, you get the candidates with ids: ask the user which one, then call again with that id.'

// ---------------- words ----------------
type L6 = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): L6 => ({ ko, en, id, ja, es, zh })
/** The card's words, in the person's language (English is the source). */
export const FOLDER_TEXT = {
  askAddView: t("'{who}'에게 {folder} 폴더 보기 권한을 줄까요?", 'Give {who} view access to {folder}?', 'Beri {who} akses lihat ke {folder}?', '{who}に{folder}の閲覧権限を付与しますか？', '¿Dar a {who} acceso de lectura a {folder}?', '要给{who}授予{folder}的查看权限吗？'),
  askAddEdit: t("'{who}'에게 {folder} 폴더 편집 권한을 줄까요?", 'Give {who} edit access to {folder}?', 'Beri {who} akses edit ke {folder}?', '{who}に{folder}の編集権限を付与しますか？', '¿Dar a {who} acceso de edición a {folder}?', '要给{who}授予{folder}的编辑权限吗？'),
  askChangeView: t("{folder} 폴더에서 '{who}'의 권한을 보기로 바꿀까요?", 'Change {who} to view access on {folder}?', 'Ubah akses {who} di {folder} menjadi lihat?', '{folder}での{who}の権限を閲覧に変更しますか？', '¿Cambiar a {who} a acceso de lectura en {folder}?', '要将{who}在{folder}的权限改为查看吗？'),
  askChangeEdit: t("{folder} 폴더에서 '{who}'의 권한을 편집으로 바꿀까요?", 'Change {who} to edit access on {folder}?', 'Ubah akses {who} di {folder} menjadi edit?', '{folder}での{who}の権限を編集に変更しますか？', '¿Cambiar a {who} a acceso de edición en {folder}?', '要将{who}在{folder}的权限改为编辑吗？'),
  askRemove: t("{folder} 폴더에서 '{who}'의 권한을 뺄까요?", 'Take {who} off {folder}?', 'Hapus {who} dari {folder}?', '{folder}から{who}を外しますか？', '¿Quitar a {who} de {folder}?', '要将{who}从{folder}中移除吗？'),
  group: t('{name} 부서', 'the {name} group', 'grup {name}', '{name}グループ', 'el grupo {name}', '{name}小组'),
  counts: t('지금 {before}명이 열 수 있어요. 바꾸면 {after}명이 돼요.', 'Now: {before, plural, one {# person} other {# people}} can open it. After: {after, plural, one {# person} other {# people}}.', 'Sekarang: {before} orang bisa membukanya. Sesudahnya: {after} orang.', '現在{before}人が開けます。変更後は{after}人です。', 'Ahora: {before, plural, one {# persona puede} other {# personas pueden}} abrirla. Después: {after, plural, one {# persona} other {# personas}}.', '现在有{before}人可以打开。修改后为{after}人。'),
  gains: t('새로 열 수 있는 사람: {names}', 'Gets access: {names}', 'Mendapat akses: {names}', 'アクセスできるようになる人: {names}', 'Obtiene acceso: {names}', '获得权限：{names}'),
  loses: t('더 이상 못 여는 사람: {names}', 'Loses access: {names}', 'Kehilangan akses: {names}', 'アクセスできなくなる人: {names}', 'Pierde el acceso: {names}', '失去权限：{names}'),
  up: t('편집할 수 있게 되는 사람: {names}', 'Can edit from now on: {names}', 'Bisa mengedit mulai sekarang: {names}', '編集できるようになる人: {names}', 'Podrá editar a partir de ahora: {names}', '今后可以编辑：{names}'),
  down: t('보기만 할 수 있게 되는 사람: {names}', 'Can only view from now on: {names}', 'Hanya bisa melihat mulai sekarang: {names}', '閲覧のみになる人: {names}', 'Solo podrá ver a partir de ahora: {names}', '今后只能查看：{names}'),
  nobody: t('없음', 'nobody', 'tidak ada', 'なし', 'nadie', '无'),
  more: t('{list} 외 {n}명', '{list} and {n} more', '{list} dan {n} lainnya', '{list}ほか{n}人', '{list} y {n} más', '{list}等另外{n}人'),
  below: t('안쪽 폴더 {n}개에서도 바뀌어요.', 'It changes in {n, plural, one {# folder} other {# folders}} inside too.', 'Ini juga berubah di {n} folder di dalamnya.', '中のフォルダ{n}個でも変わります。', 'También cambia en {n, plural, one {# carpeta} other {# carpetas}} de dentro.', '里面的{n}个文件夹也会改变。'),
  groupLater: t('부서에 나중에 들어오는 사람도 열 수 있어요.', 'Whoever joins the group later can open it too.', 'Siapa pun yang bergabung ke grup nanti juga bisa membukanya.', 'あとからグループに入る人も開けます。', 'Quien se una al grupo más adelante también podrá abrirla.', '以后加入该小组的人也可以打开。'),
  links: t('안에 있는 파일 중 {n}명에게 따로 공유된 파일이 있어요. 그 공유를 함께 없앨지 골라 주세요.', 'Files inside are shared one by one with {n, plural, one {# person} other {# people}}. Choose whether those shares go too.', 'Berkas di dalamnya dibagikan satu per satu dengan {n} orang. Pilih apakah bagikan itu ikut dihapus.', '中のファイルが個別に{n}人と共有されています。その共有も外すか選んでください。', 'Hay archivos dentro compartidos uno a uno con {n, plural, one {# persona} other {# personas}}. Elija si esos permisos también se quitan.', '里面有文件单独共享给了{n}人。请选择是否同时取消这些共享。'),
  label: t('열 수 있는 사람', 'Who can open it', 'Siapa yang bisa membukanya', '開ける人', 'Quién puede abrirla', '谁可以打开'),
  yes: t('바꾸기', 'Change', 'Ubah', '変更する', 'Cambiar', '修改'),
  yesRemoveLinks: t('바꾸고 파일 공유도 없애기', 'Change and remove file shares', 'Ubah dan hapus bagikan berkas', '変更してファイル共有も外す', 'Cambiar y quitar los archivos compartidos', '修改并取消文件共享'),
  yesKeepLinks: t('바꾸고 파일 공유는 두기', 'Change, keep file shares', 'Ubah, pertahankan bagikan berkas', '変更してファイル共有は残す', 'Cambiar y mantener los archivos compartidos', '修改但保留文件共享'),
  no: t('취소', 'Cancel', 'Batal', 'キャンセル', 'Cancelar', '取消'),
  /** the plan changes nobody's access (the same people, with the same access, before and after): no card (QA TC-4390) */
  noChange: t('바꿔도 달라지는 게 없어요. {folder} 폴더는 지금과 같은 사람들이 같은 권한으로 열 수 있어요.', 'Nothing would change: the same people can open {folder}, with the same access, before and after.', 'Tidak ada yang berubah: orang yang sama tetap bisa membuka {folder} dengan akses yang sama.', '変更しても何も変わりません。{folder}は今と同じ人が同じ権限で開けます。', 'No cambiaría nada: las mismas personas pueden abrir {folder}, con el mismo acceso, antes y después.', '不会有任何变化：修改前后，能打开{folder}的人和权限都一样。'),
} satisfies Record<string, L6>
// (Spanish: "¿Quitar a {who}…" with "el grupo Ventas" reads "al grupo Ventas": shared/src/es-contract.ts)
const fill = (s: string, v: Record<string, string | number>, L: Locale) => esContract(fillPlurals(s, v, L).replace(/\{(\w+)\}/g, (_, k) => esMark(L, String(v[k] ?? ''))))
const say = (k: keyof typeof FOLDER_TEXT, L: Locale, v: Record<string, string | number> = {}) => fill(FOLDER_TEXT[k][L], v, L)

// ---------------- where it runs ----------------
const NONE = 'Nothing was changed in who can open the folder'
const SCREEN = 'Admin › Folder permissions, or Share on the folder in Files'
/** a folder that is not there and one the person may not see read the same, on purpose (T18) */
const NOT_FOUND = refusal({ done: NONE, why: { kind: 'failed', what: 'no team folder of that name was found, or the user cannot open it (the same answer for both, on purpose)' }, next: 'check the folder\'s path with list, or ask the user which folder they mean' })

type FolderExec = Pick<TurnExec, 'spec' | 'rt' | 'shared' | 'restricted' | 'templateRun' | 'otherAuthors' | 'fromSlack' | 'files' | 'roomsSeen' | 'askPerson' | 'openRequests' | 'livePrincipal' | 'patchToolStep'>
  & Partial<Pick<TurnExec, 'othersWords' | 'tainted' | 'alwaysPlace'>>

/** Why change_folder_access is not offered in this turn (and refused when reached anyway), or null: the person's own
 * chat with them there. */
export function folderAccessOff(exec: Pick<FolderExec, 'spec' | 'rt' | 'shared' | 'restricted' | 'templateRun' | 'otherAuthors' | 'fromSlack'>): { text: string; reason: string } | null {
  const no = (reason: string, mode: string, next: string) => ({ reason, text: refusal({ done: NONE, why: { kind: 'mode', mode }, next }) })
  const own = 'the user can ask in a chat of their own (a new AI chat)'
  const off = actionOff(exec, null)
  if (off === 'schedule') return no('scheduled run', 'a scheduled run (nobody is there to answer the card)', `${own}, or change it on ${SCREEN}`)
  if (off === 'confidential' || confidentialChat(exec.rt.db, exec.spec.chatId)) return no('confidential chat', 'a confidential chat (safe operations)', `the user can change it on ${SCREEN}`)
  if (off === 'slack' || exec.fromSlack) return no('slack', 'a question from Slack or a Slack thread\'s chat', `the user can ask in the app's AI chat, or change it on ${SCREEN}`)
  if (off === 'restricted' || exec.restricted || exec.templateRun) return no('limited run', 'a run limited to one task', `${own}, or change it on ${SCREEN}`)
  if (exec.shared) return no('shared chat', 'a shared chat', `${own}, or change it on ${SCREEN}`)
  if (exec.otherAuthors) return no('other authors', 'a chat other people wrote in', `${own}, or change it on ${SCREEN}`)
  if (isGuestUser(exec.rt.db, exec.spec.userId)) return no('guest', 'a guest\'s chat', 'a team admin can change it')
  return null
}

// ---------------- the plan ----------------
const toAccess = (a: 'view' | 'edit') => (a === 'edit' ? 'write' as const : 'read' as const)
const keyOf = (s: { subjectType: string; subjectId: string | null }) => `${s.subjectType}:${s.subjectId ?? ''}`
const ruleKey = (r: { subjectType: string; subjectId: string | null; access: string }) => `${keyOf(r)}:${r.access}`
/** a name for the AI: one line, invisible characters shown, no tags */
const ai = (s: string) => neutralizeTags(shownName(s).slice(0, 200))

/** The rules the dialog shows and saves: people, groups and everyone with view or edit (the markers stay: writeFolderAccess). */
function grantsOf(db: TurnExec['rt']['db'], path: string): { rules: FolderRuleInput[]; limited: boolean; rowId: string | null } {
  const row = getFolderByPath(db, path)
  if (!row) return { rules: [], limited: false, rowId: null }
  const rules = rulesOf(db, row.id).filter((r) => (r.subjectType === 'user' || r.subjectType === 'group' || r.subjectType === 'everyone') && r.access !== 'none')
    .map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access }) as FolderRuleInput)
  return { rules, limited: row.limited === 1, rowId: row.id }
}

export interface FolderPlan {
  path: string
  name: string
  place: string
  rowId: string | null
  limited: boolean
  subject: Subject
  action: 'add' | 'change' | 'remove'
  access?: 'view' | 'edit'
  next: FolderRuleInput[]
  preview: FolderEditPreview
  before: number
  after: number
  gained: string[]; gainedCount: number
  lost: string[]; lostCount: number
  up: string[]; upCount: number
  down: string[]; downCount: number
  /** people who have files inside by their own shares, when the change takes the folder from someone */
  linkPeople: number
  fingerprint: string
}

export function folderAccessTool(exec: TurnExec): Tool {
  return folderAccessToolFor(exec)
}

/** The tool on a narrow exec (tests build one). */
export function folderAccessToolFor(exec: FolderExec): Tool {
  const { rt, spec } = exec
  const db = rt.db, ctx = rt.ctx
  type CardState = { shown: number; declined: boolean; open: boolean }
  const state: CardState = cardStateOf(exec)
  type Audit = (detail: Record<string, unknown>, target: string | null) => void
  const auditor = (input: { action?: string } = {}): Audit => {
    let written = false
    return (detail, target) => {
      if (written) return
      written = true
      try { audit(db, { actor: spec.userId, action: 'folder.ai_access', target, detail: { turnId: spec.turnId, chatId: spec.chatId, ...(input.action ? { action: input.action } : {}), ...detail } }) }
      catch (e) { rt.log.warn('change_folder_access audit row failed', { err: e, turn: spec.turnId }) }
    }
  }
  const result = (text: string, summary: string, isError = true) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}), summary: `${FOLDER_ACCESS_TOOL} -> ${summary}` })
  const patch = (p: Partial<Step>) => { try { exec.patchToolStep(FOLDER_ACCESS_TOOL, () => p) } catch {} }

  return {
    name: FOLDER_ACCESS_TOOL,
    description: FOLDER_ACCESS_DESCRIPTION,
    inputSchema: schema(ChangeFolderAccessInput),
    label(args, L) {
      const a = args && typeof args === 'object' ? (args as { folder?: unknown }) : {}
      const verb = tr('folderAccessStep', L)
      const f = typeof a.folder === 'string' ? a.folder.replace(/\/+$/, '').split('/').pop() ?? '' : ''
      return f ? `${verb} · ${shownName(f).slice(0, 60)}` : verb
    },
    refuse() {
      const no = folderAccessOff(exec)
      if (!no) return null
      auditor()({ outcome: 'refused', reason: no.reason }, null)
      return { text: no.text, summary: `${FOLDER_ACCESS_TOOL} -> refused: ${no.reason}` }
    },
    async call(args, files) {
      const a0 = args && typeof args === 'object' ? (args as { action?: unknown }) : {}
      const auditCall = auditor({ action: typeof a0.action === 'string' ? a0.action : undefined })
      try { return await run(args, files, auditCall) } catch (e) {
        rt.log.warn('change_folder_access failed', { err: e, turn: spec.turnId })
        auditCall({ outcome: 'failed', reason: 'error' }, null)
        return result(refusal({ done: NONE, why: { kind: 'failed', what: 'an internal error' }, next: `the user can change it on ${SCREEN}` }), 'failed')
      }
    },
  }

  async function run(args: unknown, files: unknown, auditCall: Audit) {
    const L = spec.locale
    const refused = (reason: string, text: string, target: string | null = null, more: Record<string, unknown> = {}) => {
      auditCall({ outcome: 'refused', reason, ...more }, target)
      return result(text, `refused: ${reason}`)
    }
    const parsed = ChangeFolderAccessInput.safeParse(args)
    if (!parsed.success) return refused('invalid_input', 'Invalid input: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const input = parsed.data
    // the main AI only (subagents.ts PARENT_ONLY_TOOLS): a sub-agent's call comes with its own turn state
    if (files !== exec.files) return refused('subagent', refusal({ done: NONE, why: { kind: 'mode', mode: 'a sub-task', why: 'only the main assistant changes folder access, after the user\'s yes on its card' }, next: 'put the change in your report; the main assistant asks the user' }))
    const mode = folderAccessOff(exec)
    if (mode) return refused(mode.reason, mode.text)
    let me: Principal
    try { me = exec.livePrincipal() } catch { return refused('account_disabled', 'Access denied: this account is disabled.') }
    if (me.role === 'guest') return refused('guest', refusal({ done: NONE, why: { kind: 'mode', mode: 'a guest\'s chat' }, next: 'a team admin can change it' }))

    // ---- the folder, as the person may see it: a hidden one reads exactly like a missing one (T18) ----
    const seen = folderAsSeen(me, input.folder)
    if (!seen) return refused('not_found', NOT_FOUND)
    const path = seen
    const segs = path.split('/')
    if (segs[0] === 'users') return refused('personal_folder', refusal({ done: NONE, why: { kind: 'mode', mode: 'a folder in someone\'s own files', why: 'folder access rules apply to team folders only' }, next: 'a folder in the user\'s own files is shared from Share on the folder in Files' }), path)
    if (inZone(path) || (segs.length === 1 && isProjectsName(segs[0]!))) return refused('project', refusal({ done: NONE, why: { kind: 'mode', mode: 'a project\'s folder', why: 'its members are changed on the project\'s page' }, next: 'use change_project_members, or the user changes them on the project\'s page' }), path)
    if (segs[0]!.toLowerCase() === 'skills') return refused('skills', refusal({ done: NONE, why: { kind: 'mode', mode: 'the team skills folder', why: 'who may change the team\'s skills is picked on Admin › Members (skill managers)' }, next: 'the user can pick skill managers on Admin › Members' }), path)

    // ---- a member: nothing is planned or previewed; one "Ask an admin" button under the step (T18) ----
    if (!isStaff(me)) {
      const person = matchName(input.who.name, everyone().filter((s) => s.subjectType === 'user'), input.who.id ? { id: input.who.id } : {})
      const fix = shareFixesOf(ctx).forFolder(spec.userId, spec.chatId, path, 'one' in person ? [person.one.subjectId] : [])
      if (fix) patch({ fixes: [fix] })
      auditCall({ outcome: 'needs_admin', subjectType: 'one' in person ? person.one.subjectType : null }, path)
      return result(fix
        ? `${NONE}. Only the team's owner and admins can change who can open a team folder. A button is shown to the user under this step: "Ask an admin" (it sends ${ai(fix.owner ?? 'an admin')} a message from the user; nothing changes by itself). Tell the user in one short sentence that they can press it; do not repeat the folder's path.`
        : `${NONE}. Only the team's owner and admins can change who can open a team folder, and there is no admin to ask. Tell the user in one short sentence.`, 'needs admin', false)
    }

    // ---- the person or group ----
    const pool = everyone()
    const m = matchName(input.who.name, pool, input.who.id ? { id: input.who.id } : {})
    if ('none' in m) return refused('name_not_found', refusal({ done: NONE, why: { kind: 'failed', what: `nobody on the team and no group is called '${ai(input.who.name)}'` }, next: 'ask the user who they mean' }), path)
    if ('many' in m || 'wrongId' in m) {
      const c = 'many' in m ? m.many : m.wrongId
      return refused('name_unclear', refusal({ done: NONE, why: { kind: 'failed', what: `several people or groups fit '${ai(input.who.name)}': ${c.slice(0, 10).map((s) => `${ai(s.name)} (${s.subjectType === 'group' ? 'group' : 'person'}, id ${s.subjectId})`).join(', ')}` }, next: 'ask the user which one, then call again with that id' }), path)
    }
    const subject = m.one

    // ---- after outside content: the admin's own message names the folder and the person (M8, M9); not for an admin who
    // chose "Always allow" for this card (Rule A, #1143: their choice is final; the tool is never offered in a chat with
    // other members' messages, folderAccessOff) ----
    const alwaysOn = alwaysHere(exec.alwaysPlace?.(), 'folder_access') === 'on'
    if (!alwaysOn && (othersWordsIn(exec) || !!exec.tainted)) {
      const said = withoutQuoteLines(askerText(db, spec.userMessageId))
      const username = subject.subjectType === 'user' ? (db.query('SELECT username FROM users WHERE id = ?').get(subject.subjectId) as { username: string | null } | null)?.username ?? null : null
      if (!namesFolder(said, path, { place: placeWords(db, path, L, spec.userId), attached: attachedPaths(db, spec.userMessageId) }) || !(subject.subjectType === 'group' ? namesGroup(said, subject.name) : namedInFull(said, [subject.name, ...(subject.aliases ?? []), ...(username ? [username] : [])])))
        return refused('not_named', refusal({ done: NONE, why: { kind: 'mode', mode: 'a chat that holds other people\'s words (a room, a shared file, a web page or what is on the screen)', why: 'one of them could ask for the change' }, also: 'Ask the user to name the folder (its path, or its name in quotes) and the person or group in their own message', next: 'the user names both in a new message, or changes it on ' + SCREEN }), path)
    }

    // ---- the plan ----
    const planned = planFor(path, subject, input.action, input.access, L)
    if ('text' in planned) return refused(planned.reason, planned.text, path)
    const p = planned
    // nobody's access changes, here or in a folder inside, today or for whoever joins later (they already open it
    // through a group, everyone or a folder above): no card, nothing saved, one plain sentence (QA TC-4390: the card
    // offered "Change" with the same people before and after)
    if (!p.preview.changes.some((c) => c.count > 0) && !p.preview.below.some((b) => b.less || b.more) && !p.preview.belowMore && !p.preview.latentMore)
      return refused('no_change', `${NONE}: this change would not change who can open the folder or what they can do there (the same people, with the same access, before and after), so nothing was asked or saved. Tell the user exactly this one sentence and nothing more: "${say('noChange', L, { folder: p.place })}"`, path)

    if (state.declined) return refused('declined', refusal({ done: NONE, why: { kind: 'declined' }, also: 'The user said no to a folder access card earlier in this answer, so no other is asked in it; do not change it another way', next: cardNext('declined') }), path)
    if (state.shown >= MAX_FOLDER_CARDS) return refused('too_many', refusal({ done: NONE, why: { kind: 'limit', limit: `at most ${MAX_FOLDER_CARDS} folder access cards in one answer`, resets: 'with the user\'s next message' }, next: 'tell the user what is left; they can ask again in a new message' }), path)
    if (state.open || exec.openRequests().length) return refused('busy', refusal({ done: NONE, why: { kind: 'limit', limit: 'one card at a time: another card is waiting for the user\'s answer' }, next: 'wait for that answer, then call again' }), path)

    // ---- the card, with "Always allow" (kind folder_access, the owner's 11-13 rule; Rule A: once chosen it is final, no
    // card). No explicit-ask skip (M8). A narrowing that would take file links away is never decided by "Always allow":
    // it keeps the links (removeFileLinks false), the person's choice is only ever theirs on the card ----
    const card = cardOf(p, L, readRooms(exec) ? tr('roomsSeenWhy', L) : null)
    const requestId = uuidv7()
    const base = { subjectType: subject.subjectType, gained: p.gainedCount, lost: p.lostCount, requestId, ...(alwaysOn ? { always: true } : {}) }
    state.shown++
    state.open = true
    // "Always allow" answers yes; where the card would ask about file links, that yes keeps them
    const yes = p.linkPeople > 0 ? 'change_keep' : 'change'
    let missing: Awaited<ReturnType<FolderExec['askPerson']>>['missing'] = null
    let raw: unknown
    try {
      raw = await withAlways(exec.alwaysPlace?.(), 'folder_access', card.options, yes, async (options, more) => {
        // a card's note is at most 300 characters (AskUserRequest.note; a longer one is dropped by the app, so the card
        // never shows): with "Always allow" offered too, the file shares line goes last in the card's lines
        const both = !!(card.note && more.note)
        const details = both ? card.details.map((d, i) => (i === 0 ? { ...d, text: `${d.text}\n${card.note}` } : d)) : card.details
        const a = await exec.askPerson({
          kind: 'ask_user', origin: 'server', requestId, question: card.question, multiple: false, allowText: false,
          options, details, ...(options.length >= 3 ? { buttons: true as const } : {}),
          ...(card.note || more.note ? { note: both ? more.note : (card.note ?? more.note) } : {}),
          expiresAt: new Date(Date.now() + rt.askUserTimeoutMs()).toISOString(),
        } as TurnRequest, { timeoutMs: rt.askUserTimeoutMs(), exclusive: true })
        missing = a.missing
        return a.value
      })
    } finally { state.open = false }
    const v = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw
    if (v !== 'change' && v !== 'change_remove' && v !== 'change_keep') {
      state.declined = true
      const end: CardEnd = v === 'no' ? 'declined' : missing ?? 'declined'
      auditCall({ ...base, outcome: end === 'declined' ? 'declined' : 'no_answer', end }, path)
      return result(refusal({ done: NONE, why: cardReason(end), also: end === 'declined' ? 'Do not change it another way, and ask no other folder access change in this answer' : undefined, next: end === 'declined' ? cardNext('declined') : `${cardNext(end)}; or they change it on ${SCREEN}` }), end === 'declined' ? 'not allowed by the user' : 'no answer')
    }
    const removeFileLinks = v === 'change_remove' ? true : v === 'change_keep' ? false : undefined

    // ---- yes: the role and the plan again, then the dialog's own save with the hash checked inside it ----
    const changed = (what: string) => {
      auditCall({ ...base, outcome: 'changed', what }, path)
      patch({ shared: sharedOf(p, 'refused', { reason: 'changed' }) })
      return result(refusal({ done: NONE, why: { kind: 'failed', what: `${what} changed while the card waited, so the user's yes no longer fits` }, next: 'call change_folder_access again so the user sees a new card' }), 'changed after the card')
    }
    let again: Principal
    try { again = exec.livePrincipal() } catch { auditCall({ ...base, outcome: 'refused', reason: 'account_disabled' }, path); return result('Access denied: this account is disabled.', 'denied: account disabled') }
    if (!isStaff(again) || again.role === 'guest') return changed('the user\'s role')
    if (folderAsSeen(again, path) !== path) return changed('the folder')
    const second = planFor(path, subject, input.action, input.access, L)
    if ('text' in second) return changed('the folder\'s access')
    if (second.fingerprint !== p.fingerprint) return changed('who can open the folder (its rules or its people)')
    // the person picks removeFileLinks only when the card asked; a pick the card did not offer is not passed on
    const links = p.linkPeople > 0 ? removeFileLinks : undefined
    try {
      saveFolderAccess(ctx, again.id, p.rowId ? { folderId: p.rowId } : { path, create: false }, { rules: p.next, limited: p.limited, expectedHash: p.preview.hash, ...(links !== undefined ? { removeFileLinks: links } : {}) }, 'en', { via: 'ai', turnId: spec.turnId, chatId: spec.chatId })
    } catch (e) {
      const reason = e instanceof HttpError ? String(e.extra.params?.reason ?? e.code) : 'error'
      if (reason === 'rules_changed' || reason === 'file_links_decide' || reason === 'folder_exists' || reason === 'client_outdated') return changed('the folder\'s rules')
      rt.log.warn('change_folder_access save failed', { err: e, turn: spec.turnId })
      auditCall({ ...base, outcome: 'failed', reason }, path)
      patch({ shared: sharedOf(p, 'refused', { reason: 'failed' }) })
      return result(refusal({ done: NONE, why: { kind: 'failed', what: e instanceof HttpError ? e.message : 'an internal error' }, next: `the user can change it on ${SCREEN}` }), 'failed')
    }
    auditCall({ ...base, outcome: 'done', ...(links !== undefined ? { removeFileLinks: links } : {}) }, path)
    patch({ shared: sharedOf(p, 'done', undefined, links) })
    const verb = p.action === 'remove' ? `took ${ai(subject.name)} off` : `gave ${ai(subject.name)} ${p.access} access to`
    return result([
      `Done: ${verb} the team folder "${ai(p.name)}" (${ai(p.place)})${alwaysOn ? '' : ', confirmed by the user on the card'}. ${p.after} people can open it now (${p.before} before).`,
      ...(alwaysOn ? [RAN_UNDER_ALWAYS] : []),
      'The user sees a card under your answer with the folder, the person or group and who gained or lost access, written by the app. Answer in one short sentence; do not repeat the path, the counts or the names.',
    ].join('\n'), `${p.action} ${subject.subjectType}, ${p.gainedCount} gain and ${p.lostCount} lose access (${alwaysOn ? 'Always allow, no card' : 'confirmed by the user'})`, false)
  }

  /** The folder at `input` as `me` may list it (its names on disk), or null: missing, hidden, a file, the team root. */
  function folderAsSeen(me: Principal, input: string): string | null {
    let a
    try { a = authorize(rt.files.fx, rt.files.rules(), me, input, 'list') } catch { return null }
    if (!a.st?.isDirectory() || !a.segs.length) return null
    return a.rel
  }

  /** every active account and every group, as names to match */
  function everyone(): Subject[] {
    const people = (db.query("SELECT u.id, u.name, u.guest FROM users u WHERE u.status = 'active' AND u.deleted_at IS NULL ORDER BY u.name, u.id").all() as { id: string; name: string; guest: number }[])
      .map((u): Subject => ({ subjectType: 'user', subjectId: u.id, name: u.name }))
    const groups = (db.query('SELECT g.id, g.name, (SELECT COUNT(*) FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = g.id AND u.status = \'active\' AND u.deleted_at IS NULL) people FROM groups g ORDER BY g.name, g.id').all() as { id: string; name: string; people: number }[])
      .map((g) => groupSubject(g))
    return [...people, ...groups]
  }

  function planFor(path: string, subject: Subject, action: 'add' | 'change' | 'remove', access0: 'view' | 'edit' | undefined, L: Locale): FolderPlan | { reason: string; text: string } {
    const now = grantsOf(db, path)
    const k = keyOf(subject)
    const have = now.rules.find((r) => keyOf(r) === k)
    const who = `${ai(subject.name)} (${subject.subjectType === 'group' ? 'group' : 'person'})`
    let next: FolderRuleInput[]
    let act = action
    let access: 'view' | 'edit' | undefined
    if (action === 'remove') {
      if (!have) return { reason: 'no_rule', text: refusal({ done: NONE, why: { kind: 'failed', what: `${who} has no access of their own on this folder; what they can open comes from a folder above, a group or everyone` }, next: `the user can look at who can open it on ${SCREEN}` }) }
      next = now.rules.filter((r) => keyOf(r) !== k)
    } else {
      access = access0 ?? (action === 'add' ? 'view' : undefined)
      if (!access) return { reason: 'no_level', text: 'Invalid input: access: say view or edit for a change.' }
      if (action === 'change' && !have) return { reason: 'no_rule', text: refusal({ done: NONE, why: { kind: 'failed', what: `${who} has no access of their own on this folder to change` }, next: 'call again with action add' }) }
      if (have && have.access === toAccess(access)) return { reason: 'unchanged', text: `${NONE}: ${who} already has ${access} access of their own on this folder. Tell the user in one short sentence.` }
      if (have) act = 'change'
      // a guest: only in their one project (a project's folder is refused above), so only a rule they have already
      if (subject.subjectType === 'user' && !have && guestsAmong(db, [subject.subjectId]).length) return { reason: 'guest', text: refusal({ done: NONE, why: { kind: 'mode', mode: 'a guest', why: 'a guest can be in one project only, never in a team folder' }, next: 'the user can add the guest to their project on the project\'s page' }) }
      const rule = { subjectType: subject.subjectType, subjectId: subject.subjectId, access: toAccess(access) } as FolderRuleInput
      next = have ? now.rules.map((r) => (keyOf(r) === k ? rule : r)) : [...now.rules, rule]
    }
    let preview: FolderEditPreview
    try { preview = explainEdit(ctx, { path, rules: next, limited: now.limited }, L) } catch (e) {
      return { reason: 'preview', text: refusal({ done: NONE, why: { kind: 'failed', what: e instanceof HttpError ? e.message : 'the preview of the change' }, next: `the user can change it on ${SCREEN}` }) }
    }
    const open = (xs: FolderEditPreview['now']) => xs.filter((x) => x.access !== 'none').reduce((n, x) => n + x.count, 0)
    const names = (cs: FolderEditPreview['changes']) => {
      const all = cs.flatMap((c) => c.people.map((u) => u.name))
      return { names: all.slice(0, TEAM_FOLDER_NAMES_MAX).map((n) => plainLabel(n, 200)), count: cs.reduce((n, c) => n + c.count, 0) }
    }
    const gained = names(preview.changes.filter((c) => c.direction === 'more' && c.before === 'none'))
    const lostC = preview.changes.filter((c) => c.direction === 'less' && c.after === 'none')
    const lost = names(lostC)
    const up = names(preview.changes.filter((c) => c.direction === 'more' && c.before !== 'none'))
    const down = names(preview.changes.filter((c) => c.direction === 'less' && c.after !== 'none'))
    const linkPeople = lostC.length && preview.exists ? linkPeopleIn(db, preview.path) : 0
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      path, hash: preview.hash, limited: now.limited, next: next.map(ruleKey).sort(),
      changes: preview.changes.map((c) => [c.direction, c.before, c.after, c.count, c.people.map((u) => u.id).sort()]),
      below: preview.below.map((b) => [b.path, b.less, b.more]), linkPeople: linkPeople > 0,
    })).digest('hex')
    const name = plainLabel(path.split('/').pop() ?? path, 200)
    return {
      path, name, place: plainLabel(placeWords(db, path, L, spec.userId), 500), rowId: now.rowId, limited: now.limited, subject, action: act, ...(access ? { access } : {}),
      next, preview, before: open(preview.now), after: open(preview.next),
      gained: gained.names, gainedCount: gained.count, lost: lost.names, lostCount: lost.count, up: up.names, upCount: up.count, down: down.names, downCount: down.count,
      linkPeople, fingerprint,
    }
  }

  /** The card: the question in the person's words, then the counts and who gets or loses access (server words only). */
  function cardOf(p: FolderPlan, L: Locale, why: string | null): { question: string; details: { label: string; text: string; noSize?: boolean }[]; options: { label: string; value: string }[]; note?: string } {
    const who = p.subject.subjectType === 'group' ? say('group', L, { name: shownName(p.subject.name) }) : shownName(p.subject.name)
    const folder = p.place
    const q = p.action === 'remove' ? say('askRemove', L, { who, folder })
      : p.action === 'change' ? say(p.access === 'edit' ? 'askChangeEdit' : 'askChangeView', L, { who, folder })
      : say(p.access === 'edit' ? 'askAddEdit' : 'askAddView', L, { who, folder })
    const list = (names: string[], count: number) => {
      if (!count) return say('nobody', L)
      const l = names.map(shownName).join(', ')
      return count > names.length ? say('more', L, { list: l, n: count - names.length }) : l
    }
    const lines = [
      ...(why ? [why] : []),
      say('counts', L, { before: p.before, after: p.after }),
      say('gains', L, { names: list(p.gained, p.gainedCount) }),
      say('loses', L, { names: list(p.lost, p.lostCount) }),
      ...(p.upCount ? [say('up', L, { names: list(p.up, p.upCount) })] : []),
      ...(p.downCount ? [say('down', L, { names: list(p.down, p.downCount) })] : []),
      ...(p.preview.below.length ? [say('below', L, { n: p.preview.below.length + p.preview.belowMore })] : []),
      ...(p.subject.subjectType === 'group' && p.action !== 'remove' ? [say('groupLater', L)] : []),
    ]
    const options = p.linkPeople > 0
      ? [{ label: say('yesRemoveLinks', L), value: 'change_remove' }, { label: say('yesKeepLinks', L), value: 'change_keep' }, { label: say('no', L), value: 'no' }]
      : [{ label: say('yes', L), value: 'change' }, { label: say('no', L), value: 'no' }]
    return { question: q, details: [{ label: say('label', L), text: lines.join('\n'), noSize: true }], options, ...(p.linkPeople > 0 ? { note: say('links', L, { n: p.linkPeople }) } : {}) }
  }

  /** The step's record (the shared card record, Step.shared): server words only, never a path. */
  function sharedOf(p: FolderPlan, outcome: 'done' | 'refused', refusal0?: { reason: 'changed' | 'failed' }, links?: boolean): StepShared {
    const s = p.subject
    const tf: TeamFolderResult = {
      name: p.name, place: p.place, action: p.action, ...(p.access ? { access: p.access } : {}), before: p.before, after: outcome === 'done' ? p.after : p.before,
      gained: p.gained, gainedCount: p.gainedCount, lost: p.lost, lostCount: p.lostCount,
      ...(links === true ? { fileShares: 'removed' as const } : links === false ? { fileShares: 'kept' as const } : {}),
    }
    return {
      op: p.action === 'remove' ? 'stop' : 'share', outcome, files: [], level: 'view',
      who: [{ subjectType: s.subjectType, subjectId: s.subjectId, name: plainLabel(s.name, 200), ...(s.subjectType === 'group' && s.people !== undefined ? { members: s.people } : {}) }],
      ...(refusal0 ? { refusal: { reason: refusal0.reason } } : {}),
      teamFolder: tf,
    }
  }
}

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
/** The cards of one answer (per turn exec): how many folder access cards it showed, whether one was declined, whether
 * one is open now. */
const cardStates = new WeakMap<object, { shown: number; declined: boolean; open: boolean }>()
function cardStateOf(exec: object) {
  let s = cardStates.get(exec)
  if (!s) cardStates.set(exec, s = { shown: 0, declined: false, open: false })
  return s
}
