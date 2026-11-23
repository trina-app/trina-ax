// The folder's pieces of the one Share dialog (FileShareDialog.tsx; folder sharing's web part,
// docs/AGENTS/plan/20261116-1330-folder-share-web.md; the design's "Web" section). A folder in the person's own files is
// shared like a file: pick people or groups, "Can view". What a folder adds, all from the server's answer
// (GET /api/files/shares, kind 'folder'): what it holds and that later files follow; why it can't be shared (blocked);
// Paused with Resume; the line for people who let Trina save wider without asking (wideSavesOn); Stop sharing, which
// names what stays shared on its own (files AND folders inside, design M5) and offers the server's Undo. Plain words, no
// paths: a folder is named by its own name only.
import type { FileShareRow, FileShares, FolderShareBlock, ShareUndoResult } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import type { MessageKey } from '../i18n'
import type { Locale } from '@mycel/shared/api'
import { toast } from '../store/ui'
import { fileSharesChanged } from '../store/live'

type T = (key: MessageKey, params?: Record<string, string | number>) => string

/** "3 files, 1 folder" (an empty folder: "Empty folder"; the count stopped at the cap: "500+ items") */
export function holdsText(t: T, h: NonNullable<FileShares['holds']>): string {
  if (h.more) return t('fileShare.holdsMany', { n: h.files + h.folders })
  if (!h.files && !h.folders) return t('fileShare.holdsEmpty')
  return [h.files ? t('fileShare.holdsFiles', { n: h.files }) : null, h.folders ? t('fileShare.holdsFolders', { n: h.folders }) : null].filter(Boolean).join(', ')
}

/** why a folder can't be shared, in one plain sentence */
export const blockedKey = (b: FolderShareBlock): MessageKey => `fileShare.blocked.${b}` as MessageKey

/** "Jun", "Jun and Mina", "Jun and 2 others" */
export function peopleText(t: T, rows: readonly Pick<FileShareRow, 'name'>[]): string {
  if (rows.length === 1) return rows[0]!.name
  if (rows.length === 2) return t('fileShare.peopleTwo', { a: rows[0]!.name, b: rows[1]!.name })
  return t('fileShare.peopleMore', { a: rows[0]!.name, n: rows.length - 1 })
}

/** "Quote.pdf, Budget.xlsx and the folder Q4" (and "2 more" past the five the server names) */
export function keptText(t: T, locale: Locale, own: NonNullable<FileShares['ownShares']>): string {
  const names = own.names.map((x) => (x.folder ? t('fileShare.theFolder', { name: x.name }) : x.name))
  const rest = own.files + own.folders - own.names.length
  if (rest > 0) names.push(t('fileShare.nMore', { n: rest }))
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

/** Put back what a removal took (POST /api/files/shares/undo), and say how it went. */
export async function undoShare(t: T, locale: Locale, id: string, onDone?: (r: ShareUndoResult) => void): Promise<void> {
  try {
    const r = await api.call(API.undoFileShares, { body: { id } })
    onDone?.(r)
    fileSharesChanged.emit()
    toast({ level: 'success', text: r.skipped ? t('fileShare.undoneSome', { n: r.restored, total: r.restored + r.skipped }) : t('fileShare.undone') })
  } catch (e) {
    toast({ level: 'error', text: errorText(e, locale, t('fileShare.undoGone')) })
  }
}

/** The toast after a removal or Stop: what happened, with Undo while the server offers it. */
export function removedToast(t: T, locale: Locale, text: string, undo: FileShares['undo'], onUndone?: (r: ShareUndoResult) => void) {
  const ms = undo ? Math.max(0, Math.min(Date.parse(undo.until) - Date.now(), 15_000)) : 0
  toast({ level: 'success', text, ...(undo && ms > 0 ? { ms, action: { label: t('common.undo'), run: () => void undoShare(t, locale, undo.id, onUndone) } } : {}) })
}

