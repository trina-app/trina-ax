// "팀에 준비된 것" on a first-time Home (docs/DECISIONS.md "W6.3 — What a new member sees first"; GET /api/skills/
// examples, server/src/skills/examples.ts): what the team set up, where the invite lands, and one first thing to press.
// - Skills: up to 3 rows (the landing skill, then 자연스러운 글 → 카드뉴스 → 홍보 영상 → 회사 소개서, then the others), each
//   its title, its one line, [예시] (a kept skill's example, only when there is one) and [써 보기] (its form over Home;
//   자연스러운 글 fills the box with "/humanizer 아래 글을 자연스럽게 다듬어 줘:" and a new line instead: its form has no box
//   for the text; the box then waits for the person's text before it sends), then "팀 스킬 N개 더 ›". They stay until
//   the person ran a team skill, however many chats they have.
// - Team files: while the person has no chats and the team folder holds documents they can read: "{folder} · 파일 n개"
//   with [물어보기], which puts a question that names the folder in the box as people read it ("예시커피 폴더", never
//   "groups/…"; names and types only, the brand folder and the skills folder left out as the count leaves them out,
//   said in words; not sent).
// - Nothing of that: "이렇게 시작해 보세요" with one ready question that needs no team file (a saved company profile: what
//   the company does; else how the AI can help with the team's work), and the "no team folder" line when they can open
//   none.
// One filled button for a member: the first skill's 써 보기, else 물어보기, else the ready question. Owners and admins get
// no filled button here (the goal card or the setup row is the one thing on Home: docs/DECISIONS.md "Y") and, with
// nothing prepared, "스킬 넣기 · 팀 파일 넣기" instead of a question (스킬 넣기 opens 팀 스킬 with the ready-made skills
// unfolded). `readOnly` (a member under the no-AI card): the rows and 예시 only. Phones (below 768px): a skill row's tap
// is 써 보기 (it says so at its end, as the files row says 물어보기), with 예시 as its own target at the row's end; the
// files row is one row. The block reads again when skills, files or access change (once per burst of changes); a failed
// read is one quiet "다시 불러오기", never the empty state. While its skill rows show, Home leaves 「자주 쓰는 스킬」 out.
import clsx from 'clsx'
import { ArrowUpLeft, ChevronRight } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { labeledPath } from '@mycel/shared'
import { WORK_HUMANIZER_SKILL, type FileChange, type Locale, type PackCatalogSkill, type PreparedSkill, type TeamPrepared as TeamPreparedData } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { SKILL_CATALOG } from '../../lib/nav'
import { isSkillsPath } from '../../lib/skillIssues'
import { visibleFolders } from '../../lib/visibleFolders'
import { useLocale, useT } from '../../i18n'
import { accessChanged, filesChanged, reloadAsked, skillsChanged } from '../../store/live'
import { isAdmin, useMeStrict } from '../../store/session'
import { quietLink } from './SkillShareReview'
import { SkillExampleViewer } from '../skills/SkillExampleViewer'
import { SkillFormDialog } from '../skills/SkillForm'
import { Button, useMediaQuery } from '../ui'
import { LoadError } from '../LoadError'

/** Skill rows on Home before "팀 스킬 N개 더 ›". */
export const PREPARED_SKILL_ROWS = 3
const PHONE = '(max-width: 767.98px)'

/** A file change the block cares about: a skill, the team's group folders, shared/ (the company start of a team that
 * began after docs/DECISIONS.md "Team folder basics"), the company profile. */
const touches = (changes: FileChange[]) => changes.some((c) => [c.path, c.from].some((p) => !!p && (isSkillsPath(p) || p.startsWith('groups/') || p.startsWith('shared/'))))

/** How long the block waits after a change it hears of before it reads again: a team folder where many files change at
 * once (a folder upload, a sync) is one read, not one per file. */
export const PREPARED_RELOAD_MS = 1500

/** GET /api/skills/examples, read again when skills, team files or access change (as the skills list does), once per
 * burst of changes (PREPARED_RELOAD_MS). `enabled` false: not read. A failed read keeps `error` until a read works, so
 * the notice stays while `reload` reads again (components/LoadError.tsx); `reload`'s promise settles with that read. */
export function useTeamPrepared(enabled = true, again: unknown = null): { data: TeamPreparedData | null; failed: boolean; error: unknown; reload: () => Promise<void> } {
  const [data, setData] = useState<TeamPreparedData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const loadRef = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true, generation = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = () => {
      const g = ++generation
      return api.call(API.skillExamples).then(
        (d) => { if (live && g === generation) { setData(d); setError(null) } },
        (e: unknown) => { if (live && g === generation) setError(e ?? new Error('failed')) },
      )
    }
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; if (live) void load() }, PREPARED_RELOAD_MS)
    }
    loadRef.current = load
    void load()
    const offs = [skillsChanged.on(later), accessChanged.on(later), reloadAsked.on(later), filesChanged.on((c) => { if (touches(c)) later() })]
    return () => { live = false; loadRef.current = null; if (timer) clearTimeout(timer); for (const off of offs) off() }
  }, [enabled, again])
  return { data, failed: error !== null, error, reload: () => loadRef.current?.() ?? Promise.resolve() }
}

/** The team folder as people read it: "groups/Acme/회사 자료" → "Acme › 회사 자료", "shared" → "전사 공유" (the top
 * folders' words, shared/src/folder-labels.ts). */
export const folderLabel = (path: string, locale: Locale = 'ko') => (path.startsWith('groups/') ? path.slice('groups/'.length).split('/').join(' › ') : labeledPath(path, locale, null, ' › '))

/** 물어보기's question: the folder by the name people read ("예시커피 폴더"), the brand folder (`without[0]`, its name in
 * the team's language) and the skills folder left out in words, as the count leaves them out. */
export const filesQuestion = (t: (k: 'home.prepared.filesAsk', p: Record<string, string>) => string, f: Pick<NonNullable<TeamPreparedData['teamFolder']>, 'path' | 'without'>, locale: Locale = 'ko') =>
  t('home.prepared.filesAsk', { folder: folderLabel(f.path, locale), brand: f.without[0] ?? '' })

/** What the block shows for this person (the rules above), apart from the data load. Exported for its test. */
export function preparedView(d: TeamPreparedData, o: { firstTime: boolean; admin: boolean; readOnly: boolean }) {
  const skills = d.ranTeamSkill ? [] : d.skills
  const rows = skills.slice(0, PREPARED_SKILL_ROWS)
  const files = o.firstTime && d.teamFolder && d.teamFolder.files > 0 ? d.teamFolder : null
  const empty = !rows.length && !files
  // nothing prepared at all (not only nothing shown): owners and admins get the two ways to prepare it. A count that
  // stopped (`more`) before it found a document is not "nothing"
  const nothing = !d.skills.length && !(d.teamFolder?.files ?? 0) && !d.teamFolder?.more
  const ready = empty && o.firstTime && !o.readOnly && !o.admin
  const add = empty && o.firstTime && o.admin && nothing
  const primary: 'skill' | 'files' | 'ready' | null = o.admin || o.readOnly ? null : rows.length ? 'skill' : files ? 'files' : ready ? 'ready' : null
  return { rows, more: skills.length - rows.length, files, ready, add, primary, shown: !empty || ready || add }
}

export interface TeamPreparedProps {
  /** the person has no chats yet: the files row and the ready question can show */
  firstTime: boolean
  /** puts a request in the message box (never sends it); `waits`: it needs the person's own text after it, and this
   * line says so under the box while the box holds only the request (nothing is sent meanwhile) */
  onCompose: (text: string, waits?: string) => void
  /** no AI answers the person (a member under the no-AI card): rows and 예시 only */
  readOnly?: boolean
  /** whether skill rows show, once that is known (false after a failed read): Home leaves 「자주 쓰는 스킬」 out while they
   * do, so two lists of skills never sit side by side */
  onSkillRows?: (shown: boolean) => void
}

export function TeamPrepared({ firstTime, onCompose, readOnly = false, onSkillRows }: TeamPreparedProps) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const admin = isAdmin(me)
  const phone = useMediaQuery(PHONE)
  const ids = useId()
  const { data, failed, error, reload } = useTeamPrepared()
  const [running, setRunning] = useState<PreparedSkill | null>(null)
  const [viewing, setViewing] = useState<PreparedSkill | null>(null)
  const exampleButtons = useRef(new Map<string, HTMLButtonElement>())
  const skillRows = data ? preparedView(data, { firstTime, admin, readOnly }).rows.length > 0 : failed ? false : null
  useEffect(() => {
    if (skillRows !== null) onSkillRows?.(skillRows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillRows])
  if (failed && !data) {
    // the calm notice (the connection: it reads again by itself, and the block shows when a read works); never red
    // under the box, and never the empty state
    return (
      <div className="mt-6" data-testid="team-prepared-failed">
        <LoadError error={error} onRetry={reload} soft what="team-prepared" />
      </div>
    )
  }
  if (!data) return null
  const v = preparedView(data, { firstTime, admin, readOnly })
  if (!v.shown) return null

  const tryIt = (s: PreparedSkill) => {
    // 자연스러운 글 works on the person's own text: the box, where they paste it (its form has nowhere for it)
    if (s.path === WORK_HUMANIZER_SKILL) onCompose(`/${s.name} ${t('home.prepared.humanizerAsk')}\n`, t('home.prepared.humanizerPaste'))
    else setRunning(s)
  }
  // the folders the count leaves out (the brand folder, the group's skills): the question leaves them out too
  const askFiles = (f: NonNullable<TeamPreparedData['teamFolder']>) => onCompose(filesQuestion(t, f, locale))
  const example = (s: PreparedSkill) => s.example && (
    <button
      ref={(el) => { if (el) exampleButtons.current.set(s.path, el); else exampleButtons.current.delete(s.path) }}
      type="button"
      className={clsx(quietLink, 'shrink-0 text-label max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center max-md:px-3', !phone && 'touch-hit')}
      aria-haspopup="dialog"
      aria-label={t('skillPack.exampleNamed', { title: s.title })}
      onClick={() => setViewing(s)}
      data-testid="team-prepared-example"
    >
      {t('skillPack.example')}
    </button>
  )
  const count = (f: NonNullable<typeof v.files>) => t(f.more ? 'home.prepared.filesMore' : 'home.prepared.filesCount', { n: f.files })
  const heading = v.ready ? t('home.prepared.startTitle') : t('home.prepared.title')

  return (
    <section
      className="mt-6 md:rounded-2xl md:border md:border-line md:px-4 md:py-3"
      aria-labelledby={`${ids}-title`}
      data-testid="team-prepared"
      data-state={v.ready ? 'ready' : v.add ? 'add' : 'prepared'}
      data-primary={v.primary ?? undefined}
    >
      <h2 id={`${ids}-title`} className="mb-1 text-sm font-semibold max-md:px-3">{heading}</h2>
      {(v.rows.length > 0 || v.files) && (
        <ul className="md:divide-y md:divide-line" data-testid="team-prepared-rows">
          {v.rows.map((s, i) => {
            const filled = v.primary === 'skill' && i === 0
            return phone ? (
              <li key={s.path} className="flex items-center" data-testid="team-prepared-skill" data-path={s.path} data-primary={filled || undefined}>
                {readOnly ? (
                  <div className="min-w-0 flex-1 px-3 py-1.5"><SkillText s={s} /></div>
                ) : (
                  <button type="button" onClick={() => tryIt(s)} aria-label={t('home.prepared.tryNamed', { title: s.title })} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-1.5 text-left transition hover:bg-hover" data-testid="team-prepared-try">
                    <SkillText s={s} />
                    {/* what the tap does, as the files row says 물어보기 */}
                    <span className={clsx('shrink-0 text-label font-medium', filled ? 'text-accent-text' : 'text-muted')} aria-hidden data-testid="team-prepared-try-label">{t('home.prepared.try')}</span>
                  </button>
                )}
                {example(s)}
              </li>
            ) : (
              <li key={s.path} className="flex min-h-11 items-center gap-3 py-1.5" data-testid="team-prepared-skill" data-path={s.path} data-primary={filled || undefined}>
                <span className="w-32 shrink-0 truncate text-sm font-medium text-ink" title={s.title}>{s.title}</span>
                <span className="min-w-0 flex-1 truncate text-label text-muted" title={s.summary}>{s.summary}</span>
                {example(s)}
                {!readOnly && (
                  <Button size="sm" variant={filled ? 'primary' : 'secondary'} onClick={() => tryIt(s)} aria-label={t('home.prepared.tryNamed', { title: s.title })} data-testid="team-prepared-try">
                    {t('home.prepared.try')}
                  </Button>
                )}
              </li>
            )
          })}
          {v.more > 0 && (
            <li className="md:py-1.5">
              <Link to="/skills" className="inline-flex min-h-11 items-center gap-0.5 rounded-lg text-label text-muted transition hover:text-ink max-md:px-3 md:min-h-8" data-testid="team-prepared-more">
                {t('home.prepared.more', { n: v.more })} <ChevronRight size={14} aria-hidden />
              </Link>
            </li>
          )}
          {v.files && (phone ? (
            <li data-testid="team-prepared-files" data-primary={v.primary === 'files' || undefined}>
              {readOnly ? (
                <p className="flex min-h-11 items-center px-3 text-sm"><span className="min-w-0 flex-1 truncate"><span className="font-medium text-ink">{t('home.prepared.files')}</span><span className="text-muted"> · {count(v.files)}</span></span></p>
              ) : (
                <button type="button" onClick={() => askFiles(v.files!)} aria-label={t('home.prepared.askNamed')} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm transition hover:bg-hover" data-testid="team-prepared-ask">
                  <span className="min-w-0 flex-1 truncate"><span className="font-medium text-ink">{t('home.prepared.files')}</span><span className="text-muted"> · {count(v.files)}</span></span>
                  <span className={clsx('shrink-0 text-label font-medium', v.primary === 'files' ? 'text-accent-text' : 'text-muted')} aria-hidden>{t('home.prepared.ask')}</span>
                </button>
              )}
            </li>
          ) : (
            <li className="flex min-h-11 items-center gap-3 py-1.5" data-testid="team-prepared-files" data-primary={v.primary === 'files' || undefined}>
              <span className="w-32 shrink-0 text-sm font-medium text-ink">{t('home.prepared.files')}</span>
              <span className="min-w-0 flex-1 truncate text-label text-muted" title={v.files.path}>{folderLabel(v.files.path, locale)} · {count(v.files)}</span>
              {!readOnly && (
                <Button size="sm" variant={v.primary === 'files' ? 'primary' : 'secondary'} onClick={() => askFiles(v.files!)} aria-label={t('home.prepared.askNamed')} data-testid="team-prepared-ask">
                  {t('home.prepared.ask')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {v.ready && <ReadyQuestion hasProfile={data.hasProfile} onCompose={onCompose} />}
      {v.add && (
        <p className="py-1.5 text-label text-muted max-md:px-3" data-testid="team-prepared-add">
          <Link to={SKILL_CATALOG} className={clsx(quietLink, 'touch-hit')} data-testid="team-prepared-add-skills">{t('home.prepared.addSkills')}</Link>
          <span aria-hidden> · </span>
          <Link to="/files" className={clsx(quietLink, 'touch-hit')} data-testid="team-prepared-add-files">{t('home.prepared.addFiles')}</Link>
        </p>
      )}
      {running && <SkillFormDialog path={running.path} onClose={() => setRunning(null)} />}
      {viewing?.example && <SkillExampleViewer skill={asCatalog(viewing)} onClose={() => setViewing(null)} returnTo={exampleButtons.current.get(viewing.path) ?? null} />}
    </section>
  )
}

/** A phone row's two lines: the title and its one line. */
function SkillText({ s }: { s: PreparedSkill }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium text-ink">{s.title}</span>
      <span className="block truncate text-label text-muted">{s.summary}</span>
    </span>
  )
}

/** The example viewer's skill (it shows a kept skill as the catalog lists it). */
const asCatalog = (s: PreparedSkill): Pick<PackCatalogSkill, 'name' | 'title' | 'description' | 'example' | 'locale' | 'source'> =>
  ({ name: s.name, title: s.title, description: s.summary, example: s.example ?? null, locale: s.locale ?? 'en', source: s.source ?? { kind: 'team' } })

/** "이렇게 시작해 보세요": one question that needs nothing from the team, filled (the person's first thing to press), and
 * under it the "no team folder" line when they can open none (their own folder and attachments still work). */
function ReadyQuestion({ hasProfile, onCompose }: { hasProfile: boolean; onCompose: (text: string) => void }) {
  const t = useT()
  const [noFolders, setNoFolders] = useState(false)
  useEffect(() => {
    let live = true
    visibleFolders(async (path) => (await api.call(API.tree, { query: { path, limit: 50 } })).entries, { skip: (p) => p === 'users' || p.startsWith('users/') }).then(
      (r) => live && setNoFolders(!r.length),
      () => {},
    )
    return () => { live = false }
  }, [])
  // a saved profile: what the company does (the prompt carries the profile); else what the AI can do for this team, which
  // needs no file at all (never a path such as "users/kim")
  const text = hasProfile ? t('home.prepared.profileAsk') : t('home.prepared.startAsk')
  return (
    <div className="space-y-2 py-1.5 max-md:px-3">
      {/* a question longer than a phone's line wraps inside the button (the Button's own nowrap and height give way) */}
      <Button variant="primary" className="h-auto! min-h-9 max-w-full justify-start py-2 text-left whitespace-normal! max-md:w-full" onClick={() => onCompose(text)} data-testid="team-prepared-ready">
        <ArrowUpLeft size={14} className="shrink-0" aria-hidden />
        <span className="min-w-0">{text}</span>
      </Button>
      {noFolders && <p className="text-label text-muted" data-testid="team-prepared-no-folders">{t('home.noFolders')}</p>}
    </div>
  )
}
