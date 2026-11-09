// "쓸 수 있는 스킬" on the Team skills page: every skill the person can use (GET /api/skills, the same list as the "/"
// menu: the team skills in the skills/ folders they can read, the skills of each of their groups in a section titled
// with the group's current name (docs/DECISIONS.md "Group skills"), and their own personal skills), the most used first
// (GET /api/skills/popular: the top 10 of the last 30 days have a count). A row is one line of text: clicking it starts
// a chat with the skill, and its "…" menu also opens the file. The whole description is the row's tooltip. The same
// read-only list for members and admins; what only skill managers and admins do (review suggestions, recent changes)
// stays in the page's other tabs. A chat starts from the skill's name, so of two skills with one name the server picks
// (server/src/chat/skills.ts). A skill with a form (metadata `inputs`) opens it instead (skills/SkillForm.tsx), from
// the row, its run button and its menu.
// Under the lists (docs/DECISIONS.md "W6"; FLOW-v6 §4.2, §6): for owners and admins, the kept skills the team does not
// have, folded in one line ("트리나가 준비한 스킬 · N개 더": components/skills/PackRows.tsx), nothing pre-checked,
// [팀에 넣기 · n개] (the rows then move up into the list); hidden while the search box has text, absent when nothing is
// missing, and a skill shipped later only raises its count (no notice, dot or prompt). "스킬 넣기" (Home's block, the
// empty-team line, the goal card) comes with it unfolded (/skills?catalog=open, lib/nav.ts SKILL_CATALOG). Then "내 스킬 가져오기" for
// everyone on a computer: owners and admins pick a folder and apply it (skills/BringSkillsSheet.tsx), members suggest
// (skills/ContributeSheet.tsx: 스킬로 제안); on a phone one plain line says it is done on a computer. Nothing adds a skill
// by itself (docs/DECISIONS.md "DS3").
import clsx from 'clsx'
import { ChevronDown, ChevronRight, FileText, FolderUp, MessageSquarePlus, MoreHorizontal, Play, ScrollText, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { skillSummary, type SkillInfo } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { answersFileInputs } from '../lib/desktop'
import { canPickHandle, canPickInput } from '../lib/skillScan'
import { navigateTo } from '../lib/nav'
import { namedProduct } from '../lib/tabs'
import { parentPath } from '../lib/paths'
import { isSkillsPath } from '../lib/skillIssues'
import { useT } from '../i18n'
import { accessChanged, filesChanged, reloadAsked, skillsChanged } from '../store/live'
import { isAdmin, useMe } from '../store/session'
import { toast } from '../store/ui'
import { skillPrompt } from './PopularSkills'
import { BringSkillsSheet } from './skills/BringSkillsSheet'
import { ContributeSheet } from './skills/ContributeSheet'
import { installPacks, PackNotes, PackRows, usePackCatalog, type PackInstallOutcome } from './skills/PackRows'
import { SkillFormDialog } from './skills/SkillForm'
import { Button, EmptyState, ErrorNote, IconButton, Skeleton, useMediaQuery } from './ui'

type Skill = SkillInfo & { uses?: number }

/** The skill's file in Files (its folder, the file selected). */
export const skillFileLink = (path: string) => `/files?path=${encodeURIComponent(parentPath(path))}&select=${encodeURIComponent(path)}`
/** A new chat with "/<name> " in the message box. */
export const skillChatLink = (name: string) => `/?prompt=${encodeURIComponent(skillPrompt(name))}`

/** The folder of a team or group skill below its skills root, when it sits in a subfolder ("general" for
 * skills/general/intro-deck/SKILL.md; "" for skills/x.md and skills/x/SKILL.md): the one place a path still helps a
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

/** `query`: the page's search box, matched against the name and the description. `catalogOpen`: the ready-made skills'
 * fold starts open ("스킬 넣기" led here). */
export function AvailableSkills({ query, catalogOpen }: { query: string; catalogOpen?: boolean }) {
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
  return <AvailableSkillsList items={items} query={query} catalogOpen={catalogOpen} />
}

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
export function AvailableSkillsList({ items, query = '', catalogOpen = false }: { items: Skill[] | null; query?: string; catalogOpen?: boolean }) {
  const t = useT()
  const admin = isAdmin(useMe())
  const [running, setRunning] = useState<Skill | null>(null)
  if (!items) return <Skeleton lines={3} />
  const q = query.trim().toLowerCase()
  // the kept skills the team lacks and the way to bring one's own, under the lists; the catalog hides while searching
  const below = (
    <div className="space-y-1" data-testid="skill-below">
      {admin && !q && <PackCatalogFold startOpen={catalogOpen} />}
      <BringOwnLine />
    </div>
  )
  if (!items.some((s) => !s.shadowedBy)) return <div className="space-y-6"><NoSkills />{below}</div>
  // a skill another one of its name replaced is not in the lists below, and not in the counts: its own section
  const shown = q ? items.filter((s) => `${s.name} ${s.title ?? ''} ${s.description}`.toLowerCase().includes(q)) : items
  if (!shown.length) return <div className="space-y-6"><EmptyState icon={<Sparkles size={22} />} title={t('skills.noMatch', { q: query.trim() })} />{below}</div>
  const hidden = shown.filter((s) => s.shadowedBy)
  return (
    <div className="space-y-6">
      <div className="space-y-6" data-testid="skill-list">
        <SkillSection title={t('skills.fromTeam')} items={shown.filter((s) => !s.personal && !s.group && !s.shadowedBy)} folders={admin} onRun={setRunning} />
        {skillGroups(shown.filter((s) => !s.shadowedBy)).map((g) => (
          <SkillSection key={g.id} title={t('skills.fromGroup', { group: g.name })} items={shown.filter((s) => s.group?.id === g.id && !s.shadowedBy)} folders={admin} onRun={setRunning} testId={`skill-group-${g.id}`} />
        ))}
        <SkillSection title={t('skills.personal')} items={shown.filter((s) => s.personal)} folders={admin} onRun={setRunning} />
        <SkillSection title={t('skills.shadowedTitle')} items={hidden} folders={admin} onRun={setRunning} testId="skill-shadowed" />
      </div>
      {below}
      {running && <SkillFormDialog path={running.path} skill={running} onClose={() => setRunning(null)} />}
    </div>
  )
}

/** A phone (or a browser that cannot pick folders): skills from Claude Code or Codex go in on a computer. */
function usePicksFolders(): boolean {
  const narrow = useMediaQuery('(max-width: 767.98px)')
  return !narrow && (answersFileInputs() || canPickHandle() || canPickInput())
}

/** "트리나가 준비한 스킬 · N개 더" (owners and admins): the kept skills the team does not have, folded; open, nothing is
 * checked, and [팀에 넣기 · n개] installs what is (the brand action runs first on the server). The rows that went in
 * leave this list for the one above. Absent when nothing is missing; the line says so when the catalog does not load. */
function PackCatalogFold({ startOpen = false }: { startOpen?: boolean }) {
  const t = useT()
  const { catalog, failed, reload } = usePackCatalog()
  const [open, setOpen] = useState(startOpen)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<PackInstallOutcome | null>(null)
  if (failed && !catalog) return <div data-testid="skill-catalog-failed"><ErrorNote onRetry={reload}>{t('skillPack.loadFailed')}</ErrorNote></div>
  if (!catalog) return null
  const missing = catalog.skills.filter((s) => !s.inTeam)
  if (!missing.length) return null
  const chosen = missing.filter((s) => checked.has(s.name))
  const install = async (items = chosen) => {
    setBusy(true)
    try {
      const r = await installPacks(items)
      setOutcome(r)
      setChecked((x) => { const next = new Set(x); for (const s of items) if (!r.failed.includes(s.name)) next.delete(s.name); return next })
      if (r.went.length) toast({ level: r.taken.length || r.blocked.length || r.failed.length ? 'warn' : 'success', text: t('skillPack.installed', { n: r.went.length }) })
    } finally {
      setBusy(false)
    }
  }
  const retry = () => { const items = missing.filter((s) => outcome?.failed.includes(s.name)); if (items.length) void install(items) }
  return (
    <section aria-labelledby="skill-catalog-title" data-testid="skill-catalog" data-open={open || undefined}>
      <button
        type="button"
        id="skill-catalog-title"
        className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-1.5 rounded-lg px-2 py-2 text-left text-sm font-medium md:hover:bg-hover"
        aria-expanded={open}
        aria-controls="skill-catalog-rows"
        onClick={() => setOpen((x) => !x)}
        data-testid="skill-catalog-toggle"
      >
        <span className="min-w-0 flex-1">{t('skills.catalog.more', { ...namedProduct(t), n: missing.length })}</span>
        <ChevronDown size={16} className={clsx('shrink-0 text-faint transition', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div id="skill-catalog-rows" className="space-y-3">
          <PackRows items={missing} checked={checked} onToggle={(name, on) => setChecked((x) => { const next = new Set(x); if (on) next.add(name); else next.delete(name); return next })} outcome={outcome} disabled={busy} />
          <PackNotes outcome={outcome} onRetry={busy ? undefined : retry} />
          <div className="flex items-center gap-2">
            <Button variant="primary" busy={busy} disabled={!chosen.length} onClick={() => void install()} data-testid="skill-catalog-install">{t('skills.catalog.install', { n: chosen.length })}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy} data-testid="skill-catalog-fold">{t('skills.catalog.fold')}</Button>
          </div>
        </div>
      )}
    </section>
  )
}

/** "내 스킬 가져오기", everyone on a computer: owners and admins bring a folder in (it applies), members suggest it. A
 * phone: one plain line, no button. */
function BringOwnLine() {
  const t = useT()
  const me = useMe()
  const admin = isAdmin(me)
  const computer = usePicksFolders()
  const [open, setOpen] = useState(false)
  if (!me) return null
  if (!computer) return <p className="text-label text-muted" data-testid="skill-bring-phone">{t('skills.catalog.bringPhone')}</p>
  return (
    <>
      <button
        type="button"
        className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium md:hover:bg-hover"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        data-testid="skill-bring"
        data-role={admin ? 'admin' : 'member'}
      >
        <FolderUp size={16} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">{t('skills.catalog.bring')}</span>
        <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
      </button>
      {open && (admin ? <BringSkillsSheet team={me.team.name} onClose={() => setOpen(false)} /> : <ContributeSheet folder={null} onClose={() => setOpen(false)} />)}
    </>
  )
}

/** No skill yet: owners and admins read so (the catalog below has the kept skills); members learn that the owner or an
 * admin puts them in, and how a suggestion gets there. */
function NoSkills() {
  const t = useT()
  const admin = isAdmin(useMe())
  return (
    <EmptyState icon={<Sparkles size={22} />} title={t(admin ? 'skills.noSkills' : 'skills.catalog.memberEmpty')}>
      {!admin && <p data-testid="skill-none-member">{t('skills.noSkillsHint')}</p>}
    </EmptyState>
  )
}

/** `folders`: each team skill's folder before its line ("skills/general/ · …"), for owners and admins, who manage the
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
  // a replaced skill is never run from here (a chat with its name runs the one that replaced it, and its form would
  // send that name too): its row opens the file, the details
  const use = () => (s.shadowedBy ? navigateTo(skillFileLink(s.path)) : s.inputs?.length ? onRun(s) : navigateTo(skillChatLink(s.name)))
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
            <span className="truncate" data-testid="skill-name">{shown}</span>
            {title && <span className="shrink-0 font-mono text-xs font-normal text-faint" data-testid="skill-command">{command}</span>}
          </span>
          {shadow && <span className="mt-0.5 block truncate text-xs text-faint" data-testid="skill-shadow-note">{shadow}</span>}
          {line && <span className="mt-0.5 block truncate text-xs text-muted">{line}</span>}
        </span>
        {!!s.uses && <span className="shrink-0 text-xs text-faint tabular-nums" title={t('skills.usesHint')}>{t('skills.uses', { uses: s.uses })}</span>}
        {!s.shadowedBy && <span className="sr-only">{t('skills.use')}</span>}
      </button>
      {!!s.inputs?.length && !s.shadowedBy && (
        <IconButton label={t('skillForm.runNamed', { name: shown })} onClick={() => onRun(s)} data-testid="skill-run">
          <Play size={16} aria-hidden />
        </IconButton>
      )}
      <SkillMenu skill={s} onUse={s.shadowedBy ? null : use} />
    </li>
  )
}

function SkillMenu({ skill: s, onUse }: { skill: Skill; onUse: (() => void) | null }) {
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
          {onUse && (
            <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onUse() }}>
              <MessageSquarePlus size={14} aria-hidden /> {t('skills.use')}
            </button>
          )}
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
