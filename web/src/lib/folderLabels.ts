// The team's top folders in words on screen (docs/DECISIONS.md "Team folder basics"; the table is shared with the AI's
// instructions: shared/src/folder-labels.ts). Only what is shown changes: links, API calls, drag and drop and tooltips
// that show a path keep the disk path.
import { folderLabel, labeledPath, TOP_FOLDER_LABELS, TOP_FOLDERS } from '@mycel/shared'
import { useLocale, useT } from '../i18n'
import { useMe } from '../store/session'

export interface FolderWords {
  /** a folder row or breadcrumb: its label (전사 공유, 부서, 내 폴더 …), else `name` */
  name: (path: string, name: string) => string
  /** a whole path: "shared/양식" → "전사 공유/양식" ('' stays '') */
  path: (path: string, sep?: string) => string
  /** a path's breadcrumbs as 파일's list names its places, one name per place: "개인 › 내 파일" is one place (내 파일), so 개인
   * is left out before the person's own folder, and its "projects" (where my own projects keep their folders) is
   * "프로젝트" as the team's is. Each keeps its disk path. */
  crumbs: (path: string) => { name: string; path: string }[]
}

/** The words for this person (their language, their own folder). */
export function folderWords(locale: Parameters<typeof folderLabel>[1], me: string | null | undefined): FolderWords {
  const own = me ? `users/${me}` : null
  // one folder's words: my own "projects" (where my own projects keep their folders) is 프로젝트, as the team's is
  const label = (p: string) => (own && p === `${own}/projects` ? (TOP_FOLDER_LABELS.projects[locale] ?? TOP_FOLDER_LABELS.projects.en) : folderLabel(p, locale, me))
  const crumbs = (p: string) => {
    if (!p) return []
    const parts = p.split('/')
    return parts
      .map((seg, i) => {
        const at = parts.slice(0, i + 1).join('/')
        return { name: label(at) ?? seg, path: at }
      })
      .filter((c) => !(own && c.path === 'users' && (p === own || p.startsWith(`${own}/`))))
  }
  return {
    name: (p, name) => label(p) ?? name,
    // the person's own folder and its projects in words; any other path as the shared table says it
    path: (p, sep = '/') => (own && (p === own || p.startsWith(`${own}/`)) ? crumbs(p).map((c) => c.name).join(sep) : labeledPath(p, locale, me, sep)),
    crumbs,
  }
}

export function useFolderWords(): FolderWords {
  const locale = useLocale()
  const me = useMe()?.user.id
  return folderWords(locale, me)
}

/** A folder's own name in these words ("Company-wide", "Quotes"), never a path; the team root is the team folder. */
export function useFolderName(): (path: string) => string {
  const words = useFolderWords()
  const t = useT()
  return (p) => (p === '' ? t('files.root') : words.name(p, p.slice(p.lastIndexOf('/') + 1)))
}

/**
 * The team root's rows in a fixed order (docs/DECISIONS.md "Team folder basics"): 전사 공유, 부서, 프로젝트, 팀 스킬, 개인
 * (shared/, groups/, projects/, skills/, users/: TOP_FOLDERS), then everything else in the order it came (the server's:
 * folders first, by name). Only at the root (`at` ''): a deeper folder keeps that order. Display only: paths, the API's
 * order and its pages stay as they are. A new array; the same one when nothing moves.
 */
export function topFoldersFirst<E extends { path: string; type: string }>(entries: readonly E[], at: string): readonly E[] {
  if (at !== '') return entries
  const rank = (e: E) => (e.type === 'folder' ? (TOP_FOLDERS as readonly string[]).indexOf(e.path) : -1)
  const top = entries.filter((e) => rank(e) >= 0).sort((a, b) => rank(a) - rank(b))
  if (!top.length) return entries
  return [...top, ...entries.filter((e) => rank(e) < 0)]
}
