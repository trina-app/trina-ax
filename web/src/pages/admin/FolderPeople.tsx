// A folder's people, as Admin › Folder permissions lists them (GET /api/admin/access/folder): every active person's
// access at the folder and the reason, by name, with people switched off apart. Used by the tree's folder detail
// (AccessTree.tsx) and by the Files page's "Who can see it" panel for admins (FolderAccessAdmin.tsx). Admins only: the
// server refuses the endpoint to anyone else.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { FolderAccessResponse } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { levelOf, reasonText, type Names } from '../../lib/access-view'
import { useLocale, useT } from '../../i18n'
import { Button, ErrorNote, Skeleton } from '../../components/ui'
import { Avatar } from '../../components/Avatar'
import { useFaceOf } from '../../store/people'
import { accessErrorText, LevelLabel } from './AccessResults'

/** One folder's people, page by page (GET /api/admin/access/folder); asked again when `reloadKey` changes, as many as
 * were shown. A page that comes after the folder was asked again (a slow "Load more" across a rule change) is dropped.
 * `path` null: nothing is asked. */
export function useFolderAnswer(path: string | null, reloadKey: number) {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = useState<FolderAccessResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const [attempt, setAttempt] = useState(0)
  const shown = useRef(0)
  shown.current = data?.people.length ?? 0
  /** which asking the data on the screen comes from */
  const gen = useRef(0)
  useEffect(() => {
    if (path === null) return
    const g = ++gen.current
    const want = shown.current
    setError(null)
    setMore({ busy: false, error: null })
    void (async () => {
      try {
        let r = await api.call(API.explainFolderAccess, { query: { path } })
        // after a change: as many people as were shown come again
        while (g === gen.current && r.nextCursor !== null && r.people.length < want) {
          const next = await api.call(API.explainFolderAccess, { query: { path, cursor: r.nextCursor } })
          r = { ...next, people: [...r.people, ...next.people] }
        }
        if (g === gen.current) setData(r)
      } catch (e) {
        if (g === gen.current) setError(accessErrorText(e, locale, t))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadKey, attempt])
  const loadMore = async () => {
    if (!data?.nextCursor || more.busy || path === null) return
    const g = gen.current
    const cursor = data.nextCursor
    setMore({ busy: true, error: null })
    try {
      const r = await api.call(API.explainFolderAccess, { query: { path, cursor } })
      if (g !== gen.current) return
      setData((d) => (d && d.nextCursor === cursor ? { ...r, people: [...d.people, ...r.people] } : d))
      setMore({ busy: false, error: null })
    } catch (e) {
      if (g === gen.current) setMore({ busy: false, error: accessErrorText(e, locale, t) })
    }
  }
  return { data, error, more, loadMore, retry: () => setAttempt((n) => n + 1) }
}

/** The people of a folder as Admin › Folder permissions lists them: the counts, then each person with their face, role,
 * the reason in one dim line and their access, "Load more", and people switched off. `linkPeople`: each name opens that
 * person in By person (the Files page's panel; the tree's own detail leaves it out). */
export function People({ answer, path, names, linkPeople = false }: { answer: ReturnType<typeof useFolderAnswer>; path: string; names: Names; linkPeople?: boolean }) {
  const t = useT()
  const faceOf = useFaceOf()
  const { data, error } = answer
  if (error && !data) return <div className="mt-3"><ErrorNote onRetry={answer.retry}>{error}</ErrorNote></div>
  if (!data) return <Skeleton lines={4} className="mt-3" />
  const s = data.summary.access
  // the stage 3 reason of each person, at this folder
  const asRow = (p: Pick<FolderAccessResponse['people'][number], 'access' | 'reason' | 'listable' | 'via' | 'viaMore'>) => ({ path, kinds: [], exists: data.exists, ...p })
  return (
    <>
      {/* asked again after a change and it failed: what shows is from before, and says so */}
      {error && (
        <p role="status" className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-danger" data-testid="folder-people-stale">
          {t('accessTree.refreshFailed')}
          <button type="button" className="font-medium underline underline-offset-2" onClick={answer.retry}>
            {t('common.retry')}
          </button>
        </p>
      )}
      <p className="mt-2 text-xs text-muted tabular-nums" data-testid="folder-detail-counts">
        {t('accessTree.counts', { see: s.read + s.write, write: s.write, none: s.none })}
      </p>
      <ul className="mt-1 divide-y divide-line border-t border-line" data-testid="folder-people">
        {data.people.map((p) => {
          const level = levelOf(p)
          return (
            <li key={p.user.id} className="flex items-start gap-3 py-2" data-testid="folder-person" data-person={p.user.id} data-level={level}>
              {/* the face on the name's line; the reason under the name */}
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <Avatar user={faceOf(p.user)} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    {linkPeople ? (
                      <Link to={`/admin/folders?view=people&person=${encodeURIComponent(p.user.id)}`} className="min-w-0 truncate text-sm text-ink underline-offset-2 hover:underline" data-testid="folder-person-link">
                        {p.user.name}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate text-sm text-ink">{p.user.name}</span>
                    )}
                    <span className="shrink-0 text-xs text-faint">· {t(`role.${p.role}`)}</span>
                  </div>
                  {/* the reason in one dim line; all of it in the tooltip and for screen readers */}
                  <p className="truncate text-xs text-faint" title={reasonText(t, asRow(p), p.role, names).join(' · ')}>
                    {reasonText(t, asRow(p), p.role, names).join(' · ')}
                  </p>
                </div>
              </div>
              <LevelLabel level={level} className="mt-0.5 flex shrink-0 text-xs" />
            </li>
          )
        })}
      </ul>
      {data.nextCursor !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void answer.loadMore()} busy={answer.more.busy} data-testid="folder-people-more">
            {t('common.loadMore')}
          </Button>
          <span className="text-xs text-faint tabular-nums">{t('accessView.loaded', { n: data.people.length, total: data.total })}</span>
        </div>
      )}
      {answer.more.error && <div className="mt-2"><ErrorNote onRetry={() => void answer.loadMore()}>{answer.more.error}</ErrorNote></div>}
      {data.inactive.length > 0 && (
        <div className="mt-4">
          <h5 className="text-xs font-semibold text-muted">{t('accessTree.inactive')}</h5>
          <ul className="mt-1 divide-y divide-line">
            {data.inactive.map((p) => (
              <li key={p.user.id} className="flex items-start gap-2 py-2" data-testid="folder-inactive">
                {/* not in the people directory: their letter */}
                <Avatar user={faceOf(p.user)} size={20} />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{p.user.name}</span>
                  <LevelLabel level={levelOf({ access: p.access, listable: p.access !== 'none' })} className="mt-0.5 flex text-xs" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
