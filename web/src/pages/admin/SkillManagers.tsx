// "팀 스킬 관리" on Admin > 멤버 and Admin > 그룹 (docs/DECISIONS.md "팀 스킬 관리"): a toggle per person / group that
// adds or removes their write rule on skills/ or one of its folders (PUT /api/admin/skill-managers). It is the same rule
// Admin > 폴더 권한 shows; there is no other permission. Turning it on warns that what they change is followed by every
// teammate's AI. The owner and admins always manage team skills.
import clsx from 'clsx'
import { useState } from 'react'
import type { SkillManagerGrant, SkillManagersResponse } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { nameProblem } from '../../lib/paths'
import { useT } from '../../i18n'
import { Badge, Button, Field, Modal, confirmDialog, inputCls } from '../../components/ui'
import { toast } from '../../store/ui'
import { useAction, useLoad } from './common'

export type Subject = { type: 'user' | 'group'; id: string; name: string; always?: boolean }

export function useSkillManagers() {
  return useLoad(async () => api.call(API.listSkillManagers))
}

const grantsOf = (data: SkillManagersResponse | null, s: Subject) => (data?.items ?? []).filter((g) => g.subjectType === s.type && g.subjectId === s.id)
const shown = (p: string) => p + '/'

/** The toggle cell of a member or group row: on/off, and the folders it covers. */
export function SkillManagerCell({ subject, data, onChanged }: { subject: Subject; data: SkillManagersResponse | null; onChanged: () => void }) {
  const t = useT()
  const act = useAction()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (subject.always)
    return (
      <span data-testid={`skill-manager-${subject.type}-${subject.id}`}>
        <Badge tone="accent">{t('skillMgr.always')}</Badge>
      </span>
    )
  const grants = grantsOf(data, subject)
  const on = grants.length > 0
  const turnOff = async (which: SkillManagerGrant[]) => {
    if (!(await confirmDialog({ title: t('skillMgr.offTitle', { name: subject.name }), body: t('skillMgr.offBody', { paths: which.map((g) => shown(g.path)).join(', ') }), confirm: t('common.continue'), danger: true }))) return
    setBusy(true)
    for (const g of which) {
      if ((await act(() => api.call(API.setSkillManager, { body: { subjectType: subject.type, subjectId: subject.id, path: g.path, enabled: false } }))) === undefined) break
    }
    setBusy(false)
    toast({ level: 'success', text: t('skillMgr.turnedOff') })
    onChanged()
  }
  return (
    <div className="flex flex-col items-start gap-1" data-testid={`skill-manager-${subject.type}-${subject.id}`}>
      <label className={clsx('inline-flex cursor-pointer items-center gap-2', (busy || !data) && 'cursor-not-allowed opacity-60')}>
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={on}
          disabled={busy || !data}
          aria-label={t('skillMgr.toggleLabel', { name: subject.name })}
          data-testid="skill-manager-toggle"
          onChange={(e) => (e.target.checked ? setOpen(true) : void turnOff(grants))}
        />
        <span className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong/60 transition peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" aria-hidden />
      </label>
      {on && (
        <span className="flex flex-wrap gap-1" data-testid="skill-manager-scope">
          {grants.map((g) => (
            <span key={g.path} className="font-mono text-[11px] text-muted">
              {shown(g.path)}
            </span>
          ))}
        </span>
      )}
      {on && (
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
    if ((await act(() => api.call(API.setSkillManager, { body: { subjectType: subject.type, subjectId: subject.id, path: g.path, enabled: false } }))) !== undefined) onChanged()
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
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => remove(g)}>
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
