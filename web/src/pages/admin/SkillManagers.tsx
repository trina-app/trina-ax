// "팀 스킬 관리" on Admin > 멤버 and Admin > 그룹 (docs/DECISIONS.md "팀 스킬 관리"): a toggle per person / group that
// adds or removes their write rule on skills/ or one of its folders (PUT /api/admin/skill-managers). It is the same rule
// Admin > 폴더 권한 shows; there is no other permission. Turning it on warns that what they change is followed by every
// teammate's AI. The owner and admins always manage team skills. On Members a person whom a group's rule or "everyone"
// already lets write in skills/ shows on, with why (the server's own answer for skills/, GET /api/admin/access/folder):
// not switched here, as it is not their rule; one with a rule of their own as well switches only that, and is told
// first when another rule would still let them write (the server's edit preview without their row).
import clsx from 'clsx'
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import type { FolderAccessResponse, SkillManagerGrant, SkillManagersResponse } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { isSkillsPath } from '../../lib/access-view'
import { nameProblem } from '../../lib/paths'
import { useT } from '../../i18n'
import { Badge, Button, Field, Modal, confirmDialog, inputCls } from '../../components/ui'
import { toast } from '../../store/ui'
import { useAction, useActionOk, useLoad } from './common'

export type Subject = { type: 'user' | 'group'; id: string; name: string; always?: boolean }

export function useSkillManagers() {
  return useLoad(async () => api.call(API.listSkillManagers))
}

/** Every active person's access at a team folder and the step that decided it, by person id (GET
 * /api/admin/access/folder, the permission function's own answer, all pages). Null while `path` is null or a value it
 * follows (`after`) is not in yet; asked again when one of them changes. */
export function useFolderPeople(path: string | null, ...after: unknown[]) {
  return useLoad(async () => {
    if (path === null || after.some((x) => x == null)) return null
    const people = new Map<string, FolderAccessResponse['people'][number]>()
    let cursor: string | undefined
    do {
      const r = await api.call(API.explainFolderAccess, { query: { path, limit: 2000, ...(cursor ? { cursor } : {}) } })
      for (const p of r.people) people.set(p.user.id, p)
      cursor = r.nextCursor ?? undefined
    } while (cursor)
    return people
  }, [path, ...after])
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

/** Why a person writes in skills/ when it is not their own rule there: everyone (or the old "members" row), their
 * groups, or a rule of theirs on the team root. Null: no write, or their own rule on skills/ (the switch shows that). */
export type SkillsVia = { kind: 'everyone' } | { kind: 'group'; names: string[] } | { kind: 'root' }
export function skillsVia(a: FolderAccessResponse['people'][number] | undefined, groupName: (id: string) => string | undefined): SkillsVia | null {
  if (!a || a.access !== 'write' || a.reason.kind !== 'rule') return null
  const r = a.reason
  if (r.tier === 'group') return { kind: 'group', names: r.rules.filter((x) => x.access === 'write' && x.subjectId).map((x) => groupName(x.subjectId!) ?? '?') }
  if (r.tier === 'user') return isSkillsPath(r.folder) ? null : { kind: 'root' }
  return { kind: 'everyone' }
}

const grantsOf = (data: SkillManagersResponse | null, s: Subject) => (data?.items ?? []).filter((g) => g.subjectType === s.type && g.subjectId === s.id)
const shown = (p: string) => p + '/'

/** The toggle cell of a member or group row: on/off, and the folders it covers. `via`: on through a rule that is not
 * theirs (said under it; changed in Folder permissions, not here). */
export function SkillManagerCell({ subject, data, via, onChanged }: { subject: Subject; data: SkillManagersResponse | null; via?: SkillsVia | null; onChanged: () => void }) {
  const t = useT()
  const actOk = useActionOk()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const viaId = useId()
  if (subject.always)
    return (
      <span data-testid={`skill-manager-${subject.type}-${subject.id}`}>
        <Badge tone="accent">{t('skillMgr.always')}</Badge>
      </span>
    )
  const grants = grantsOf(data, subject)
  const own = grants.length > 0
  // on through another rule only: the switch shows it on and cannot turn it off (that rule is not theirs)
  const locked = !own && !!via
  const viaText = !via ? null : via.kind === 'everyone' ? t('skillMgr.viaEveryone') : via.kind === 'group' ? t('skillMgr.viaGroup', { names: via.names.join(', ') }) : t('skillMgr.viaRoot')
  const turnOff = async (which: SkillManagerGrant[]) => {
    // a person whom another rule still lets write says so first (the switch shows on through it afterwards)
    setBusy(true)
    const still = subject.type === 'user' && (await stillWrites(subject.id, which))
    setBusy(false)
    const body = t('skillMgr.offBody', { paths: which.map((g) => shown(g.path)).join(', ') })
    if (!(await confirmDialog({ title: t('skillMgr.offTitle', { name: subject.name }), body: still ? `${body} ${t('skillMgr.offStillOn')}` : body, confirm: t('common.continue'), danger: true }))) return
    setBusy(true)
    let all = true
    for (const g of which) {
      if (!(await actOk(() => api.call(API.setSkillManager, { body: { subjectType: subject.type, subjectId: subject.id, path: g.path, enabled: false } })))) { all = false; break }
    }
    setBusy(false)
    // a failure was toasted already: no "turned off" over it
    if (all) toast({ level: 'success', text: t('skillMgr.turnedOff') })
    onChanged()
  }
  return (
    <div className="flex flex-col items-start gap-1" data-testid={`skill-manager-${subject.type}-${subject.id}`}>
      <label className={clsx('inline-flex cursor-pointer items-center gap-2', (busy || !data || locked) && 'cursor-not-allowed opacity-60')}>
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={own || locked}
          disabled={busy || !data || locked}
          aria-label={t('skillMgr.toggleLabel', { name: subject.name })}
          aria-describedby={viaText ? viaId : undefined}
          data-testid="skill-manager-toggle"
          onChange={(e) => (e.target.checked ? setOpen(true) : void turnOff(grants))}
        />
        <span className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong/60 transition peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" aria-hidden />
      </label>
      {viaText && (
        <span id={viaId} className="text-[11px] text-muted" data-testid="skill-manager-via">
          {viaText}
        </span>
      )}
      {locked && (
        <Link to="/admin/folders?folder=skills" className="text-[11px] text-accent-text hover:underline" data-testid="skill-manager-via-link">
          {t('skillMgr.viaChange')}
        </Link>
      )}
      {own && (
        <span className="flex flex-wrap gap-1" data-testid="skill-manager-scope">
          {grants.map((g) => (
            <span key={g.path} className="font-mono text-[11px] text-muted">
              {shown(g.path)}
            </span>
          ))}
        </span>
      )}
      {own && (
        <button type="button" className="text-[11px] text-accent-text hover:underline" onClick={() => setOpen(true)}>
          {t('common.edit')}
        </button>
      )}
      {open && <SkillManagerDialog subject={subject} data={data} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </div>
  )
}

/** Turn it on for a scope (skills/ or a folder in it, or a new folder); see and remove the scopes it has. */
function SkillManagerDialog({ subject, data, onClose, onChanged }: { subject: Subject; data: SkillManagersResponse | null; onClose: () => void; onChanged: () => void }) {
  const t = useT()
  const act = useAction()
  const actOk = useActionOk()
  const grants = grantsOf(data, subject)
  const folders = (data?.folders ?? ['skills']).filter((f) => !grants.some((g) => g.path === f))
  const NEW = '\u0000new'
  const [scope, setScope] = useState(folders[0] ?? NEW)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const problem = scope === NEW ? (name.trim() ? nameProblem(name.trim()) : null) : null
  const target = scope === NEW ? `skills/${name.trim()}` : scope
  const ready = scope !== NEW || (!!name.trim() && !problem)
  const turnOn = async () => {
    setBusy(true)
    const r = await act(() => api.call(API.setSkillManager, { body: { subjectType: subject.type, subjectId: subject.id, path: target, enabled: true } }))
    setBusy(false)
    if (!r) return
    toast({ level: 'success', text: t('skillMgr.turnedOn', { path: shown(target) }) })
    onChanged()
    onClose()
  }
  const remove = async (g: SkillManagerGrant) => {
    if (!(await confirmDialog({ title: t('skillMgr.offTitle', { name: subject.name }), body: t('skillMgr.offBody', { paths: shown(g.path) }), confirm: t('common.continue'), danger: true }))) return
    if (await actOk(() => api.call(API.setSkillManager, { body: { subjectType: subject.type, subjectId: subject.id, path: g.path, enabled: false } }))) onChanged()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('skillMgr.dialogTitle', { name: subject.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={turnOn} data-testid="skill-manager-on">
            {t('skillMgr.turnOn')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="skill-manager-dialog">
        <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="skill-manager-warning">
          {t('skillMgr.warn')}
        </p>
        {grants.length > 0 && (
          <div>
            <p className="mb-1 text-[13px] font-medium">{t('skillMgr.current')}</p>
            <ul className="space-y-1">
              {grants.map((g) => (
                <li key={g.path} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 font-mono text-xs">{shown(g.path)}</span>
                  <Button size="sm" variant="ghost-danger" onClick={() => remove(g)}>
                    {t('skillMgr.removeScope', { path: shown(g.path) })}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label={t('skillMgr.scope')}>
          <select className={inputCls} value={scope} onChange={(e) => setScope(e.target.value)} data-testid="skill-manager-scope-select">
            {folders.map((f) => (
              <option key={f} value={f}>
                {f === 'skills' ? t('skillMgr.scopeAll') : shown(f)}
              </option>
            ))}
            <option value={NEW}>{t('skillMgr.scopeNew')}</option>
          </select>
        </Field>
        {scope === NEW && (
          <Field label={t('skillMgr.newFolder')} error={problem ? t(`files.name.${problem}`) : null}>
            <div className="flex items-center gap-1">
              <span className="font-mono text-sm text-muted">skills/</span>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-autofocus data-testid="skill-manager-new-folder" />
            </div>
          </Field>
        )}
      </div>
    </Modal>
  )
}
