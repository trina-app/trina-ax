// Share for one file (QA TC-3093, docs/DECISIONS.md "A member shares their own files"; plan
// docs/AGENTS/plan/20261115-1407-file-share-links.md "UI" 1): the file's owner (the team owner and admins for a team file)
// adds people and groups who may view it, Drive style, in as few parts as that takes. Opened from a file row's ⋯ in
// Files, the file panel's ⋯ (a phone) and the "Share…" of a Copy link toast; a phone gets the app's bottom sheet (ui.tsx
// Modal). Folders keep their own dialog (components/FolderAccess.tsx).
// The parts: the people-and-groups search of the other Share dialogs (components/ProjectParticipants.tsx; a member is
// offered only their own groups, never a guest), and one press saves the picks (PUT /api/files/shares add); "People with
// access": the owner, then each person or group with "Can view" and ✕ (asked first: "Remove access for Bob?"); a team
// file's one grey line that the folder's people open it too. Footer: Copy link and Share (with picks) or Done. Someone who
// may not share sees who has it, the reason in one grey line, and Copy link. Not here: general access, roles, notify,
// message. "Everyone on the team" (QA TC-3509) is the search's first option, with one line before the press that the
// whole team, also people who join later, will be able to open it. A refusal (403 not the owner or sharing off, 400, 429) says why in the server's words.
import { Users, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { FileShareRow, FileShares, ProjectParticipant } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isConnectionError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { usePeopleList } from '../store/people'
import { useMe } from '../store/session'
import { toast } from '../store/ui'
import { Avatar } from './Avatar'
import { ListHeading, ListRow } from './list/List'
import { ParticipantPicker, participantKey, useParticipantOptions, type ParticipantOption } from './ProjectParticipants'
import { ShareCopyLink, useCopyLink, useTeamOrigin } from './ShareCopyLink'
import { EveryoneLine, useWithEveryone } from './ShareEveryone'
import { Button, ErrorNote, IconButton, Modal, Skeleton, confirmDialog, menuOpener } from './ui'

const nameOfPath = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The words of a refusal: the server's own (403, 400, 429), else "try again". */
function refusal(e: unknown, locale: ReturnType<typeof useLocale>, fallback: string): string {
  return e instanceof ApiError && !isConnectionError(e) && e.status < 500 ? errorText(e, locale, fallback) : fallback
}

/** The file's /f/<id> address on `origin` (the team origin: components/ShareCopyLink.tsx useTeamOrigin; made on first
 * use: POST /api/files/link). */
export async function fileLinkHref(path: string, origin = location.origin): Promise<string> {
  const r = await api.call(API.fileLink, { body: { path } })
  return `${origin}${r.url}`
}

/**
 * Copy link for a team file (not a folder): its /f/<id> link, and a toast true for the case. One's own personal file
 * not shared with anyone yet: only they can open it until they share it, with "Share…" to do that.
 */
export function useCopyTeamFileLink() {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const origin = useTeamOrigin()
  const copy = useCopyLink()
  return async (path: string) => {
    const own = !!me && path.startsWith(`users/${me.user.id}/`)
    try {
      const [href, shares] = await Promise.all([fileLinkHref(path, origin), own ? api.call(API.fileShares, { query: { path } }) : Promise.resolve(null)])
      // refused by the browser: its own toast with the link, never "Link copied"
      if (!(await copy(href))) return
      if (shares && !shares.people.length) toast({ level: 'success', text: t('fileLink.copiedOnlyYou'), ms: 10_000, action: { label: t('fileLink.shareAction'), run: () => openFileShare(path) } })
      else toast({ level: 'success', text: t('fileLink.copied') })
    } catch (e) {
      toast({ level: 'error', text: refusal(e, locale, t('error.network')) })
    }
  }
}

/** a row's face: a person's picture (or letter), a group's mark */
const Face = ({ row }: { row: { subjectType: string; subjectId: string; name: string; avatarVersion?: number } }) =>
  row.subjectType === 'group' ? <Users /> : <Avatar user={{ id: row.subjectId, name: row.name, avatarVersion: row.avatarVersion }} size="fill" />

export function FileShareDialog({ path, onClose, returnTo }: { path: string; onClose: () => void; returnTo?: HTMLElement | null }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const name = nameOfPath(path)
  const [shares, setShares] = useState<FileShares | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [picks, setPicks] = useState<ProjectParticipant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copyLink = useCopyTeamFileLink()

  const load = useCallback(() => {
    setLoadError(null)
    api.call(API.fileShares, { query: { path } }).then(setShares, setLoadError)
  }, [path])
  useEffect(load, [load])

  // the rows the server sent (a group I am not in, someone out of the directory) name themselves in the picker too
  const extra = useMemo<ParticipantOption[]>(() => (shares?.people ?? []).map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, name: r.name, ...(r.title ? { title: r.title } : {}), ...(r.avatarVersion ? { avatarVersion: r.avatarVersion } : {}) })), [shares])
  // "Everyone on the team" first (QA TC-3509), then groups and people
  const options = useWithEveryone(useParticipantOptions(extra))
  // not offered: me, the owner, whoever has it already, and never a guest (the server refuses them)
  const people = usePeopleList()
  const exclude = useMemo(() => new Set([
    me ? `user:${me.user.id}` : '',
    shares?.owner ? `user:${shares.owner.id}` : '',
    ...(shares?.people ?? []).map(participantKey),
    ...(people ?? []).filter((p) => p.guest).map((p) => `user:${p.id}`),
  ].filter(Boolean)), [me, shares, people])

  const share = async () => {
    if (!picks.length || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.putFileShares, { body: { path, add: picks, remove: [] } })
      // (no toast: the new rows show in the list under the field)
      setShares(r)
      setPicks([])
    } catch (e) {
      setError(refusal(e, locale, t('chat.share.saveFailed')))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (row: FileShareRow) => {
    if (!(await confirmDialog({ title: t('folderAccess.removeTitle', { name: row.name }), confirm: t('folderAccess.removeAccess'), danger: true }))) return
    setError(null)
    try {
      const r = await api.call(API.putFileShares, { body: { path, add: [], remove: [{ subjectType: row.subjectType, subjectId: row.subjectId }] } })
      setShares(r)
    } catch (e) {
      setError(refusal(e, locale, t('chat.share.saveFailed')))
    }
  }

  const canShare = !!shares?.canShare
  const ownerRow = shares?.owner
  return (
    <Modal
      open
      onClose={onClose}
      returnTo={returnTo}
      width={480}
      title={<span className="block min-w-0 truncate" data-testid="file-share-title">{t('folderAccess.title', { name })}</span>}
      footer={
        <>
          {error && <p role="alert" className="mr-auto w-full text-sm break-keep text-danger" data-testid="file-share-error">{error}</p>}
          <ShareCopyLink onCopy={() => void copyLink(path)} unsaved={canShare && picks.length > 0 ? t('fileShare.share') : null} testId="file-share-copy-link" />
          {canShare && picks.length > 0
            ? <Button variant="primary" busy={busy} onClick={() => void share()} data-testid="file-share-save">{t('fileShare.share')}</Button>
            : <Button variant="primary" onClick={onClose} data-testid="file-share-done">{t('common.done')}</Button>}
        </>
      }
    >
      <div className="space-y-4" data-testid="file-share-dialog" data-path={path}>
        {loadError ? <ErrorNote onRetry={load}>{errorText(loadError, locale, t('error.network'))}</ErrorNote> : null}
        {!shares && !loadError && <Skeleton lines={3} />}
        {shares && canShare && (
          // the search's own words name it ("Add people or groups"): no label above it saying the same
          <ParticipantPicker options={options} value={picks} onChange={(v) => { setPicks(v); setError(null) }} placeholder={t('fileShare.add')} exclude={exclude} hideEmpty testId="file-share-picker" />
        )}
        {shares && canShare && <EveryoneLine picks={picks} testId="file-share-everyone-line" />}
        {shares && (
          <section aria-labelledby="file-share-with">
            <ListHeading id="file-share-with" className="mb-1">{t('fileShare.withAccess')}</ListHeading>
            <ul className="-mx-3" data-testid="file-share-people">
              {ownerRow && (
                <ListRow face icon={<Face row={{ subjectType: 'user', subjectId: ownerRow.id, name: ownerRow.name }} />} name={ownerRow.name} tag={t('fileShare.owner')} li={{ 'data-testid': 'file-share-owner' }}
                  // the rows below have ✕: an unseen one here keeps "Owner" at the edge "Can view" ends at
                  // no-tooltip: an invisible spacer, never focused or pressed
                  actions={canShare && shares.people.length ? <span className="invisible" aria-hidden><IconButton label="" tip={false} tabIndex={-1} className="touch-hit shrink-0"><X size={14} /></IconButton></span> : undefined} />
              )}
              {shares.people.map((row) => (
                <ListRow
                  key={participantKey(row)}
                  face
                  icon={<Face row={row} />}
                  name={row.name}
                  meta={row.inactive ? t('fileShare.inactive') : row.title || undefined}
                  tag={t('fileShare.canView')}
                  li={{ 'data-testid': `file-share-row-${row.subjectType}-${row.subjectId}` }}
                  actions={canShare ? (
                    <IconButton label={t('fileShare.removeLabel', { name: row.name })} onClick={() => void remove(row)} className="touch-hit shrink-0" data-testid={`file-share-remove-${row.subjectType}-${row.subjectId}`}>
                      <X size={14} aria-hidden />
                    </IconButton>
                  ) : undefined}
                />
              ))}
            </ul>
            {shares.teamFile && <p className="mt-2 text-sm break-keep text-muted" data-testid="file-share-folder-too">{t('fileShare.folderToo')}</p>}
          </section>
        )}
        {shares && !canShare && <p className="text-sm break-keep text-muted" data-testid="file-share-why">{t(shares.off ? 'fileShare.off' : 'fileShare.ownerOnly')}</p>}
      </div>
    </Modal>
  )
}

/** One Share dialog for the app (FileShareHost, App.tsx), opened from anywhere: a Files row, the file panel, a toast. */
type Target = { path: string; seq: number; returnTo: HTMLElement | null }
const useFileShareHost = create<{ open: Target | null; seq: number }>(() => ({ open: null, seq: 0 }))
export const openFileShare = (path: string) => {
  const active = typeof document === 'undefined' ? null : document.activeElement
  const returnTo = menuOpener() ?? (active instanceof HTMLElement && active !== document.body ? active : null)
  useFileShareHost.setState((s) => ({ open: { path, seq: s.seq + 1, returnTo }, seq: s.seq + 1 }))
}

export function FileShareHost() {
  const open = useFileShareHost((s) => s.open)
  if (!open) return null
  return <FileShareDialog key={open.seq} path={open.path} returnTo={open.returnTo} onClose={() => useFileShareHost.setState({ open: null })} />
}
