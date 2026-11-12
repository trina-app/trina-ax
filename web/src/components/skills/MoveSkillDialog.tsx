// "옮기기…" in a skill row's menu on the Skills page (docs/DECISIONS.md "Project skills"): one skill to another level
// (팀 전체 · a group · a project's chats · 나만). GET /api/skills/move lists the levels with who gains and who loses it
// ("2명이 새로 쓰고 2명은 못 쓰게 돼요 (3명 → 3명)"), or why it cannot go; a level that reaches more people shows the
// skill's whole text first.
// POST /api/skills/move moves it as seen (`token`: every file's hash and the target; a change since answers 409).
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import type { SkillMoveOptions, SkillMoveTarget } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { skillsChanged } from '../../store/live'
import { toast } from '../../store/ui'
import { Button, ErrorNote, Modal, Skeleton } from '../ui'

const key = (x: SkillMoveTarget) => (x.to.level === 'group' ? `group:${x.to.groupId}` : x.to.level === 'project' ? `project:${x.to.projectId}` : x.to.level)

/** Who gains and who loses it, with the counts before and after: "2명이 새로 쓰고 2명은 못 쓰게 돼요 (3명 → 3명)" (never
 * "2 more (3 → 3)": two gain it and two lose it). The server's card says it the same way (skills/move.ts changeLine). */
function changeText(t: ReturnType<typeof useT>, x: Pick<SkillMoveTarget, 'gained' | 'lost' | 'people'>, from: number): string {
  const vars = { gained: x.gained, lost: x.lost, from, to: x.people }
  if (x.gained && x.lost) return t('skills.moveBoth', vars)
  if (x.gained) return t('skills.moveGainedOnly', vars)
  if (x.lost) return t('skills.moveLostOnly', vars)
  return t('skills.moveSamePeople', { n: x.people })
}

export function MoveSkillDialog({ path, name, onClose }: { path: string; name: string; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [opts, setOpts] = useState<SkillMoveOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.call(API.skillMoveOptions, { query: { path } }).then(
      (o) => { if (!live) return; setOpts(o); setPicked(o.targets.find((x) => !x.blocked)?.to ? key(o.targets.find((x) => !x.blocked)!) : null) },
      (e) => live && setError(errorText(e, locale, t('error.network'))),
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  const target = opts?.targets.find((x) => key(x) === picked && !x.blocked) ?? null
  const move = async () => {
    if (!target?.token) return
    setBusy(true)
    try {
      const r = await api.call(API.moveSkill, { body: { path, to: target.to, token: target.token } })
      toast({ level: 'success', text: t('skills.moveDone', { name: r.name, to: r.to }) })
      skillsChanged.emit()
      onClose()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('skills.moveTitle', { name })}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void move()} disabled={!target} busy={busy} data-testid="skill-move-do">{t('skills.moveDo')}</Button>
        </>
      }
    >
      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {!opts && !error && <Skeleton lines={4} />}
      {opts && (
        <div className="space-y-4 text-sm" data-testid="skill-move">
          <p className="text-muted" data-testid="skill-move-now">{t('skills.moveNow', { label: opts.from.label, n: opts.from.people })}</p>
          <fieldset>
            <legend className="mb-1.5 font-medium">{t('skills.moveWhere')}</legend>
            {!opts.targets.length && <p className="text-muted">{t('skills.moveNone')}</p>}
            <ul className="-mx-2 space-y-0.5">
              {opts.targets.map((x) => (
                <li key={key(x)}>
                  <label className={clsx('flex items-start gap-3 rounded-lg px-2 py-2', x.blocked ? 'opacity-60' : 'cursor-pointer md:hover:bg-hover')} data-testid="skill-move-target" data-level={x.to.level} data-blocked={x.blocked ? true : undefined}>
                    <input type="radio" name="skill-move-to" className="mt-1" checked={picked === key(x)} disabled={!!x.blocked} onChange={() => setPicked(key(x))} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{x.label}</span>
                        {/* a level it can go to says the count in its line: "(3명 → 3명)" */}
                        {x.blocked && <span className="text-xs text-muted tabular-nums">{t('skills.movePeople', { n: x.people })}</span>}
                      </span>
                      {x.blocked ? (
                        <span className="mt-0.5 block text-xs text-faint">{x.blocked}</span>
                      ) : (
                        <span className="mt-0.5 block text-xs text-muted tabular-nums" data-testid="skill-move-effect">
                          {[changeText(t, x, opts.from.people), t('skills.moveEditors', { n: x.editors })].join(' · ')}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <p className="text-xs text-faint" data-testid="skill-move-files" title={opts.files.map((f) => f.path).join('\n')}>{t('skills.moveFiles', { n: opts.files.length })}</p>
          {/* more people's AI will follow it: every word of it first */}
          {target && target.gained > 0 && (
            <div className="space-y-2" data-testid="skill-move-widen">
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">{t('skills.moveWiden')}</p>
              <pre className="scroll-thin max-h-64 overflow-auto rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-code-sm leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="skill-move-text">{opts.text}</pre>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
