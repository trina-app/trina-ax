// Find work files on this computer, the share step (docs/decisions/20261116-find-files-share-step.md; plan
// docs/AGENTS/plan/20261116-0140-find-files-share-step.md). After the ticked files landed in My files › From this
// computer: "Share any of these with your team?", who sees them (the file Share dialog's own people-and-groups search: a
// member is offered only their own groups, never a guest), the files with a box each and NOTHING ticked, a small "Good
// to share · Form" on the kinds teams usually keep together (the AI's reason from the list before, else the name), ONE
// primary button and Not now. Share is the Share dialog's call for each ticked file (lib/shareFound.ts), nothing else:
// the files nobody ticks stay private. The caller (FindWorkFiles.tsx RunResult) shows the result after it.
import clsx from 'clsx'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ProjectParticipant, TeamFileReason } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { hintedFirst, shareBatch, shareHint, type ShareOutcome } from '../../lib/shareFound'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { usePeopleList } from '../../store/people'
import { useMe } from '../../store/session'
import { ParticipantPicker, participantKey, useParticipantOptions } from '../ProjectParticipants'
import { whoNames } from '../ShareWarning'
import { EveryoneLine, isEveryone, useWithEveryone } from '../ShareEveryone'
import { Button } from '../ui'
import { TickRow } from './TickList'

const REASON: Record<TeamFileReason, MessageKey> = {
  form: 'welcome.teamFiles.reason.form', intro: 'welcome.teamFiles.reason.intro', report: 'welcome.teamFiles.reason.report', minutes: 'welcome.teamFiles.reason.minutes',
  brand: 'welcome.teamFiles.reason.brand', policy: 'welcome.teamFiles.reason.policy', training: 'welcome.teamFiles.reason.training', proposal: 'welcome.teamFiles.reason.proposal',
}

export interface SharedResult extends ShareOutcome {
  /** who they went to, as the result line names them ("Sales, Bob") */
  names: string
}

export function ShareFoundFiles({ paths, reasons, where, phone, added, onShared, onSkip }: {
  /** the files the run added (their paths in My files) */
  paths: readonly string[]
  /** the AI's reasons from the list before, by path */
  reasons: ReadonlyMap<string, TeamFileReason>
  /** a file's place in words ("Documents › Sales") */
  where: (path: string) => string
  phone: boolean
  /** "Added 6 files to My files › From this computer" */
  added: string
  onShared: (r: SharedResult) => void
  onSkip: () => void
}) {
  const t = useT()
  const ids = useId()
  const me = useMe()
  const people = usePeopleList()
  const locale = useLocale()
  // "Everyone on the team" first (QA TC-3509), then groups and people
  const options = useWithEveryone(useParticipantOptions())
  const list = useMemo(() => hintedFirst(paths, reasons), [paths, reasons])
  const [ticks, setTicks] = useState<Set<string>>(() => new Set())
  const [picks, setPicks] = useState<ProjectParticipant[]>([])
  const [going, setGoing] = useState<{ k: number; n: number } | null>(null)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  // never offered: me (the owner of these files) and a guest (the server refuses them)
  const exclude = useMemo(() => new Set([me ? `user:${me.user.id}` : '', ...(people ?? []).filter((p) => p.guest).map((p) => `user:${p.id}`)].filter(Boolean)), [me, people])
  const byKey = useMemo(() => new Map(options.map((o) => [participantKey(o), o])), [options])

  const pad = phone ? 'px-0' : 'px-4'
  const frame = phone ? 'border-y border-line' : 'rounded-xl border border-line bg-surface'
  const chosen = list.filter((p) => ticks.has(p))

  const share = async () => {
    if (!chosen.length || !picks.length || going) return
    // the whole team by its own words ("everyone on the team"), never as a group's people
    const names = [...(picks.some(isEveryone) ? [t('fileShare.everyoneWho')] : []), whoNames(t, picks.filter((p) => !isEveryone(p)).flatMap((p) => { const o = byKey.get(participantKey(p)); return o ? [{ subjectType: o.subjectType, name: o.name }] : [] }))].filter(Boolean).join(t('rooms.nameSep'))
    setGoing({ k: 0, n: chosen.length })
    const r = await shareBatch(chosen, picks, {
      post: (paths, add) => api.call(API.shareFilesBatch, { body: { paths, add } }),
      words: (e) => errorText(e, locale, t('chat.share.saveFailed')),
      live: () => live.current,
    })
    if (!live.current) return
    setGoing(null)
    onShared({ ...r, names })
  }

  const meta = (path: string) => {
    const hint = shareHint(path, reasons)
    return hint ? <><span className="font-medium text-ink">{t('files.findWork.share.hint', { kind: t(REASON[hint]) })}</span> · {where(path)}</> : where(path)
  }

  return (
    <div className="space-y-4" data-testid="find-work-share">
      <div className="space-y-1">
        <p className="text-label text-muted" role="status" data-testid="find-work-share-added">{added}</p>
        <h2 className="text-display font-semibold text-ink" data-testid="find-work-share-title">{t('files.findWork.share.title')}</h2>
        <p className="text-sm text-balance text-muted">{t('files.findWork.share.desc')}</p>
      </div>
      <ParticipantPicker options={options} value={picks} onChange={setPicks} placeholder={t('fileShare.add')} exclude={exclude} hideEmpty readOnly={!!going} testId="find-work-share-picker" />
      <ul className={frame} data-testid="find-work-share-list">
        {list.map((p, i) => (
          <TickRow key={p} id={`${ids}-${i}`} rowKey={p} name={p.slice(p.lastIndexOf('/') + 1)} meta={meta(p)} first={i === 0} pad={pad} checked={ticks.has(p)} disabled={!!going}
            onChange={(on) => setTicks((s) => { const n = new Set(s); if (on) n.add(p); else n.delete(p); return n })} testId="find-work-share-row" checkTestId="find-work-share-check" />
        ))}
      </ul>
      {chosen.length > 0 && <EveryoneLine picks={picks} files={chosen.length} testId="find-work-share-everyone-line" />}
      {going ? <p className="text-label text-muted" role="status" data-testid="find-work-share-going">{t('files.findWork.share.going', { n: going.n })}</p>
        : chosen.length > 0 && !picks.length ? <p className="text-label text-muted" data-testid="find-work-share-who">{t('files.findWork.share.who')}</p> : null}
      <div className={phone ? 'flex flex-col-reverse gap-2 [&>*]:w-full' : 'flex flex-wrap items-center justify-end gap-3'}>
        <Button variant="ghost" className={clsx(phone && 'w-full')} disabled={!!going} onClick={onSkip} data-testid="find-work-share-skip">{t('files.findWork.share.skip')}</Button>
        <Button variant="primary" className={clsx(phone && 'w-full')} disabled={!chosen.length || !picks.length} busy={!!going} onClick={() => void share()} data-testid="find-work-share-go">
          {chosen.length ? t('files.findWork.share.go', { n: chosen.length }) : t('files.findWork.share.goNone')}
        </Button>
      </div>
    </div>
  )
}
