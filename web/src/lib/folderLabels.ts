// The team's top folders in words on screen (docs/DECISIONS.md "Team folder basics"; the table is shared with the AI's
// instructions: shared/src/folder-labels.ts). Only what is shown changes: links, API calls, drag and drop and tooltips
// that show a path keep the disk path.
import { folderLabel, labeledPath } from '@mycel/shared'
import { useLocale } from '../i18n'
import { useMe } from '../store/session'

export interface FolderWords {
  /** a folder row or breadcrumb: its label (전사 공유, 부서, 내 폴더 …), else `name` */
  name: (path: string, name: string) => string
  /** a whole path: "shared/양식" → "전사 공유/양식" ('' stays '') */
  path: (path: string, sep?: string) => string
}

/** The words for this person (their language, their own folder). */
export function folderWords(locale: Parameters<typeof folderLabel>[1], me: string | null | undefined): FolderWords {
  return {
    name: (p, name) => folderLabel(p, locale, me) ?? name,
    path: (p, sep) => labeledPath(p, locale, me, sep),
  }
}

export function useFolderWords(): FolderWords {
  const locale = useLocale()
  const me = useMe()?.user.id
  return folderWords(locale, me)
}
