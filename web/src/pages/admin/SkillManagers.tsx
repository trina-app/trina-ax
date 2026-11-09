// Who can edit team skills (docs/DECISIONS.md "팀 스킬 관리"): one line on the Team skills page for the owner and admins
// (SkillEditorsLine) and the dialog behind its [바꾸기] (SkillManagerDialog). Editing team skills is write access on
// skills/ or one of its folders; there is no other permission. The owner and admins always can. The line says what
// Admin › 폴더 권한 says for skills/ (the server's grouped answer, GET /api/admin/access/tree): people and groups with a
// rule of their own, everyone, a rule on the whole team folder. The dialog lists the people's and groups' own write rules
// on skills/ and its folders (GET /api/admin/skill-managers) and removes one or adds one for all of skills/ (PUT
// /api/admin/skill-managers: the same rule Folder permissions shows, the same audit). Adding warns first that every
// teammate's AI follows what they change; a folder of its own is handed over in Folder permissions, and the line counts
// the folders inside skills/ whose own rules give anyone write ("폴더별로 맡긴 곳 2개"). The owner and admins are one
// "항상" row: an old rule of someone made an admin later is not listed (the server refuses to remove it). Removing a
// person whom another rule still lets write says so first, and which (the server's edit preview without their row).
// Group skills (groups/<folder>/skills/, docs/DECISIONS.md "Group skills") are their group's members': not here.
import clsx from 'clsx'
import { ShieldCheck } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AccessTreeWho, FolderAccessResponse, SkillManagerGrant } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { skillEditorsElsewhere, skillEditorsText, skillFoldersWithEditors } from '../../lib/access-view'
import { useT } from '../../i18n'
import { Button, ErrorNote, Modal, Skeleton, confirmDialog } from '../../components/ui'
import { Avatar } from '../../components/Avatar'
import { GroupTile } from '../../components/GroupTile'
import { useFaceOf } from '../../store/people'
import { toast } from '../../store/ui'
import { useAction, useActionOk, useLoad } from './common'
import { AddNamed, type NamedOption } from './AddNamed'

const SKILLS = 'skills'
/** Admin › 폴더 권한 with skills/ chosen: where a folder of skills/ is handed over, and other rules are changed. */
const SKILLS_FOLDER_LINK = '/admin/folders?folder=skills'

function useSkillManagers() {
  return useLoad(async () => api.call(API.listSkillManagers))
}

/** Every active person's access at a team folder and the step that decided it, by person id (GET
 * /api/admin/access/folder, the permission function's own answer, all pages). */
async function folderPeople(path: string) {
  const people = new Map<string, FolderAccessResponse['people'][number]>()
  let cursor: string | undefined
  do {
    const r = await api.call(API.explainFolderAccess, { query: { path, limit: 2000, ...(cursor ? { cursor } : {}) } })
    for (const p of r.people) people.set(p.user.id, p)
    cursor = r.nextCursor ?? undefined
  } while (cursor)
  return people
}

/** folderPeople as a hook: null while `path` is null or a value it follows (`after`) is not in yet; asked again when one
 * of them changes. */
export function useFolderPeople(path: string | null, ...after: unknown[]) {
  return useLoad(async () => (path === null || after.some((x) => x == null) ? null : folderPeople(path)), [path, ...after])
}

/**
 * Would the person still write in skills/ without their own rules there? The server's preview (POST
 * /api/admin/access/edit-preview, nothing saved) of each of their topmost own folders with their row taken out: exact,
 * whatever would decide then (a group, everyone, the old members row, a rule on the team root). False when not known.
 */
async function stillWrites(userId: string, grants: readonly SkillManagerGrant[]): Promise<boolean> {
  try {
    const top = grants.filter((g) => !grants.some((h) => h !== g && g.path.startsWith(h.path + '/')))
    const rows = (await api.call(API.listFolders)).items
    for (const g of top) {
      const row = rows.find((f) => f.path === g.path)
      if (!row) continue
      const rules = row.rules.filter((r) => !(r.subjectType === 'user' && r.subjectId === userId)).map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access }))
      const p = await api.call(API.previewFolderEdit, { body: { path: g.path, rules: rules as never } })
      // their own write decided there; named in a change: they lose it. A change from write that names only part of its
      // people may hold them: not known
      const loses = p.changes.some((c) => c.people.some((x) => x.id === userId))
      const unknown = p.changes.some((c) => c.before === 'write' && c.people.length < c.count)
      if (!loses && !unknown) return true
    }
  } catch {
    // not known: no claim
  }
  return false
}

const shown = (p: string) => p + '/'
const grantKey = (g: SkillManagerGrant) => `${g.subjectType}:${g.subjectId}:${g.path}`

/** skills/ as Folder permissions shows it: who writes there, grouped by the rule that decided, and how many people
 * rules decide for. */
type SkillsNode = { who: AccessTreeWho[]; members: number }

/** A quiet text button inside a line of secondary text (a phone: 44 px to tap, a box around the word above and below
 * it, while the line keeps its height). */
const lineButton =
  "relative rounded-sm font-medium whitespace-nowrap text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:after:absolute max-sm:after:-inset-x-2 max-sm:after:-inset-y-3 max-sm:after:content-['']"

/**
 * The Team skills page, owner and admins only: "고칠 수 있는 사람: 팀장·관리자, 영업팀 3명, Bob 님 [바꾸기]". Quiet: one
 * line of secondary text and one text button. Two requests: the server's answer for skills/ (who writes there) and the
 * folder rules (the folders inside skills/ with editors of their own, counted at the end: "폴더별로 맡긴 곳 2개"). When
 * the rules cannot be read, the line names who it knows without "만"; when skills/' answer cannot, it says so with a
 * retry. Its height is kept while it loads (nothing below jumps).
 */
export function SkillEditorsLine({ className }: { className?: string }) {
  const t = useT()
  const textId = useId()
  const node = useLoad<SkillsNode>(async () => {
    const r = await api.call(API.explainAccessTree, { query: { path: SKILLS, limit: 1 } })
    return { who: r.self.who, members: r.members }
  })
  const folders = useLoad(async () => skillFoldersWithEditors((await api.call(API.listFolders)).items))
  const [open, setOpen] = useState(false)
  if (node.error && !node.data)
    return (
      <p className={clsx('text-xs leading-5 text-muted', className)} data-testid="skill-editors-failed">
        {t('skillMgr.loadFailed')} ·{' '}
        <button type="button" className={lineButton} onClick={() => void node.reload()} data-testid="skill-editors-retry">
          {t('common.retry')}
        </button>
      </p>
    )
  // both in (or the rules failed: then without "만"), so the line does not change its words once shown
  if (!node.data || (folders.data === null && !folders.error)) return <div className={clsx('h-5', className)} aria-hidden />
  return (
    <>
      <p className={clsx('text-xs leading-5 text-muted [overflow-wrap:anywhere]', className)} data-testid="skill-editors">
        <span id={textId} data-testid="skill-editors-text">
          {skillEditorsText(t, node.data.who, node.data.members, folders.data)}
        </span>{' '}
        {/* a phone: 44 px to tap (a box around the word, above and below it), the line keeps its height */}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-describedby={textId}
          className={lineButton}
          onClick={() => {
            // the dialog loads its own lists; of the line's, it uses skills/' answer (who edits through other rules):
            // that one is asked again with it, the folder rules are not
            void node.reload()
            setOpen(true)
          }}
          data-testid="skill-editors-change"
        >
          {t('skillMgr.change')}
        </button>
      </p>
      {open && (
        <SkillManagerDialog
          node={node.data}
          onClose={() => setOpen(false)}
          onChanged={() => {
            void node.reload()
            void folders.reload()
          }}
        />
      )}
    </>
  )
}

/**
 * Who can edit all of skills/: the owner and admins (always), each person's and group's own rule on skills/ or a folder
 * in it (removable), the editors other rules make (said, with a link to Folder permissions), and a search to add a
 * person or group for all of skills/ after the warning.
 */
function SkillManagerDialog({ node, onClose, onChanged }: { node: SkillsNode; onClose: () => void; onChanged: () => void }) {
  const t = useT()
  const act = useAction()
  const actOk = useActionOk()
  const managers = useSkillManagers()
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [picked, setPicked] = useState<NamedOption | null>(null)
  /** the grant being removed (its key) or 'add' */
  const [busy, setBusy] = useState<string | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const addId = useId()
  const warnId = useId()
  /** once someone is picked, the warning takes the focus: read first (a screen reader says it; a phone's keyboard goes
   * and the step is in view), then Tab reaches Cancel and Turn on */
  const warning = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (picked) warning.current?.focus()
  }, [picked])
  /** after a removal: set with the fresh list (never while it is asked, never after a failed answer), used once it is on
   * the screen. The focus goes to the remove button now at that place, else to the search (the removed row's button is
   * gone); not when someone is typing in the search meanwhile. */
  const focusAt = useRef<number | null>(null)
  useEffect(() => {
    const i = focusAt.current
    focusAt.current = null
    if (i === null || document.activeElement === search.current) return
    const buttons = list.current?.querySelectorAll<HTMLElement>('[data-testid="skill-editor-remove"]') ?? []
    ;(buttons[Math.min(i, buttons.length - 1)] ?? search.current)?.focus()
  }, [managers.data])
  const failed = managers.error ?? users.error ?? groups.error
  const ready = !!managers.data && !!users.data && !!groups.data
  const userOf = (id: string) => users.data?.find((u) => u.id === id)
  // a rule of someone made the owner or an admin later stays on the folder; they are in the "항상" row (and the server
  // refuses to remove it: managers.ts)
  const grants = (managers.data?.items ?? []).filter((g) => g.subjectType === 'group' || userOf(g.subjectId)?.role === 'member' || !userOf(g.subjectId))
  const groupOf = (id: string) => groups.data?.find((g) => g.id === id)
  const nameOf = (g: SkillManagerGrant) => (g.subjectType === 'group' ? groupOf(g.subjectId)?.name : userOf(g.subjectId)?.name) ?? '?'
  // the owner and admins always can (the server refuses them); people switched off cannot use it
  const people = (users.data ?? []).filter((u) => u.role === 'member' && u.status === 'active')
  const taken = new Set(grants.filter((g) => g.path === SKILLS).map((g) => `${g.subjectType}:${g.subjectId}`))
  const elsewhere = skillEditorsElsewhere(t, node.who, node.members)
  const faceOf = useFaceOf()

  const remove = async (g: SkillManagerGrant, i: number) => {
    // one at a time; the button keeps the focus while the server is asked (the confirm gives it back)
    if (busy) return
    const name = nameOf(g)
    // a person whom another rule still lets write is told first
    setBusy(grantKey(g))
    const still = g.subjectType === 'user' && (await stillWrites(g.subjectId, [g]))
    setBusy(null)
    // why: their own rule on a folder above (removing skills/재무/ of someone with skills/ too), else a group's or everyone's
    const above = grants.find((h) => h.subjectType === 'user' && h.subjectId === g.subjectId && g.path.startsWith(h.path + '/'))
    const note = !still ? '' : above ? t('skillMgr.offStillOwn', { path: shown(above.path) }) : t('skillMgr.offStillOn')
    const body = t('skillMgr.offBody', { paths: shown(g.path) })
    if (!(await confirmDialog({ title: t('skillMgr.offTitle', { name }), body: note ? `${body} ${note}` : body, confirm: t('skillMgr.remove'), danger: true }))) return
    setBusy(grantKey(g))
    const ok = await actOk(() => api.call(API.setSkillManager, { body: { subjectType: g.subjectType, subjectId: g.subjectId, path: g.path, enabled: false } }))
    setBusy(null)
    // a failure was toasted already: no "removed" over it
    if (ok) toast({ level: 'success', text: t('skillMgr.turnedOff') })
    // the list as it is now; a failed answer was toasted and moves nothing
    const fresh = await act(() => api.call(API.listSkillManagers))
    if (fresh) {
      focusAt.current = i
      managers.setData(fresh)
    }
    onChanged()
  }
  const turnOn = async () => {
    if (!picked) return
    setBusy('add')
    const r = await act(() => api.call(API.setSkillManager, { body: { subjectType: picked.kind, subjectId: picked.id, path: SKILLS, enabled: true } }))
    setBusy(null)
    if (!r) return
    toast({ level: 'success', text: t('skillMgr.turnedOn', { path: shown(SKILLS) }) })
    clearPick()
    managers.setData(r)
    onChanged()
  }
  /** the pending block goes, with the button that had the focus: back to the search */
  const clearPick = () => {
    setPicked(null)
    search.current?.focus()
  }

  return (
    <Modal open onClose={onClose} title={t('skillMgr.dialogTitle')}>
      <div data-testid="skill-manager-dialog">
        {failed && !ready ? (
          <ErrorNote onRetry={() => void Promise.all([managers.reload(), users.reload(), groups.reload()])}>{failed}</ErrorNote>
        ) : !ready ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <ul ref={list} className="-mt-2 divide-y divide-line" data-testid="skill-editors-list">
              <li className="flex min-h-11 items-center gap-2 py-2" data-testid="skill-editor-always">
                {/* in a box as wide as the faces below, so the names line up */}
                <span className="flex size-5 shrink-0 items-center justify-center text-faint" aria-hidden>
                  <ShieldCheck size={15} />
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium text-ink">{t('skillMgr.ownerAdmins')}</span>
                <span className="shrink-0 px-2.5 text-label text-muted">{t('skillMgr.always')}</span>
              </li>
              {grants.map((g, i) => {
                const name = nameOf(g)
                return (
                  <li key={grantKey(g)} className="flex min-h-11 items-center gap-2 py-2" data-testid="skill-editor" data-subject={`${g.subjectType}:${g.subjectId}`} data-path={g.path}>
                    {g.subjectType === 'group' ? <GroupTile size={20} /> : <Avatar user={faceOf({ id: g.subjectId, name })} size={20} />}
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
                      <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere] text-ink">{name}</span>
                      {/* the kind only: a member count here would differ from the line's (people a group's rule decides for) */}
                      {g.subjectType === 'group' && <span className="text-xs text-faint">{t('skillMgr.groupKind')}</span>}
                      {/* a folder of skills/ only (all of skills/ needs no folder named) */}
                      {g.path !== SKILLS && (
                        <span className="font-mono text-xs [overflow-wrap:anywhere] text-muted" data-testid="skill-editor-folder">
                          {shown(g.path)}
                        </span>
                      )}
                    </span>
                    <Button size="sm" variant="ghost-danger" className="shrink-0" aria-busy={busy === grantKey(g) || undefined} aria-label={t('skillMgr.removeLabel', { name, path: shown(g.path) })} onClick={() => void remove(g, i)} data-testid="skill-editor-remove">
                      {t('skillMgr.remove')}
                    </Button>
                  </li>
                )
              })}
            </ul>
            {elsewhere.length > 0 && (
              <p className="mt-1 text-xs leading-5 text-muted [overflow-wrap:anywhere]" data-testid="skill-editors-elsewhere">
                {t('skillMgr.elsewhere', { list: elsewhere.join(', ') })}{' '}
                <Link to={SKILLS_FOLDER_LINK} className="font-medium whitespace-nowrap text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink" data-testid="skill-editors-elsewhere-link">
                  {t('skillMgr.viaChange')}
                </Link>
              </p>
            )}
            <section className="mt-6" aria-labelledby={addId}>
              <h3 id={addId} className="text-sm font-semibold text-ink">
                {t('skillMgr.add')}
              </h3>
              <AddNamed inline inputRef={search} users={people} groups={groups.data ?? []} taken={taken} onAdd={setPicked} saidOf={(o) => t('skillMgr.picked', { name: o.name })} />
              {picked && (
                <div className="mt-3 space-y-3" data-testid="skill-editor-pending">
                  <p className="text-sm text-ink [overflow-wrap:anywhere]">{t('skillMgr.pending', { name: picked.name })}</p>
                  <p ref={warning} id={warnId} tabIndex={-1} role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="skill-manager-warning">
                    {t('skillMgr.warn')}
                  </p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" disabled={busy === 'add'} onClick={clearPick}>
                      {t('common.cancel')}
                    </Button>
                    <Button variant="primary" busy={busy === 'add'} aria-describedby={warnId} onClick={() => void turnOn()} data-testid="skill-manager-on">
                      {t('skillMgr.turnOn')}
                    </Button>
                  </div>
                </div>
              )}
              <p className="mt-3 text-xs">
                <Link to={SKILLS_FOLDER_LINK} className="text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink" data-testid="skill-editors-by-folder">
                  {t('skillMgr.byFolder')}
                </Link>
              </p>
            </section>
          </>
        )}
      </div>
    </Modal>
  )
}
