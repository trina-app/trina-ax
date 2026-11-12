// Projects from before the update (docs/DECISIONS.md "Projects from before the update: one card, Add me to these", QA
// TC-360): the owner or an admin who could open team projects by their role before the update to members-only
// projects, and cannot now, gets ONE card on Admin › Home (and the phone's Admin list): how many, their names, "Add me
// to these" (a member of all of them in one go; their members are told, so it asks first) and a dismiss (never again,
// on any device). The server decides who gets it and which projects (server/src/chat/old-projects.ts); members and
// everyone else get no items, and no card shows.
import { FolderKanban, UserPlus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ProjectsUpdateNotice } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, IconButton, confirmDialog } from '../../components/ui'

/** Their names, the first 8 and "+N" for the rest (Projects lists them all). */
const listed = (list: string[]) => list.slice(0, 8).join(', ') + (list.length > 8 ? ` +${list.length - 8}` : '')

export function OldProjectsCard({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<ProjectsUpdateNotice['items']>([])
  const [busy, setBusy] = useState<'join' | 'dismiss' | null>(null)

  const load = () => api.call(API.getProjectsUpdateNotice).then((r) => r.items)
  useEffect(() => {
    let live = true
    // (an older server without the route, or a network hiccup: no card)
    load().then((list) => live && setItems(list), () => live && setItems([]))
    return () => { live = false }
  }, [])

  if (!items.length) return null
  const count = items.length

  const join = async () => {
    if (busy) return
    const ok = await confirmDialog({ title: t('adminHome.oldProjects.confirmTitle', { count }), body: <p>{t('projects.addMeBody')}</p>, confirm: t('adminHome.oldProjects.add') })
    if (!ok) return
    setBusy('join')
    try {
      const r = await api.call(API.joinProjectsUpdateNotice)
      if (r.joined) toast({ level: 'success', text: t('adminHome.oldProjects.done', { count: r.joined }) })
      if (r.skipped) toast({ level: 'error', text: t('adminHome.oldProjects.skipped', { count: r.skipped }) })
      // (the list again; when that fails, what is left as far as we know: nothing when all were joined)
      const left = await load().catch(() => (r.skipped ? null : []))
      if (left) setItems(left)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }
  const dismiss = async () => {
    if (busy) return
    setBusy('dismiss')
    try {
      await api.call(API.dismissProjectsUpdateNotice)
      setItems([])
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="admin-old-projects" className={compact ? 'mx-4 mt-4' : undefined} data-testid="admin-old-projects">
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
        <FolderKanban size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="admin-old-projects" className="text-sm font-semibold">{t('adminHome.oldProjects.title', { count })}</h2>
          <p className="mt-1 text-sm break-words text-ink" data-testid="admin-old-projects-names">{listed(items.map((p) => p.name))}</p>
          <p className="mt-1 text-xs text-muted">{t('adminHome.oldProjects.body')}</p>
          <Button size="sm" variant="primary" className="mt-3" busy={busy === 'join'} disabled={busy === 'dismiss'} onClick={() => void join()} data-testid="admin-old-projects-add">
            <UserPlus size={14} aria-hidden /> {t('adminHome.oldProjects.add')}
          </Button>
        </div>
        <IconButton label={t('adminHome.oldProjects.dismiss')} onClick={() => void dismiss()} disabled={!!busy} data-testid="admin-old-projects-dismiss">
          <X size={16} />
        </IconButton>
      </div>
    </section>
  )
}
