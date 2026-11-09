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
  shared: { ko: '전사 공유', en: 'Company-wide', id: 'Seluruh perusahaan', ja: '全社共有', es: 'Toda la empresa' },
  groups: { ko: '부서', en: 'Groups', id: 'Grup', ja: 'グループ', es: 'Grupos' },
  projects: { ko: '프로젝트', en: 'Projects', id: 'Proyek', ja: 'プロジェクト', es: 'Proyectos' },
  skills: { ko: '팀 스킬', en: 'Team skills', id: 'Skill tim', ja: 'チームスキル', es: 'Habilidades del equipo' },
  users: { ko: '개인', en: 'Personal', id: 'Pribadi', ja: '個人', es: 'Personal' },
} as const satisfies Record<TopFolder, T>

/** The person's own folder (users/<their id>/). */
export const OWN_FOLDER_LABEL = { ko: '내 폴더', en: 'My folder', id: 'Folder saya', ja: '自分のフォルダー', es: 'Mi carpeta' } as const satisfies T

/** Forms and templates: shared/<this>/, made for a new team in the team's language (createDefaultFolders). */
export const TEMPLATES_FOLDER = { ko: '양식', en: 'Templates', id: 'Templat', ja: 'テンプレート', es: 'Plantillas' } as const satisfies T

/** Finished work, moved there when the person asks to tidy up: a subfolder of its own area, named in the team's language
 * (a convention the AI's instructions describe; nothing makes it). */
export const ARCHIVE_FOLDER = { ko: '보관', en: 'Archive', id: 'Arsip', ja: 'アーカイブ', es: 'Archivo' } as const satisfies T

const isTop = (s: string): s is TopFolder => (TOP_FOLDERS as readonly string[]).includes(s)

/** One folder's name in words: a top folder's label, the person's own folder (`me`: their id) as "내 폴더", else null
 * (its own name is the name). Only the exact disk names: a folder named "Shared" elsewhere is that folder's name. */
export function folderLabel(path: string, locale: Locale, me?: string | null): string | null {
  if (isTop(path)) return TOP_FOLDER_LABELS[path][locale] ?? TOP_FOLDER_LABELS[path].en
  if (me && path === `users/${me}`) return OWN_FOLDER_LABEL[locale] ?? OWN_FOLDER_LABEL.en
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
