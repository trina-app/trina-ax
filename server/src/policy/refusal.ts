// One shape for every refusal the AI reads back (docs/DECISIONS.md "Refusals say why, who and what next"). The owner
// (2026-11-10): "왜케 제약이 많아?? 안되는게 왜케 많은거야? 이유도 모르고?" Most limits are real, but the texts said
// neither why nor where the person could do it, and some blamed the person for a card nobody showed them ("the user did
// not allow this" in a scheduled run). Each text says:
//   1. what did not happen ("Nothing was moved.");
//   2. one reason: no permission (and who can grant it), nobody could be asked (a scheduled run), the person said no, the
//      card timed out, other people would have to agree (the room or project), a server limit (the number, when it
//      resets), or not available in this kind of chat;
//   3. one next step, with the screen's name as the person's app shows it (their language);
//   4. the folders, groups, projects and connections involved.
// Rooms and shared chats keep their rule: who cannot read what is counted, never named (DECISIONS "Never who"). "not
// found or no access" stays one answer for both (policy/authorize.ts): only a next step that says nothing about the path
// is added to it (notFoundNext).
// The texts are English (the AI's); only the screen names are in the person's language.
import type { Database } from 'bun:sqlite'
import { PRODUCT_NAMED_AFTER_AI, type Locale } from '@mycel/shared/api'

/** How a server card ended without a yes: the person's no, no answer in time, nobody to ask (a scheduled run: no card
 * was raised), or the answer stopped before anyone answered. */
export type CardEnd = 'declined' | 'timeout' | 'unattended' | 'ended'
/** How a server card ended. */
export type CardOutcome = 'yes' | CardEnd

export type RefusalReason =
  /** the person lacks the permission; `grant`: who can give it (display names), `how`: where they do it */
  | { kind: 'permission'; what?: string; grant?: readonly string[]; how?: string }
  /** nobody could be asked: no card was shown (a scheduled run, or `run`) */
  | { kind: 'unattended'; run?: string }
  /** the person said no on the card (`who`: in a shared chat, the person whose turn it is) */
  | { kind: 'declined'; who?: string }
  /** the card got no answer in time */
  | { kind: 'timeout'; who?: string }
  /** the answer stopped before the card was answered */
  | { kind: 'ended' }
  /** other people would have to agree: `where` names the room or project; `count`: how many (never who) */
  | { kind: 'others'; where: string; count?: number; what?: string }
  /** a server limit: `limit` with its number, `resets` when it resets, `setBy` who can change it */
  | { kind: 'limit'; limit: string; resets?: string; setBy?: string }
  /** not available in this kind of chat (`mode`: "a team chat room"), and why */
  | { kind: 'mode'; mode: string; why?: string }
  /** a check could not be completed: stopped to be safe, nobody refused it */
  | { kind: 'failed'; what?: string }

export interface Refusal {
  /** what did not happen: "Nothing was moved." */
  done: string
  why: RefusalReason
  /** one next step the person can take ("the user can do it on the Files screen (…)"); none when there is nothing */
  next?: string | null
  /** folders, groups, projects, connections involved (never who cannot read what in a room or a shared chat) */
  names?: readonly string[]
  /** one more instruction for the AI ("Do not try another folder.") */
  also?: string
}

const stop = (s: string) => (/[.!?)]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

/** "A, B and C" (at most `max` names, then "and N more") */
export function nameList(names: readonly string[], max = 3): string {
  const n = [...new Set(names.filter(Boolean))]
  if (n.length <= 1) return n[0] ?? ''
  const shown = n.slice(0, max)
  const rest = n.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** The reason as one sentence (no "Why:" in front). */
export function reasonText(r: RefusalReason): string {
  switch (r.kind) {
    case 'permission': {
      const grant = r.grant?.length ? `; ${nameList(r.grant)} can give it${r.how ? ` (${r.how})` : ''}` : r.how ? `; ${r.how}` : ''
      return `the user does not have permission for this${r.what ? ` (${r.what})` : ''}${grant}`
    }
    case 'unattended':
      return `nobody could be asked: this is ${r.run ?? 'a scheduled run'} with nobody watching, so no confirmation card was shown and nobody can confirm it here. The user did not refuse anything; never say they did`
    case 'declined':
      return `${r.who ?? 'the user'} did not allow it: they said no on the confirmation card`
    case 'timeout':
      return `${r.who ?? 'the user'} did not answer the confirmation card in time, so it closed without a yes. This is not a no; never say they refused`
    case 'ended':
      return 'the answer stopped before the confirmation card was answered'
    case 'others':
      return `other people would have to agree: ${r.where}${r.count !== undefined ? ` (${r.count} ${r.count === 1 ? 'person' : 'people'})` : ''}${r.what ? `, ${r.what}` : ''}`
    case 'limit':
      return `a limit of this server: ${r.limit}${r.resets ? `; it resets ${r.resets}` : ''}${r.setBy ? `; ${r.setBy} can change it` : ''}`
    case 'mode':
      return `not available in ${r.mode}${r.why ? `: ${r.why}` : ''}`
    case 'failed':
      return `the server could not complete its check${r.what ? ` (${r.what})` : ''}, so it stopped to be safe. Nobody refused it`
  }
}

/** The text the AI reads back after a refusal: what did not happen, why, the next step, the names involved. */
export function refusal(r: Refusal): string {
  return [
    stop(r.done),
    `Why: ${stop(reasonText(r.why))}`,
    r.also ? stop(r.also) : '',
    r.next ? `Next step: ${stop(r.next)}` : '',
    r.names?.length ? `Involved: ${[...new Set(r.names)].join(', ')}.` : '',
  ].filter(Boolean).join(' ')
}

/** The reason for a card that ended without a yes. `who`: who was asked (a shared chat names its asker); `run`: how an
 * unattended run is named. */
export function cardReason(end: CardEnd, o: { who?: string; run?: string } = {}): RefusalReason {
  switch (end) {
    case 'declined': return { kind: 'declined', ...(o.who ? { who: o.who } : {}) }
    case 'timeout': return { kind: 'timeout', ...(o.who ? { who: o.who } : {}) }
    case 'unattended': return { kind: 'unattended', ...(o.run ? { run: o.run } : {}) }
    case 'ended': return { kind: 'ended' }
  }
}

/** A short form for audit summaries: "not allowed by the user", "no answer in time", "nobody to ask", … */
export function cardEndShort(end: CardEnd): string {
  return end === 'declined' ? 'not allowed by the user' : end === 'timeout' ? 'no answer in time' : end === 'unattended' ? 'nobody to ask (scheduled run)' : 'the answer stopped'
}

/** The next step for a card that ended without a yes: ask again (a no or no answer), or do it in a chat (nobody to ask). */
export function cardNext(end: CardEnd, where = 'in a chat'): string {
  return end === 'unattended' ? `the user can ask for it ${where}, where they can answer the card` : end === 'declined'
    ? 'ask the user what they want instead; do not try another way that needs the same yes'
    : 'the user can ask again and answer the card'
}

// ---------------- screen names, as the person's app shows them ----------------
type L5 = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): L5 => ({ ko, en, id, ja, es })
// the web app's own labels (web/src/i18n: sidebar.files, files.trash, sidebar.skills, sidebar.scheduled,
// sidebar.settings, admin.title, admin.folders, admin.groups, admin.members, admin.plugins, rooms.title,
// chat.shareToRoom, sideChat.open)
const LABEL = {
  files: t('파일', 'Files', 'File', 'ファイル', 'Archivos'),
  trash: t('휴지통', 'Trash', 'Sampah', 'ゴミ箱', 'Papelera'),
  skills: t('팀 스킬', 'Team skills', 'Skill tim', 'チームスキル', 'Habilidades del equipo'),
  scheduled: t('예약 작업', 'Scheduled', 'Terjadwal', '定期タスク', 'Programadas'),
  settings: t('설정', 'Settings', 'Pengaturan', '設定', 'Configuración'),
  admin: t('관리자', 'Admin', 'Admin', '管理', 'Administración'),
  folders: t('폴더 권한', 'Folder permissions', 'Izin folder', 'フォルダーの権限', 'Permisos de carpetas'),
  groups: t('부서', 'Groups', 'Grup', 'グループ', 'Grupos'),
  members: t('멤버·초대', 'Members & invites', 'Anggota & undangan', 'メンバーと招待', 'Miembros e invitaciones'),
  plugins: t('플러그인', 'Plugins', 'Plugin', 'プラグイン', 'Complementos'),
  projects: t('프로젝트', 'Projects', 'Proyek', 'プロジェクト', 'Proyectos'),
  rooms: t('대화', 'Conversations', 'Percakapan', 'トーク', 'Conversaciones'),
  shareToRoom: t('대화방에 보내기', 'Send to a chat room', 'Kirim ke ruang obrolan', 'トークルームに送る', 'Enviar a una sala de chat'),
  sideChat: t('✦ {name}에게 따로 묻기', '✦ Ask {name} privately', '✦ Tanya {name} secara pribadi', '✦ {name}に個別に質問', '✦ Preguntar a {name} en privado'),
} satisfies Record<string, L5>
// the AI's name in the side panel's button (web sideChat.open {name}; chat/i18n.ts aiCalled)
const AI_NAME = PRODUCT_NAMED_AFTER_AI ? t('트리나', 'Trina', 'Trina', 'トリナ', 'Trina') : t('AI', 'AI', 'AI', 'AI', 'IA')

/** Where a person does something themselves, by the names their app shows (`L`). */
export const SCREEN = {
  files: (L: Locale) => `the Files screen ("${LABEL.files[L]}")`,
  trash: (L: Locale) => `the Files screen's trash ("${LABEL.files[L]} › ${LABEL.trash[L]}")`,
  newFolder: (L: Locale) => `the Files screen ("${LABEL.files[L]}")`,
  skills: (L: Locale) => `the Team skills page ("${LABEL.skills[L]}")`,
  scheduled: (L: Locale) => `the Scheduled page ("${LABEL.scheduled[L]}")`,
  settingsMcp: (L: Locale) => `Settings › MCP ("${LABEL.settings[L]} › MCP")`,
  adminMcp: (L: Locale) => `Admin › MCP ("${LABEL.admin[L]} › MCP")`,
  adminFolders: (L: Locale) => `Admin › Folder permissions ("${LABEL.admin[L]} › ${LABEL.folders[L]}")`,
  adminGroups: (L: Locale) => `Admin › Groups ("${LABEL.admin[L]} › ${LABEL.groups[L]}")`,
  adminPlugins: (L: Locale) => `Admin › Plugins ("${LABEL.admin[L]} › ${LABEL.plugins[L]}")`,
  adminSettings: (L: Locale) => `Admin ("${LABEL.admin[L]}")`,
  projects: (L: Locale) => `the project's settings ("${LABEL.projects[L]}")`,
  rooms: (L: Locale) => `Conversations ("${LABEL.rooms[L]}")`,
  shareToRoom: (L: Locale) => `the "${LABEL.shareToRoom[L]}" button under an answer`,
  sideChat: (L: Locale) => `the room's side panel ("${LABEL.sideChat[L].replace('{name}', AI_NAME[L])}")`,
  ownChat: (_L: Locale) => 'a chat of their own (a new AI chat)',
} as const satisfies Record<string, (L: Locale) => string>

// ---------------- who can give access ----------------
/** Active owners and admins, by display name (owner first). */
export function adminNames(db: Database): string[] {
  return (db.query("SELECT name FROM users WHERE role IN ('owner', 'admin') AND status = 'active' AND deleted_at IS NULL ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, name, id").all() as { name: string }[])
    .map((r) => oneLine(r.name)).filter(Boolean)
}

/**
 * Who can give write access at `rel` (a path the person can already see, read-only for them): a team project's folder
 * by its creator (who chooses the project's people) and the admins; any other folder by the admins (Admin › Folder
 * permissions, or Admin › Groups for a group's folder). Never asked for a path the person cannot see.
 */
export function writeGranters(db: Database, rel: string, L: Locale): { names: string[]; how: string } {
  const admins = adminNames(db)
  const segs = rel.split('/').filter(Boolean)
  const top = segs[0]?.normalize('NFC').toLowerCase()
  if (top === 'projects' && segs.length >= 2) {
    const folder = segs.slice(0, 2).join('/')
    const p = db.query("SELECT p.name, u.name AS creator FROM projects p LEFT JOIN users u ON u.id = p.created_by AND u.status = 'active' AND u.deleted_at IS NULL WHERE p.trashed_with IS NULL AND p.folder_path = ? COLLATE NOCASE LIMIT 1").get(folder) as { name: string; creator: string | null } | null
    if (p) return { names: [...(p.creator ? [oneLine(p.creator)] : []), ...admins], how: `${p.creator ? 'the project\'s creator adds people to the project, ' : ''}an admin in ${SCREEN.adminFolders(L)}` }
  }
  if (top === 'groups' && segs.length >= 2) return { names: admins, how: `an admin adds them to the group in ${SCREEN.adminGroups(L)} or changes ${SCREEN.adminFolders(L)}` }
  return { names: admins, how: `an admin in ${SCREEN.adminFolders(L)}` }
}

/** The next step after "not found or no access": the same for a missing file and a hidden one (it names nothing about
 * the path). */
export function notFoundNext(): string {
  return 'if it should be there, check the name and folder with the user (list the folder they mean); if it still is not found, whoever manages that folder or an admin can check whether the user should have access'
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/[<>]/g, ' ').trim().slice(0, 80)

/**
 * B2: after a "read-only" refusal (policy/authorize.ts), who can give write access there and what the person can do
 * now. Only for a read-only path (the person can see it, so naming its project's creator says nothing new); null for
 * any other text (never for "not found or no access").
 */
export function readOnlyNote(db: Database, text: string, L: Locale, userId: string): string | null {
  const m = /read-only(?: folder)?: you cannot (?:change|create files in) '([^']*)'/.exec(text)
  if (!m || text.includes(`Write access to '${m[1]}'`)) return null
  const g = writeGranters(db, m[1]!, L)
  return `Write access to '${m[1]}': ${g.names.length ? `${nameList(g.names)} can give it (${g.how})` : g.how}. Next step: tell the user so; they also get a button under your answer to save it in their own folder (users/${userId}), and you may save it there if they ask.`
}

/** B7: the per-answer write limits (files/service.ts limits, tools/make-file.ts), with their numbers and what to do. */
export function writeLimitText(kind: 'bytes' | 'files', max: number, path: string): string {
  const limit = kind === 'bytes' ? `at most ${Math.round(max / 1048576)} MB written in one answer` : `at most ${max} files written in one answer`
  return refusal({
    done: `Not saved: '${path}'.`,
    why: { kind: 'limit', limit, resets: 'with the user\'s next message' },
    next: 'stop saving in this answer, say what was saved and what is left, and ask the user to say "continue" in the next message to save the rest',
  })
}

/** How the card behind a refusal text ended (for an audit summary written where only the text is at hand): the
 * reason line refusal() wrote, else the person's no. 'failed': a check that could not be completed. */
export function endOfText(text: string): CardEnd | 'failed' {
  if (text.includes('Why: nobody could be asked')) return 'unattended'
  if (/Why: .{0,120}did not answer the confirmation card in time/.test(text)) return 'timeout'
  if (text.includes('Why: the answer stopped before')) return 'ended'
  if (text.includes('Why: the server could not complete its check')) return 'failed'
  return 'declined'
}
