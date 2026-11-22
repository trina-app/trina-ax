// The team's top folders as people read them (docs/DECISIONS.md "Team folder basics"). On disk, in the API and in what
// the AI is given they keep their names (shared/, groups/, projects/, skills/, users/); the screen shows these words,
// and the AI's instructions name them next to each folder so it knows what a person means by "전사 공유" or "부서".
import type { Locale } from './api/common'

type T = Record<Locale, string>

/** The folders every team has at the top of its team folder (admin/folders.ts createDefaultFolders), in the order the
 * instructions describe them. */
export const TOP_FOLDERS = ['shared', 'groups', 'projects', 'skills', 'users'] as const
export type TopFolder = (typeof TOP_FOLDERS)[number]

/** What the screen calls each top folder. `groups` is what each language calls the admin groups (ko: 부서). */
export const TOP_FOLDER_LABELS = {
  shared: { ko: '전사 공유', en: 'Company-wide', id: 'Seluruh perusahaan', ja: '全社共有', es: 'Toda la empresa', zh: '全公司共享' },
  groups: { ko: '부서', en: 'Groups', id: 'Grup', ja: 'グループ', es: 'Grupos', zh: '小组' },
  projects: { ko: '프로젝트', en: 'Projects', id: 'Proyek', ja: 'プロジェクト', es: 'Proyectos', zh: '项目' },
  skills: { ko: '팀 스킬', en: 'Team skills', id: 'Skill tim', ja: 'チームスキル', es: 'Habilidades del equipo', zh: '团队技能' },
  users: { ko: '개인', en: 'Personal', id: 'Pribadi', ja: '個人', es: 'Personal', zh: '个人' },
} as const satisfies Record<TopFolder, T>

/** The person's own folder (users/<their id>/). */
export const OWN_FOLDER_LABEL = { ko: '내 폴더', en: 'My folder', id: 'Folder saya', ja: '自分のフォルダー', es: 'Mi carpeta', zh: '我的文件夹' } as const satisfies T
/** Its name in 파일 (docs/AGENTS/plan/20261112-1839-nav-rail.md decision Q4): "내 파일", so
 * "폴더" is left to the list folders of 트리나 and 대화. */
export const OWN_FILES_LABEL = { ko: '내 파일', en: 'My files', id: 'File saya', ja: '自分のファイル', es: 'Mis archivos', zh: '我的文件' } as const satisfies T

/** Another person's own folder (users/<their id>/) by their name, where others read it (a shared chat's answer): never
 * an English possessive inside another language ("김민지's folder", QA TC-r2a-05). One word, "folder", in every language:
 * it names a place, whatever the person calls their own ("내 파일"). `{name}`: the person's name. */
export const PERSON_FOLDER_LABEL = { en: "{name}'s folder", ko: '{name} 님 폴더', id: 'folder {name}', ja: '{name}さんのフォルダー', es: 'la carpeta de {name}', zh: '{name}的文件夹' } as const satisfies T
/** That folder in words, in this language: "김민지 님 폴더" */
export function personFolderLabel(name: string, locale: Locale): string {
  return (PERSON_FOLDER_LABEL[locale] ?? PERSON_FOLDER_LABEL.en).replace('{name}', () => name)
}

/** Which of the two names the person's own folder has: the server and the web app both set "files" at start
 * (server/src/main.ts, web/src/main.tsx), so the screen and the AI say the same word; "folder" stays the default of this
 * module for the tests that read the older name. */
let ownWord: 'folder' | 'files' = 'folder'
export function setOwnFolderWord(word: 'folder' | 'files') {
  ownWord = word
}
/** which name it has now ('files': "내 파일") */
export const ownFolderWord = (): 'folder' | 'files' => ownWord
/** The person's own folder in words, in this language: "내 파일" (or "내 폴더" while the word is 'folder'). */
export function ownFolderLabel(locale: Locale): string {
  const words = ownWord === 'files' ? OWN_FILES_LABEL : OWN_FOLDER_LABEL
  return words[locale] ?? words.en
}

/** Forms and templates: shared/<this>/, made for a new team in the team's language (createDefaultFolders). */
export const TEMPLATES_FOLDER = { ko: '양식', en: 'Templates', id: 'Templat', ja: 'テンプレート', es: 'Plantillas', zh: '模板' } as const satisfies T

/** Finished work, moved there when the person asks to tidy up: a subfolder of its own area, named in the team's language
 * (a convention the AI's instructions describe; nothing makes it). */
export const ARCHIVE_FOLDER = { ko: '보관', en: 'Archive', id: 'Arsip', ja: 'アーカイブ', es: 'Archivo', zh: '归档' } as const satisfies T

/** Files from the computer attached in a shared project chat: <project folder>/<this>/, made when the first one comes, in
 * the team's language (one under any of these names is used again; server/src/uploads/shared-chat.ts). */
export const CHAT_FILES_FOLDER = { ko: '채팅 첨부', en: 'Chat attachments', id: 'Lampiran obrolan', ja: 'チャット添付', es: 'Adjuntos del chat', zh: '对话附件' } as const satisfies T
const CHAT_FILES_NAMES = new Set<string>(Object.values(CHAT_FILES_FOLDER))
/** One folder name as the screen shows it: a chat attachments folder (named in the team's language when it was made) in
 * this person's language ("Chat attachments" in a Korean screen is "채팅 첨부", QA rerun E); any other name as it is. */
export const chatFilesWord = (name: string, locale: Locale): string => (CHAT_FILES_NAMES.has(name) ? CHAT_FILES_FOLDER[locale] ?? CHAT_FILES_FOLDER.en : name)

/** Find work files on this computer (docs/DECISIONS.md): users/<id>/<this>/, its name on disk in every language, shown in
 * the person's words. One name on disk, so a second run in another language adds to the same folder. */
export const FROM_COMPUTER_DIR = 'From this computer'
export const FROM_COMPUTER_LABEL = { ko: '이 컴퓨터에서', en: 'From this computer', id: 'Dari komputer ini', ja: 'このコンピューターから', es: 'De este ordenador', zh: '来自这台电脑' } as const satisfies T

/** The folder the desktop app's meeting notes saved into: users/<id>/<this>/, one name on disk, shown in the person's
 * words. Meeting notes were removed on 2026-11-19 (docs/decisions/20261119-remove-meeting-notes.md); the notes already
 * saved are the person's files and stay, so their folder keeps its name in the person's language. */
export const MEETINGS_DIR = 'Meetings'
export const MEETINGS_LABEL = { ko: '회의', en: 'Meetings', id: 'Rapat', ja: '会議', es: 'Reuniones', zh: '会议' } as const satisfies T

/** A removed member's whole personal folder is handed to the team owner under users/<owner>/<this>/ (admin/users.ts),
 * named in the team's language when it is made. Nothing at or inside a folder with any of these names is ever shared
 * (server/src/files/share-places.ts). */
export const ARCHIVE_DIR = { ko: '보관된 계정', en: 'Archived accounts', id: 'Akun diarsipkan', ja: 'アーカイブ済みアカウント', es: 'Cuentas archivadas', zh: '已归档账号' } as const satisfies T

const isTop = (s: string): s is TopFolder => (TOP_FOLDERS as readonly string[]).includes(s)

/** One folder's name in words: a top folder's label, the person's own folder (`me`: their id) as "내 파일"
 * (ownFolderLabel), else null
 * (its own name is the name). Only the exact disk names: a folder named "Shared" elsewhere is that folder's name. */
export function folderLabel(path: string, locale: Locale, me?: string | null): string | null {
  if (isTop(path)) return TOP_FOLDER_LABELS[path][locale] ?? TOP_FOLDER_LABELS[path].en
  if (me && path === `users/${me}`) return ownFolderLabel(locale)
  if (me && path === `users/${me}/${FROM_COMPUTER_DIR}`) return FROM_COMPUTER_LABEL[locale] ?? FROM_COMPUTER_LABEL.en
  if (me && path === `users/${me}/${MEETINGS_DIR}`) return MEETINGS_LABEL[locale] ?? MEETINGS_LABEL.en
  return null
}

/** A team path with its top folder (and the person's own folder) in words, the rest as it is:
 * "shared/양식" → "전사 공유/양식", "users/olga/메모.md" → "내 폴더/메모.md" for olga; '' stays ''. `sep` joins the parts. */
export function labeledPath(path: string, locale: Locale, me?: string | null, sep = '/'): string {
  if (!path) return path
  const segs = path.split('/')
  const own = me && segs[0] === 'users' && segs[1] === me ? 2 : 0
  const head = own ? `users/${me}` : segs[0]!
  const word = folderLabel(head, locale, me)
  if (word === null) return segs.join(sep)
  return [word, ...segs.slice(own || 1)].join(sep)
}
