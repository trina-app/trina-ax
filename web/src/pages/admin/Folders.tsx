// Admin › Folder permissions (docs/DECISIONS.md "드라이브처럼 공유 P1.5"): Google Drive has no admin table of rules (its
// admins manage a shared drive's members and change a folder in its own Share dialog), so this page is two lists in the
// Files page's words, nothing more. **Folders**: only the folders shared differently from the folder they are in, each
// marked Limited / Shared with more / Whole team, with [Share] opening the same Share dialog as Files (team projects'
// folders as one line: their members decide). **What <person> can open**: read only, each folder with Viewer / Editor and
// why, and what they cannot open. The choice is in the address (`?view=people&person=<id>`; `?edit=<path>` opens a
// folder's Share dialog, and `?folder=<path>` from older links does the same), so links and Back work.
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FolderAccessNotice } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useFolderWords } from '../../lib/folderLabels'
import { useSearchParams } from 'react-router-dom'
import { Info, Search, X } from 'lucide-react'
import { useT } from '../../i18n'
import { FolderAccessPanel } from '../../components/FolderAccess'
import { projectsByFolder } from '../../lib/projectFolders'
import { readProjectList, useProjects } from '../../store/projects'
import { IconButton, Spinner, TabPanel, Tabs, inputCls, useMediaQuery } from '../../components/ui'
import { AdminPageHeader, useActionOk } from './common'
import { FolderHeaderSlots } from './folder-slots'

const FolderList = lazy(() => import('./FolderLists').then((m) => ({ default: m.FolderList })))
const PersonOpens = lazy(() => import('./FolderLists').then((m) => ({ default: m.PersonOpens })))

export default function Folders() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const panels = useId()
  const view = params.get('view') === 'people' ? 'people' : 'folders'
  // a phone: a person is a page of their own under the bar (adminScreens.ts), without the page's line and the tabs
  const inDetail = phone && view === 'people' && params.has('person')
  const [query, setQuery] = useState('')
  const choose = (v: 'folders' | 'people') => {
    const q = new URLSearchParams(window.location.search)
    const now = q.get('view') === 'people' ? 'people' : 'folders'
    if (v !== now) {
      setQuery('')
      setParams(v === 'people' ? { view: 'people' } : {}, { replace: phone })
    }
  }
  // the Share dialog: `?edit=<path>` (and `?folder=<path>` from older links); closing it leaves the address. [Share] puts
  // it in place (no history entry of its own): the sheet takes Back itself (lib/backCloses.ts), so one Back closes it and
  // stays on the list (a phone's Back went past the list before)
  const editing = params.get('edit') ?? params.get('folder')
  const [round, setRound] = useState(0)
  const listedProjects = useProjects((st) => st.listed)
  const projectsById = useProjects((st) => st.byId)
  const projectFolders = useMemo(() => projectsByFolder(listedProjects ? [...listedProjects].flatMap((id) => projectsById[id] ?? []) : []), [listedProjects, projectsById])
  useEffect(() => { void readProjectList().catch(() => {}) }, [])
  const guard = useRef<() => Promise<boolean>>(async () => true)
  const closeEdit = () => {
    const q = new URLSearchParams(window.location.search)
    q.delete('edit')
    q.delete('folder')
    q.delete('back')
    q.delete('from')
    setParams(q, { replace: true })
  }
  const search = (
    <div className="relative w-full md:w-72">
      <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t(view === 'people' ? 'folders.findPerson' : 'folders.findFolder')}
        aria-label={t(view === 'people' ? 'folders.findPerson' : 'folders.findFolder')}
        className={`${inputCls} h-9 pl-9`}
        data-testid={view === 'people' ? 'access-person-search' : 'folders-search'}
      />
    </div>
  )
  return (
    <FolderHeaderSlots.Provider value={{ actions: null, filter: null, off: inDetail }}>
      {inDetail ? <h2 className="sr-only">{t('admin.folders')}</h2> : <AdminPageHeader
        title={t('admin.folders')}
        desc={t('folders.pageDesc')}
        testId="folders-header"
        controls={
          <>
            <div className={phone ? 'flex w-full' : 'contents'} data-testid="folders-views">
              <Tabs
                segmented
                value={view}
                onChange={choose}
                panels={panels}
                items={[
                  { id: 'folders', label: t('folders.tabFolders') },
                  { id: 'people', label: t('folders.tabPerson') },
                ]}
                label={t('admin.folders')}
              />
            </div>
            {search}
          </>
        }
      />}
      {/* #787's one-time notice: each folder opens its Share dialog */}
      {!inDetail && view === 'folders' && <ConversionNotice onOpen={(path) => setParams((p) => { const q = new URLSearchParams(p); q.set('edit', path); return q }, { replace: true })} />}
      <TabPanel base={panels} value={view}>
        <Suspense fallback={<Spinner />}>
          {view === 'people' ? <PersonOpens query={query} /> : <FolderList key={round} query={query} onShare={(path) => setParams((p) => { const q = new URLSearchParams(p); q.set('edit', path); return q }, { replace: true })} />}
        </Suspense>
      </TabPanel>
      {editing !== null && (
        <FolderAccessPanel
          key={editing}
          target={{ path: editing, access: 'write' }}
          project={null}
          projectOf={(p) => projectFolders.get(p.normalize('NFC')) ?? null}
          fromAdmin
          guard={guard}
          onClose={closeEdit}
          onSaved={() => setRound((n) => n + 1)}
        />
      )}
    </FolderHeaderSlots.Provider>
  )
}

/**
 * The one-time notice after folder access began to add up like Google Drive (docs/DECISIONS.md "Folder access adds up
 * like Google Drive (P2)"): the folders that now list their people by name, each opening its Share dialog, until an owner
 * or admin closes it (for the whole team). Nothing when the server has nothing to say or is older.
 */
function ConversionNotice({ onOpen }: { onOpen: (path: string) => void }) {
  const t = useT()
  const words = useFolderWords()
  const actOk = useActionOk()
  const [notice, setNotice] = useState<FolderAccessNotice['notice']>(null)
  useEffect(() => {
    let gone = false
    api.call(API.folderAccessNotice).then((r) => !gone && setNotice(r.notice), () => {})
    return () => { gone = true }
  }, [])
  if (!notice) return null
  const close = async () => { if (await actOk(() => api.call(API.dismissFolderAccessNotice))) setNotice(null) }
  return (
    <section className="mb-4 rounded-xl border border-line bg-accent-soft/40 p-4 text-sm" aria-labelledby="folders-notice-title" data-testid="folders-notice">
      <div className="flex items-start gap-3">
        <Info size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id="folders-notice-title" className="font-semibold text-ink">{t('folderAccess.noticeTitle')}</h3>
          <p className="mt-1 text-muted">{t('folderAccess.noticeBody')}</p>
          <ul className="mt-2 space-y-1">
            {notice.folders.map((f) => (
              <li key={f.path} className="flex flex-wrap items-baseline gap-x-2">
                <button type="button" className="min-w-0 text-left font-medium [overflow-wrap:anywhere] text-accent-text underline-offset-2 hover:underline" onClick={() => onOpen(f.path)} data-testid="folders-notice-folder">{words.path(f.path, ' › ')}</button>
                <span className="text-xs text-muted">{t('folderAccess.noticeRow', { n: f.count })}</span>
              </li>
            ))}
          </ul>
        </div>
        <IconButton label={t('common.close')} onClick={() => void close()} data-testid="folders-notice-close">
          <X size={15} />
        </IconButton>
      </div>
    </section>
  )
}
