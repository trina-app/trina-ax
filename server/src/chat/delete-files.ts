// delete_files (docs/DECISIONS.md "AI가 휴지통으로 옮기기"): the AI moves files and folders to the team trash, exactly as
// the Files screen's delete does (TeamFiles.remove, never FileService.deleteFile), after the person's yes on the
// server's own card. Only in the person's own chat with the person there: refused up front, before any card, in a
// scheduled run, an approved template run, a room, a shared project chat, a chat other people wrote in or one that has
// read rooms (chat/read-rooms.ts: a room read, a side chat, a quoted message) or a Slack thread, a confidential chat, a
// draft or judge chat, and for a sub-agent. The card shows
// exactly what goes: every path in full, the files in each folder, the other people whose files these are (as the file
// history names them), how many people lose them and how many of those cannot restore them, and the purge date of the
// team's trash setting. The yes is bound to the plan (TeamFiles.planAiTrash: every entry on disk, who reads and writes
// it, the trash setting), checked again around the move itself. No earlier answer, room grant or "always allow" covers
// it; at most two such cards per answer, none after a "no", one card open at a time. One audit row per call.
import { DeleteFilesInput, uuidv7 } from '@mycel/shared'
import type { Locale, TurnRequest } from '@mycel/shared/api'
import { fillPlurals } from '@mycel/shared/plural'
import { z } from 'zod'
import { audit } from '../admin/audit'
import { teamTimeZone } from '../admin/settings'
import { ToolError } from '../policy/errors'
import { confidentialChat } from '../safe-ops/confidential'
import { componentC } from '../team-files/component'
import type { AiTrashPlan } from '../team-files/service'
import { neutralizeTags } from './prompt'
import { readRooms } from './read-rooms'
import type { Tool } from './tools'
import type { TurnExec } from './turn'

export const DELETE_FILES_TOOL = 'delete_files'
/** delete cards one answer may show (card fatigue: a third ask is a new message) */
export const MAX_DELETE_CARDS = 2

export const DELETE_FILES_DESCRIPTION = 'Move files or folders of the team drive to the team trash, only when the user asked you to delete them. ' +
  'Give their full paths. The user confirms on a card that lists every item, how many files each folder holds, whose files they are, ' +
  'who loses them and until when they can be restored. Nothing is deleted for good: the trash keeps them for the team\'s set number of days. ' +
  'Not for top-level folders, group, project or rule folders, skill folders, other people\'s folders or chat attachments; at most 200 files and folders per call, counted inside folders.'

const t = (ko: string, en: string, id: string, ja: string, es: string): Record<Locale, string> => ({ ko, en, id, ja, es })
export const DELETE_TEXT = {
  ask: t('AI가 {n}개 항목을 휴지통으로 옮기려고 해요.', 'The AI wants to move {n, plural, one {# item} other {# items}} to the trash.', 'AI ingin memindahkan {n} item ke tempat sampah.', 'AIが{n}個の項目をゴミ箱に移動しようとしています。', 'La IA quiere mover {n, plural, one {# elemento} other {# elementos}} a la papelera.'),
  inside: t('폴더 안까지 모두 파일 {files}개예요.', 'With what is inside the folders, that is {files, plural, one {# file} other {# files}}.', 'Termasuk isi folder, totalnya {files} berkas.', 'フォルダーの中身を含めて、ファイルは全部で{files}個です。', 'Con el contenido de las carpetas, son {files, plural, one {# archivo} other {# archivos}}.'),
  others: t('다른 사람이 만들거나 고친 파일도 들어 있어요: {names}.', 'It includes files made or changed by {names}.', 'Termasuk berkas yang dibuat atau diubah oleh {names}.', 'ほかの人が作成・変更したファイルも含まれます: {names}。', 'Incluye archivos creados o cambiados por {names}.'),
  lost: t('지금 볼 수 있는 다른 {n}명이 더 이상 볼 수 없어요.', '{n, plural, one {# other person} other {# other people}} who can see {count, plural, one {it} other {them}} now will no longer be able to.', '{n} orang lain yang kini bisa melihatnya tidak akan bisa lagi.', '{count, plural, one {この項目} other {これらの項目}}を現在閲覧できるほかの{n}人が閲覧できなくなります。', '{n, plural, one {# otra persona que ahora puede} other {# otras personas que ahora pueden}} {count, plural, one {verlo} other {verlos}} {n, plural, one {dejará} other {dejarán}} de tener acceso.'),
  noRestore: t('그중 {n}명은 쓰기 권한이 없어 휴지통에서도 볼 수 없고 되살릴 수 없어요.', '{n, plural, one {# of them has} other {# of them have}} no write access, so cannot see {count, plural, one {it} other {them}} in the trash or restore {count, plural, one {it} other {them}}.', '{n} di antaranya tidak punya akses tulis, jadi tidak bisa melihatnya di tempat sampah atau memulihkannya.', 'そのうち{n}人は書き込み権限がないため、ゴミ箱でも{count, plural, one {この項目} other {これらの項目}}を閲覧・復元できません。', '{n, plural, one {# de ellas no tiene} other {# de ellas no tienen}} permiso de escritura, así que no {n, plural, one {puede} other {pueden}} {count, plural, one {verlo} other {verlos}} en la papelera ni {count, plural, one {restaurarlo} other {restaurarlos}}.'),
  until: t('{date}까지 휴지통에서 되살릴 수 있어요. 관리자는 그 전에 휴지통을 비울 수 있어요.', 'It can be restored from the trash until {date}. An admin can empty the trash before then.', 'Bisa dipulihkan dari tempat sampah sampai {date}. Admin bisa mengosongkan tempat sampah sebelum itu.', '{date}までゴミ箱から復元できます。管理者はそれより前にゴミ箱を空にできます。', 'Se puede restaurar desde la papelera hasta el {date}. Un administrador puede vaciar la papelera antes.'),
  confirm: t('휴지통으로 옮길까요?', '{count, plural, one {Move it to the trash?} other {Move them to the trash?}}', 'Pindahkan ke tempat sampah?', '{count, plural, one {ゴミ箱に移動しますか？} other {ゴミ箱に移動しますか？}}', '{count, plural, one {¿Moverlo a la papelera?} other {¿Moverlos a la papelera?}}'),
  items: t('휴지통으로 옮길 항목', 'Items to move to the trash', 'Item yang dipindahkan ke tempat sampah', 'ゴミ箱に移動する項目', 'Elementos que irán a la papelera'),
  files: t('파일 {n}개', '{n, plural, one {# file} other {# files}}', '{n} berkas', 'ファイル{n}個', '{n, plural, one {# archivo} other {# archivos}}'),
  folders: t('폴더 {n}개', '{n, plural, one {# folder} other {# folders}}', '{n} folder', 'フォルダー{n}個', '{n, plural, one {# carpeta} other {# carpetas}}'),
  othersLabel: t('만들거나 고친 다른 사람', 'Made or changed by others', 'Dibuat atau diubah orang lain', '作成・変更したほかの人', 'Creado o cambiado por otras personas'),
  yes: t('휴지통으로 옮기기', 'Move to trash', 'Pindahkan ke tempat sampah', 'ゴミ箱に移動', 'Mover a la papelera'),
  no: t('하지 않기', 'Don’t', 'Jangan', '実行しない', 'No hacerlo'),
  /** where the person restores it (web/src/i18n files.title › files.trash) */
  where: t('파일 › 휴지통', 'Files › Trash', 'File › Sampah', 'ファイル › ゴミ箱', 'Archivos › Papelera'),
}
const fill = (s: string, v: Record<string, string | number>, L: Locale) => fillPlurals(s, v, L).replace(/\{(\w+)\}/g, (_, k) => String(v[k]))
const DAY = 86_400_000

/** The refusals, with what did not happen, why, and what the person can do instead (English: the AI tells the person). */
const NONE = 'Nothing was moved to the trash'
const SCREEN = 'they can delete it themselves on the Files screen (it goes to the trash there too)'
export const DELETE_REFUSAL = {
  scheduled: `${NONE}: a scheduled run has nobody to confirm the delete card. Tell the user ${SCREEN}, or to ask in a chat, where they confirm on a card.`,
  template: `${NONE}: an approved scheduled template only reads its folder and writes reports. Tell the user ${SCREEN}.`,
  room: `${NONE}: the AI does not delete files in a team chat room (other people's messages are there). Tell the user to ask in their own AI chat, or that ${SCREEN}.`,
  shared: `${NONE}: the AI does not delete files in a shared project chat (everyone in the project writes and reads it). Tell the user to ask in their own AI chat, or that ${SCREEN}.`,
  others: `${NONE}: other people's messages are in this chat, and one of them could ask for the delete. Tell the user to ask in a new chat of their own, or that ${SCREEN}.`,
  roomsSeen: `${NONE}: this chat holds messages from the user's team chat rooms or quotes another person's message (other people's words), and one of them could ask for the delete. Tell the user to ask in a new chat, or that ${SCREEN}.`,
  slack: `${NONE}: the AI does not delete files in a chat asked from Slack. Tell the user to ask in the app's AI chat, or that ${SCREEN}.`,
  confidential: `${NONE}: the AI does not delete files in a confidential chat. Tell the user ${SCREEN}.`,
  restricted: `${NONE}: this chat has no file tools.`,
  subagent: `${NONE}: only the main assistant deletes, after the user confirms on a card. Put what should be deleted in your report; the assistant asks the user.`,
  declined: `${NONE}: the user said no to a delete earlier in this answer, so no more deletes are asked in it. Do not delete these another way (no move into another folder, no overwrite with empty content); ask the user what they want.`,
  tooMany: `${NONE}: at most ${MAX_DELETE_CARDS} delete cards are asked in one answer. Tell the user what is left to delete; they can ask again in a new message, or ${SCREEN}.`,
  busy: `${NONE}: another card is waiting for the user's answer, and a delete card is asked only when nothing else is open. Wait for that answer, then ask again with one call.`,
} as const
export type DeleteRefusal = keyof typeof DELETE_REFUSAL

/** What delete_files needs of the chat turn (chat/turn.ts TurnExec): narrow, so the rules here are tested on their own. */
export type DeleteExec = Pick<TurnExec, 'spec' | 'room' | 'shared' | 'restricted' | 'templateRun' | 'roomsSeen' | 'otherAuthors' | 'fromSlack' | 'files' | 'rt' | 'waitForPerson' | 'openRequests' | 'livePrincipal'>

/** Why delete_files is refused in this turn whatever is asked, or null: only the person's own chat, with them there. */
export function deleteFilesRefusal(exec: Pick<DeleteExec, 'spec' | 'room' | 'shared' | 'restricted' | 'templateRun' | 'roomsSeen' | 'otherAuthors' | 'fromSlack' | 'rt'>): DeleteRefusal | null {
  if (exec.restricted) return 'restricted'
  if (exec.templateRun) return 'template'
  if (exec.spec.clientKind === 'schedule') return 'scheduled'
  if (exec.room) return 'room'
  if (exec.shared) return 'shared'
  if (confidentialChat(exec.rt.db, exec.spec.chatId)) return 'confidential'
  if (exec.otherAuthors) return 'others'
  if (exec.fromSlack) return 'slack'
  // has read rooms: a room read, a ✦ side chat, or another person's message quoted on this branch (chat/read-rooms.ts)
  if (readRooms(exec)) return 'roomsSeen'
  return null
}

/** The cards of one answer: how many delete cards it showed, whether one was declined, whether one is open now. */
interface CardState { shown: number; declined: boolean; open: boolean }
const cardStates = new WeakMap<object, CardState>()

const schema = (s: z.ZodType) => { const j = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j }
const result = (text: string, summary: string, isError = true) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}), summary: `${DELETE_FILES_TOOL} -> ${summary}` })

/** The card: what goes (every path in full, what each folder holds), whose files they are, who loses them, until when. */
export function deleteCard(plan: AiTrashPlan, L: Locale, timeZone: string, now = Date.now()): { question: string; details: { label: string; text: string; collapsedAt?: number }[] } {
  const count = plan.items.length
  const files = plan.items.reduce((n, i) => n + (i.kind === 'folder' ? i.files : 1), 0)
  const date = new Intl.DateTimeFormat(L, { dateStyle: 'long', timeZone }).format(new Date(now + plan.retentionDays * DAY))
  const folders = plan.items.some((i) => i.kind === 'folder')
  const question = [
    fill(DELETE_TEXT.ask[L], { n: count }, L),
    folders ? fill(DELETE_TEXT.inside[L], { files }, L) : '',
    plan.others.length ? fill(DELETE_TEXT.others[L], { names: plan.others.map((o) => o.name).join(', ') }, L) : '',
    plan.lost ? fill(DELETE_TEXT.lost[L], { n: plan.lost, count }, L) : '',
    plan.noRestore ? fill(DELETE_TEXT.noRestore[L], { n: plan.noRestore, count }, L) : '',
    fill(DELETE_TEXT.until[L], { date }, L),
    fill(DELETE_TEXT.confirm[L], { count }, L),
  ].filter(Boolean).join(' ')
  const line = (i: AiTrashPlan['items'][number]) => i.kind === 'file' ? i.rel
    : `${i.rel}/ (${[fill(DELETE_TEXT.files[L], { n: i.files }, L), i.folders ? fill(DELETE_TEXT.folders[L], { n: i.folders }, L) : ''].filter(Boolean).join(', ')})`
  const list = plan.items.map(line).join('\n')
  return {
    question,
    details: [
      // never folded: the AI picks the order, so nothing it lists may sit behind "전체 보기"
      { label: DELETE_TEXT.items[L], text: list },
      ...(plan.others.length ? [{ label: DELETE_TEXT.othersLabel[L], text: plan.others.map((o) => o.name).join('\n') }] : []),
    ],
  }
}

export function deleteFilesTool(exec: DeleteExec): Tool {
  const { rt, spec } = exec
  const state = (): CardState => { let s = cardStates.get(exec); if (!s) cardStates.set(exec, s = { shown: 0, declined: false, open: false }); return s }
  // one audit row per call, whatever ends it
  type Audit = (detail: Record<string, unknown>, target: string | null) => void
  const auditor = (): Audit => {
    let written = false
    return (detail, target) => {
      if (written) return
      written = true
      try { audit(rt.db, { actor: spec.userId, action: 'files.ai_trash', target, detail: { turnId: spec.turnId, chatId: spec.chatId, ...detail } }) }
      catch (e) { rt.log.warn('delete_files audit row failed', { err: e, turn: spec.turnId }) }
    }
  }
  const refusedBy = (auditCall: Audit, why: DeleteRefusal, paths: string[]) => {
    auditCall({ outcome: 'refused', reason: why, paths: paths.slice(0, 50), requestId: null, trashIds: [] }, paths[0] ?? null)
    return result(DELETE_REFUSAL[why], `refused: ${why}`)
  }
  return {
    name: DELETE_FILES_TOOL,
    description: DELETE_FILES_DESCRIPTION,
    inputSchema: schema(DeleteFilesInput),
    // before any other check or card of the turn (chat/tools.ts call): nobody to ask, or not the person's own chat
    refuse(args) {
      const why = deleteFilesRefusal(exec)
      if (!why) return null
      const a = DeleteFilesInput.safeParse(args)
      const r = refusedBy(auditor(), why, a.success ? a.data.paths : [])
      return { text: r.content[0]!.text, summary: r.summary }
    },
    async call(args, files) {
      const auditCall = auditor()
      try { return await run(args, files, auditCall) } catch (e) {
        rt.log.warn('delete_files failed', { err: e, turn: spec.turnId })
        auditCall({ outcome: 'failed', reason: 'error', requestId: null, trashIds: [] }, null)
        return result(`${NONE}: internal error.`, 'failed')
      }
    },
  }

  async function run(args: unknown, files: unknown, auditCall: Audit) {
    const refused = (why: DeleteRefusal, paths: string[]) => refusedBy(auditCall, why, paths)
    const a = DeleteFilesInput.safeParse(args)
    if (!a.success) {
      auditCall({ outcome: 'refused', reason: 'invalid_input', paths: [], requestId: null, trashIds: [] }, null)
      return result('Invalid input: ' + a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'invalid input')
    }
    const paths = a.data.paths
    // the main AI only (subagents.ts PARENT_ONLY_TOOLS): a sub-agent's call comes with its own turn state
    if (files !== exec.files) return refused('subagent', paths)
    const mode = deleteFilesRefusal(exec)
    if (mode) return refused(mode, paths)
    const s = state()
    if (s.declined) return refused('declined', paths)
    if (s.shown >= MAX_DELETE_CARDS) return refused('tooMany', paths)
    if (s.open || exec.openRequests().length) return refused('busy', paths)
    let user
    try { user = exec.livePrincipal() } catch {
      auditCall({ outcome: 'refused', reason: 'account_disabled', paths: paths.slice(0, 50), requestId: null, trashIds: [] }, paths[0] ?? null)
      return result('Access denied: this account is disabled.', 'denied: account disabled')
    }
    const svc = componentC(rt.ctx).files
    let planned
    try { planned = svc.planAiTrash(user.id, paths) } catch (e) {
      const text = e instanceof ToolError ? e.message : 'internal error'
      auditCall({ outcome: 'refused', reason: e instanceof ToolError && e.code === 'too_many' ? 'too_many' : 'error', paths: paths.slice(0, 50), requestId: null, trashIds: [] }, paths[0] ?? null)
      return result(`${NONE}: ${text}.`, e instanceof ToolError && e.code === 'too_many' ? 'refused: more than 200 entries' : 'failed')
    }
    if ('refused' in planned) {
      auditCall({ outcome: 'refused', reason: 'paths', paths: paths.slice(0, 50), refused: planned.refused.slice(0, 50), requestId: null, trashIds: [] }, paths[0] ?? null)
      const lines = planned.refused.map((r) => `- ${neutralizeTags(r.path)}: ${neutralizeTags(r.error)}`).join('\n')
      return result(`${NONE}, and nobody was asked: a delete runs only exactly as asked, and these paths cannot go to the trash from a chat:\n${lines}\nCall delete_files again without them if the user still wants the rest deleted.`, `refused: ${planned.refused.length} path(s)`)
    }
    const plan = planned.plan
    const L = spec.locale
    const card = deleteCard(plan, L, teamTimeZone(rt.db))
    const requestId = uuidv7()
    // counted and marked open before the card goes out: a second call while it waits is refused (busy), not queued
    s.shown++
    s.open = true
    let answer: unknown
    try {
      answer = await exec.waitForPerson({
        kind: 'ask_user', origin: 'server', requestId, question: card.question, multiple: false, allowText: false,
        options: [{ label: DELETE_TEXT.yes[L], value: 'trash' }, { label: DELETE_TEXT.no[L], value: 'skip' }],
        details: card.details,
        expiresAt: new Date(Date.now() + rt.askUserTimeoutMs()).toISOString(),
      } as TurnRequest, { timeoutMs: rt.askUserTimeoutMs(), exclusive: true })
    } finally { s.open = false }
    const picked = Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
    const base = { paths: plan.items.map((i) => i.rel), entries: plan.entries, lost: plan.lost, noRestore: plan.noRestore, retentionDays: plan.retentionDays, others: plan.others.length, requestId }
    const target = plan.items[0]!.rel
    if (picked !== 'trash') {
      // "no", or no answer (closed, timed out, the answer stopped): no more delete cards in this answer
      s.declined = true
      auditCall({ ...base, outcome: picked === null || picked === undefined ? 'no_answer' : 'declined', trashIds: [] }, target)
      return result(`The user did not allow this, so ${NONE.charAt(0).toLowerCase()}${NONE.slice(1)}. Do not delete or hide these another way (no move into another folder, no overwrite with empty content), and ask no other delete in this answer; ask the user what they want.`, 'not allowed by the user')
    }
    // everything again, then the moves, in one synchronous block (TeamFiles.trashAiPlan)
    let done
    try { done = svc.trashAiPlan(user.id, plan, spec.turnId) } catch (e) {
      auditCall({ ...base, outcome: 'failed', trashIds: [] }, target)
      return result(`${NONE}: ${e instanceof ToolError ? e.message : 'internal error'}.`, 'failed')
    }
    const trashIds = done.trashed.map((x) => x.trashId)
    const moved = done.trashed.length + done.stranded.length
    // nothing moved: `changed` only when an item changed after the card; when every item failed otherwise, `failed`
    const outcome = moved === plan.items.length && !done.stranded.length ? 'trashed' : moved ? 'partial' : done.changed.length ? 'changed' : 'failed'
    auditCall({ ...base, outcome, trashIds, changed: done.changed, failed: done.failed.map((f) => f.path), keptChanged: done.trashed.filter((x) => x.changed).map((x) => x.path), stranded: done.stranded }, target)
    if (!moved) {
      return result(`${NONE}: ${done.changed.length ? `${done.changed.map(neutralizeTags).join(', ')} changed after the card was shown (a file or folder was added, removed or changed, or who can see it or the trash setting changed). Ask again with one call; the user confirms the current state on a new card` : done.failed.map((f) => `${neutralizeTags(f.path)}: ${neutralizeTags(f.error)}`).join('; ')}.`, done.changed.length ? 'changed after the card' : 'failed')
    }
    const until = done.trashed[0]?.purgeAt.slice(0, 10)
    const text = [
      done.trashed.length ? `Moved to the team trash (${done.trashed.length}):\n${done.trashed.map((x) => `- ${neutralizeTags(x.path)}${x.changed ? ' (it changed while it moved and could not go back: everything in it went to the trash; tell the user to check it there)' : ''}`).join('\n')}` : '',
      until ? `The user can restore each item until ${until} on the Files screen › Trash (in their app: ${DELETE_TEXT.where[L]}); an admin can empty the trash before then. Tell the user what went and how to restore it.` : '',
      // a double fault (TeamFiles.remove): moved, but the trash list could not record it; the server log says where it is
      done.stranded.length ? `Moved out of its place but not listed in the trash (the server could not record it; it is kept in the server's trash storage, and the server log says where): ${done.stranded.map((x) => neutralizeTags(x.path)).join(', ')}. Tell the user it was removed from its folder and that an admin can recover it; it is not in Files › Trash.` : '',
      done.changed.length ? `Not moved, changed after the card was shown (left where it was): ${done.changed.map(neutralizeTags).join(', ')}.` : '',
      done.failed.length ? `Not moved:\n${done.failed.map((f) => `- ${neutralizeTags(f.path)}: ${neutralizeTags(f.error)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
    return { content: [{ type: 'text' as const, text }], summary: `${DELETE_FILES_TOOL} -> ${done.trashed.length}/${plan.items.length} to the trash${done.stranded.length ? `, ${done.stranded.length} out of place without a trash row` : ''} (confirmed by the user, ${plan.entries} entries)` }
  }
}
