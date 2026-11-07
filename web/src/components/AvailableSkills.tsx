// "쓸 수 있는 스킬" on the Team skills page: every skill the person can use (GET /api/skills, the same list as the "/"
// menu: the team skills in the skills/ folders they can read, the skills of each of their groups in a section titled
// with the group's current name (docs/DECISIONS.md "Group skills"), and their own personal skills), the most used first
// (GET /api/skills/popular: the top 10 of the last 30 days have a count). A row is one line of text: clicking it starts
// a chat with the skill, and its "…" menu also opens the file. The whole description is the row's tooltip. The same
// read-only list for members and admins; what only skill managers and admins do (review suggestions, recent changes)
// stays in the page's other tabs. A chat starts from the skill's name, so of two skills with one name the server picks
// (server/src/chat/skills.ts). A skill with a form (metadata `inputs`) opens it instead (skills/SkillForm.tsx), from
// the row, its run button and its menu. With no skill at all, owners and admins can install the recommended pack in
// one click (POST /api/onboarding/packs/marketing/install); members read that an admin can. A team that has skills but
// none under skills/marketing/ (every team that walked the welcome steps has the general pack) gets one quiet line under
// the list for owners and admins: "마케팅 스킬 7개 넣기", the same install on a click. The optional packs, which the server
// never adds by itself (OPTIONAL_SKILL_PACKS: hr), get the same kind of line while none of their skills is in the team:
// "인사 서류 스킬 3개 넣기".
import clsx from 'clsx'
import { FileText, MessageSquarePlus, MoreHorizontal, PackagePlus, Play, ScrollText, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { HR_PACK_SKILLS, skillSummary, WELCOME_PACK_SKILLS, type SkillInfo, type SkillPackId } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { navigateTo } from '../lib/nav'
import { parentPath } from '../lib/paths'
import { isSkillsPath } from '../lib/skillIssues'
import { useLocale, useT } from '../i18n'
import { accessChanged, filesChanged, reloadAsked, skillsChanged } from '../store/live'
import { isAdmin, useMe } from '../store/session'
import { toast } from '../store/ui'
import { skillPrompt } from './PopularSkills'
import { SkillFormDialog } from './skills/SkillForm'
import { Button, EmptyState, ErrorNote, IconButton, Skeleton } from './ui'

type Skill = SkillInfo & { uses?: number }

/** The skill's file in Files (its folder, the file selected). */
export const skillFileLink = (path: string) => `/files?path=${encodeURIComponent(parentPath(path))}&select=${encodeURIComponent(path)}`
/** A new chat with "/<name> " in the message box. */
export const skillChatLink = (name: string) => `/?prompt=${encodeURIComponent(skillPrompt(name))}`

/** The folder of a team or group skill below its skills root, when it sits in a subfolder ("marketing" for
 * skills/marketing/ad-copy/SKILL.md; "" for skills/x.md and skills/x/SKILL.md): the one place a path still helps a
 * person who manages the folders. The full path is in the row's "…" menu. */
export const skillSubfolder = (path: string) => {
  const root = /^(skills\/|groups\/[^/]+\/skills\/)/.exec(path)
  if (!root) return ''
  const dirs = path.slice(root[0].length).split('/')
  dirs.pop()
  if (path.endsWith('/SKILL.md')) dirs.pop()
  return dirs.join('/')
}

/** What people type for a skill, and read as its name: its title with "/name" beside it, else "/name" alone (the "/"
 * menu shows the same). Never the folder name turned into words. */
const skillShown = (s: Pick<SkillInfo, 'name' | 'title'>) => { const title = s.title?.trim(); return title && title !== s.name ? title : null }

/** `query`: the page's search box, matched against the name and the description. */
export function AvailableSkills({ query }: { query: string }) {
  const t = useT()
  const [items, setItems] = useState<Skill[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true, generation = 0
    const load = () => {
      const g = ++generation
      // the counts are a bonus: the list still shows when they don't load
      Promise.all([api.call(API.listSkills, { query: { shadowed: '1' } }), api.call(API.popularSkills).catch(() => null)]).then(
        ([list, popular]) => {
          if (!active || g !== generation) return
          const uses = new Map(popular?.items.map((p) => [p.path, p.uses]))
          setItems(list.items.map((s) => ({ ...s, uses: uses.get(s.path) ?? 0 })).sort((a, b) => b.uses - a.uses))
          setFailed(false)
        },
        () => { if (active && g === generation) setFailed(true) },
      )
    }
    load()
    const offs = [
      accessChanged.on(load), skillsChanged.on(load), reloadAsked.on(load),
      filesChanged.on((changes) => { if (changes.some((c) => isSkillsPath(c.path) || (c.from && isSkillsPath(c.from)))) load() }),
    ]
    return () => { active = false; for (const off of offs) off() }
  }, [attempt])
  // never "no skills" for a list that did not load
  if (failed && !items) return <ErrorNote onRetry={() => { setFailed(false); setAttempt((n) => n + 1) }}>{t('error.network')}</ErrorNote>
  return <AvailableSkillsList items={items} query={query} />
}

/** The marketing pack's skills live here (the server installs a pack under skills/<id>/). */
const MARKETING_FOLDER = `skills/${'marketing' satisfies SkillPackId}/`
/** The optional HR pack's skills live here. */
const HR_FOLDER = `skills/${'hr' satisfies SkillPackId}/`

/** The groups of `items`' group skills, one each, by name (letter case ignored) then id: the server's order
 * (server/src/chat/skills.ts groupOrder). A group with no skill the person can use is not there. */
export function skillGroups(items: readonly Skill[]): { id: string; name: string }[] {
  const by = new Map<string, { id: string; name: string }>()
  for (const s of items) if (s.group && !by.has(s.group.id)) by.set(s.group.id, s.group)
  const key = (n: string) => n.normalize('NFC').toLowerCase()
  return [...by.values()].sort((a, b) => (key(a.name) < key(b.name) ? -1 : key(a.name) > key(b.name) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The list without the data load (null: still loading). The team's skills, then one section for each of the person's
 * groups that has skills (titled with the group's current name), then the personal skills. */
export function AvailableSkillsList({ items, query = '' }: { items: Skill[] | null; query?: string }) {
  const t = useT()
  const admin = isAdmin(useMe())
  const [running, setRunning] = useState<Skill | null>(null)
  if (!items) return <Skeleton lines={3} />
  if (!items.some((s) => !s.shadowedBy)) return <NoSkills />
  const q = query.trim().toLowerCase()
  // a skill another one of its name replaced is not in the lists below, and not in the counts: its own section
  const shown = q ? items.filter((s) => `${s.name} ${s.title ?? ''} ${s.description}`.toLowerCase().includes(q)) : items
  if (!shown.length) return <EmptyState icon={<Sparkles size={22} />} title={t('skills.noMatch', { q: query.trim() })} />
  // no marketing skill in the team yet: owners and admins can add the pack (not while searching)
  const hidden = shown.filter((s) => s.shadowedBy)
  const offerMarketing = admin && !q && !items.some((s) => !s.personal && s.path.startsWith(MARKETING_FOLDER))
  const offerHr = admin && !q && !items.some((s) => !s.personal && s.path.startsWith(HR_FOLDER))
  return (
    <div className="space-y-6" data-testid="skill-list">
      <SkillSection title={t('skills.fromTeam')} items={shown.filter((s) => !s.personal && !s.group && !s.shadowedBy)} folders={admin} onRun={setRunning} />
      {skillGroups(shown.filter((s) => !s.shadowedBy)).map((g) => (
        <SkillSection key={g.id} title={t('skills.fromGroup', { group: g.name })} items={shown.filter((s) => s.group?.id === g.id && !s.shadowedBy)} folders={admin} onRun={setRunning} testId={`skill-group-${g.id}`} />
      ))}
      <SkillSection title={t('skills.personal')} items={shown.filter((s) => s.personal)} folders={admin} onRun={setRunning} />
      <SkillSection title={t('skills.shadowedTitle')} items={hidden} folders={admin} onRun={setRunning} testId="skill-shadowed" />
      {offerMarketing && <MarketingPackLine />}
      {offerHr && <HrPackLine />}
      {running && <SkillFormDialog path={running.path} skill={running} onClose={() => setRunning(null)} />}
    </div>
  )
}

/** Install a pack (the marketing pack unless said) on a click and say what happened (only what is missing goes in;
 * nothing is replaced). */
function usePackInstall(id: SkillPackId = 'marketing') {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const install = async () => {
    setBusy(true)
    try {
      const r = await api.call(API.installSkillPack, { params: { id } })
      const created = r.skills.filter((s) => s.status === 'created').length
      const blocked = r.skills.filter((s) => s.status === 'blocked').length
      toast({ level: blocked ? 'warn' : 'success', text: [created ? t('skillPack.installed', { n: created }) : t('skillPack.already'), blocked ? t('skillPack.blocked', { n: blocked }) : ''].filter(Boolean).join(' ') })
      skillsChanged.emit()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  return { busy, install }
}

/** Under the list, one quiet text button: "마케팅 스킬 7개 넣기" (what goes in is its tooltip). */
function MarketingPackLine() {
  const t = useT()
  const { busy, install } = usePackInstall()
  return (
    <p className="text-[0.8125rem]">
      <button type="button" className="font-medium text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink disabled:opacity-50"
        title={t('skillPack.adminHint')} disabled={busy} onClick={() => void install()} data-testid="skill-pack-marketing">
        {t('skillPack.addMarketing', { n: WELCOME_PACK_SKILLS })}
      </button>
    </p>
  )
}

/** Under the list, one quiet text button: "인사 서류 스킬 3개 넣기" (the optional HR pack; what goes in is its tooltip). */
function HrPackLine() {
  const t = useT()
  const { busy, install } = usePackInstall('hr')
  return (
    <p className="text-[0.8125rem]">
      <button type="button" className="font-medium text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink disabled:opacity-50"
        title={t('skillPack.hrHint')} disabled={busy} onClick={() => void install()} data-testid="skill-pack-hr">
        {t('skillPack.addHr', { n: HR_PACK_SKILLS })}
      </button>
    </p>
  )
}

/** No skill yet: owners and admins install the recommended pack here; members learn that an admin can. */
function NoSkills() {
  const t = useT()
  const admin = isAdmin(useMe())
  const { busy, install } = usePackInstall()
  return (
    <EmptyState icon={<Sparkles size={22} />} title={t('skills.noSkills')}>
      {admin ? (
        <div className="flex flex-col items-center gap-3" data-testid="skill-pack-offer">
          <p>{t('skillPack.adminHint')}</p>
          <Button variant="primary" busy={busy} onClick={() => void install()} data-testid="skill-pack-install">
            <PackagePlus size={14} aria-hidden /> {t('skillPack.install')}
          </Button>
        </div>
      ) : (
        <>
          <p data-testid="skill-pack-member">{t('skillPack.memberHint')}</p>
          <p className="mt-1">{t('skills.noSkillsHint')}</p>
        </>
      )}
    </EmptyState>
  )
}

/** `folders`: each team skill's folder before its line ("skills/marketing/ · …"), for owners and admins, who manage the
 * folders; a member reads the title and the line only (a raw path told them nothing: docs/DECISIONS.md "W3"). */
function SkillSection({ title, items, folders, onRun, testId }: { title: string; items: Skill[]; folders: boolean; onRun: (s: Skill) => void; testId?: string }) {
  if (!items.length) return null
  return (
    <section aria-label={title} data-testid={testId}>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium">
        {title}
        {/* phones: the count as plain text, no pill */}
        <span className="rounded-full bg-subtle px-1.5 text-xs text-muted tabular-nums max-md:bg-transparent max-md:px-0 max-md:font-normal" data-testid="skill-count">{items.length}</span>
      </h2>
      <ul className="-mx-2 divide-y divide-line">
        {items.map((s) => <SkillRow key={s.path} skill={s} folder={folders} onRun={onRun} />)}
      </ul>
    </section>
  )
}

function SkillRow({ skill: s, folder, onRun }: { skill: Skill; folder: boolean; onRun: (s: Skill) => void }) {
  const t = useT()
  // the name people type ("/estimate-docs"), with its title before it when the skill has one; the description
  // without a lead that repeats the title. No path here: the "…" menu has it (a subfolder stays as a short hint).
  const title = skillShown(s)
  const command = `/${s.name}`
  const shown = title ?? command
  // a skill a member suggested keeps their name (docs/DECISIONS.md "MC")
  const sub = s.personal || !folder ? '' : skillSubfolder(s.path)
  const line = [sub, s.suggestedBy ? t('skills.suggestedBy', { name: s.suggestedBy }) : '', skillSummary(s)].filter(Boolean).join(' · ')
  // a skill another one of its name replaced: which one runs instead
  const shadow = s.shadowedBy ? (s.shadowedBy.tier === 'personal' ? t('skills.shadowedByPersonal') : t('skills.shadowedByGroup', { group: s.shadowedBy.group?.name ?? '' })) : ''
  // a skill with a form opens it; any other starts a chat with "/<name> " in the message box, as before
  const use = () => (s.inputs?.length ? onRun(s) : navigateTo(skillChatLink(s.name)))
  return (
    <li className={clsx('flex items-center gap-1 py-1', s.shadowedBy && 'opacity-70')} data-testid="skill-row" data-path={s.path} data-shadowed={s.shadowedBy ? s.shadowedBy.tier : undefined}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left hover:bg-hover"
        title={s.description || shown}
        onClick={use}
        data-testid="skill-use"
      >
        {/* phones: the icon alone, no framed tile on every row */}
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted max-md:size-5 max-md:border-0 max-md:bg-transparent">
          <ScrollText size={16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5 text-sm font-medium">
            <span className={clsx('truncate', !title && 'font-mono')} data-testid="skill-name">{shown}</span>
            {title && <span className="shrink-0 font-mono text-xs font-normal text-faint" data-testid="skill-command">{command}</span>}
          </span>
          {shadow && <span className="mt-0.5 block truncate text-xs text-faint" data-testid="skill-shadow-note">{shadow}</span>}
          {line && <span className="mt-0.5 block truncate text-xs text-muted">{line}</span>}
        </span>
        {!!s.uses && <span className="shrink-0 text-xs text-faint tabular-nums" title={t('skills.usesHint')}>{t('skills.uses', { uses: s.uses })}</span>}
        <span className="sr-only">{t('skills.use')}</span>
      </button>
      {!!s.inputs?.length && (
        <IconButton label={t('skillForm.runNamed', { name: shown })} onClick={() => onRun(s)} data-testid="skill-run">
          <Play size={16} aria-hidden />
        </IconButton>
      )}
      <SkillMenu skill={s} onUse={use} />
    </li>
  )
}

function SkillMenu({ skill: s, onUse }: { skill: Skill; onUse: () => void }) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const menuItems = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus()
    // not on losing focus: Safari moves focus off a button when it is pressed, and the click would find the menu gone
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation() // only the menu: not an open file or browser panel too (Layout)
      setOpen(false)
      box.current?.querySelector('button')?.focus() // Tab then moves on from the "…" button
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = menuItems()
      const at = items.indexOf(document.activeElement as HTMLElement)
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }
  }
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm -outline-offset-2 hover:bg-hover focus:bg-hover'
  return (
    <div ref={box} className="relative shrink-0" onKeyDown={onKeyDown}>
      <IconButton label={t('skills.moreNamed', { name: skillShown(s) ?? `/${s.name}` })} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="skill-more">
        <MoreHorizontal size={16} aria-hidden />
      </IconButton>
      {open && (
        <div role="menu" aria-label={t('skills.moreNamed', { name: skillShown(s) ?? `/${s.name}` })} className="absolute top-full right-0 z-30 mt-1 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onUse() }}>
            <MessageSquarePlus size={14} aria-hidden /> {t('skills.use')}
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => navigateTo(skillFileLink(s.path))} data-testid="skill-file">
            <FileText size={14} aria-hidden /> {t('skills.viewFile')}
          </button>
          {/* where the file is, for people who manage skills (the row itself keeps to the name and the description) */}
          <p className="mt-1 border-t border-line px-2 pt-1.5 pb-1 font-mono text-micro break-all text-faint" title={t('skills.pathLine', { path: s.path })} data-testid="skill-path">{s.path}</p>
        </div>
      )}
    </div>
  )
}
