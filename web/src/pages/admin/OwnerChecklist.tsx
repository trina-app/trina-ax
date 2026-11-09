// The owner's setup checklist on Admin › Home, for every install (docs/DECISIONS.md "Y — Home shows one thing at a
// time"; it was on Home before): AI connection · folder permissions · invite members · a team skill · a first backup.
// Only what is still to do shows, and the section goes once everything is done or the owner hid it (per browser).
// People who cannot use AI are Admin › Home's own "needs attention" line, not repeated here.
// While the welcome steps are unfinished the steps are the owner's checklist (docs/DECISIONS.md "W5"): this one hides,
// and when the owner hid the setup row (✕), one quiet "시작 설정 다시 보기" brings it back (OwnerSetup).
import { ChevronRight, Circle, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, API } from '../../lib/api'
import { useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { IconButton } from '../../components/ui'

/** Admin › Home's setup part for the owner: while the welcome steps are unfinished nothing but, when the setup row was
 * hidden, "시작 설정 다시 보기"; else the checklist below. Nothing until the steps' progress is read. */
export function OwnerSetup() {
  const t = useT()
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void useWelcome.getState().load().catch(() => {}) }, [])
  if (!loaded) return null
  if (!progress || progress.finishedAt) return <OwnerChecklist />
  if (!progress.dismissedAt) return null
  const back = () => {
    setBusy(true)
    void useWelcome.getState().update({ dismissed: false }).then(
      () => toast({ level: 'success', text: t('setupRow.back') }),
      () => toast({ level: 'error', text: t('error.network') }),
    ).finally(() => setBusy(false))
  }
  return (
    <section data-testid="owner-setup">
      <button type="button" disabled={busy} onClick={back} className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-left text-sm hover:bg-hover disabled:opacity-60" data-testid="owner-setup-show">
        <RotateCcw size={15} className="shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('setupRow.show')}</span>
      </button>
    </section>
  )
}

const CHECK_KEY = 'mycel.ownerChecklistHidden'

type Steps = { engine: boolean; folders: boolean; members: boolean; skill: boolean; backup: boolean }

const ITEMS: { step: keyof Steps; label: MessageKey; to: string }[] = [
  { step: 'engine', label: 'owner.check.engine', to: '/admin/providers' },
  { step: 'folders', label: 'owner.check.folders', to: '/admin/folders' },
  { step: 'members', label: 'owner.check.members', to: '/admin/members' },
  { step: 'skill', label: 'owner.check.skill', to: '/skills' },
  { step: 'backup', label: 'owner.check.backup', to: '/admin/system' },
]

export function OwnerChecklist() {
  const t = useT()
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(CHECK_KEY) === '1' } catch { return false }
  })
  const [steps, setSteps] = useState<Steps | null>(null)
  useEffect(() => {
    if (hidden) return
    let live = true
    Promise.allSettled([api.call(API.engines), api.call(API.listUsers), api.call(API.listInvites), api.call(API.listFolders), api.call(API.listBackups), api.call(API.listSkills), api.call(API.getTeamLink)]).then(([e, u, i, f, b, sk, tl]) => {
      if (!live) return
      setSteps({
        engine: e.status === 'fulfilled' && e.value.engines.some((x) => x.enabled && (x.status === 'ok' || x.status === 'limited')),
        // the starting rules (shared/ and skills/, updatedBy null) come with every new team: done once someone set one
        folders: f.status === 'fulfilled' && f.value.items.some((x) => x.rules.some((r) => r.updatedBy !== null)),
        // invited: someone joined, an invite waits, or the team invite link works now (made in the welcome steps or
        // Admin › Members; an expired, used-up or stopped link no longer invites anyone)
        members: (u.status === 'fulfilled' && u.value.items.length > 1) || (i.status === 'fulfilled' && i.value.items.length > 0) || (tl.status === 'fulfilled' && tl.value.link?.state === 'active'),
        // a team skill: the caller's own personal skills do not count
        skill: sk.status === 'fulfilled' && sk.value.items.some((x) => !x.personal),
        backup: b.status === 'fulfilled' && b.value.items.length > 0,
      })
    })
    return () => {
      live = false
    }
  }, [hidden])
  const left = steps ? ITEMS.filter((it) => !steps[it.step]) : []
  if (hidden || !left.length) return null
  const hide = () => {
    try { localStorage.setItem(CHECK_KEY, '1') } catch { /* this tab only */ }
    setHidden(true)
  }
  return (
    <section aria-labelledby="owner-check" data-testid="owner-checklist">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="owner-check" className="text-sm font-semibold">{t('owner.check.title')}</h2>
        <IconButton label={t('common.hide')} onClick={hide} data-testid="owner-checklist-hide"><X size={15} aria-hidden /></IconButton>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {left.map((it) => (
          <li key={it.step}>
            <Link to={it.to} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-hover focus-visible:-outline-offset-2" data-testid={`owner-check-${it.step}`}>
              <Circle size={15} className="shrink-0 text-faint" aria-label={t('common.todo')} />
              <span className="min-w-0 flex-1 truncate">{t(it.label)}</span>
              <ChevronRight size={15} className="shrink-0 text-faint" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
