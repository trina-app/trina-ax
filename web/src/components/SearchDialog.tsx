// ⌘/Ctrl+K: one place to find the team's own things, like Claude's search. Type tabs (all, chats, projects, files,
// skills, scheduled, MCP); with no text it shows what needs attention, recent chats and projects, and actions (the
// inbox among them, with its unread count).
// Chats are searched on the server by title and content (GET /api/chats?q=). Projects, skills, scheduled tasks and MCP
// connections come from the lists the app already reads and are matched here by name (a scheduled task also by its
// instruction, and then the row shows the matching part of it, so the match is not hidden). Files: file names are
// searched on the server (GET /api/files/find); the dialog does not search file contents itself, so a key press starts
// no content search (R2-ETC-02); its last row opens the file screen's content search with the same text.
import clsx from 'clsx'
import { Bell, BookMarked, Cable, CalendarClock, CalendarPlus, CornerDownLeft, File as FileIcon, FileSearch, Folder, FolderKanban, FolderOpen, FolderPlus, MessageSquare, MessageSquarePlus, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { skillTitle, type Chat, type FileEntry, type Integration, type Project, type Schedule } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { platform } from '../lib/pwa'
import { scheduleName } from '../lib/scheduleText'
import { useLocale, useT, type MessageKey } from '../i18n'
import { useUi } from '../store/ui'
import { useEdgeFade, useFocusTrap } from './ui'
import { contentQueryReady } from './FileContentSearch'
import { skillFileLink } from './AvailableSkills'
import { useChatActions } from './chat/chatActions'

export default function SearchDialog() {
  const open = useUi((s) => s.searchOpen)
  const setOpen = useUi((s) => s.setSearchOpen)
  if (!open) return null
  return <SearchBox onClose={() => setOpen(false)} />
}

export const SEARCH_TABS = ['all', 'chats', 'projects', 'files', 'skills', 'scheduled', 'mcp'] as const
export type SearchTab = (typeof SEARCH_TABS)[number]
const TAB_LABEL: Record<SearchTab, MessageKey> = {
  all: 'search.tab.all', chats: 'search.tab.chats', projects: 'search.tab.projects', files: 'search.tab.files',
  skills: 'search.tab.skills', scheduled: 'search.tab.scheduled', mcp: 'search.tab.mcp',
}

type Kind = 'chat' | 'project' | 'file' | 'skill' | 'schedule' | 'mcp' | 'action'
interface Row {
  key: string
  kind: Kind
  title: string
  /** dim second part: where it is (project, folder) or why it needs attention */
  sub?: string
  attention?: boolean
  /** highlight the typed text in the title */
  match?: boolean
  /** highlight the typed text in the second part too (the part of an instruction that matched) */
  subMatch?: boolean
  /** more words the typed text may match (an action's other name) */
  terms?: string
  icon: typeof MessageSquare
  href: string
  chat?: Chat
}
interface Section { id: string; label: string; rows: Row[] }
interface Skill { path: string; name: string; description: string; title?: string }

const onMac = () => platform() === 'mac' || platform() === 'ios'
const norm = (s: string) => s.toLocaleLowerCase()
const has = (q: string, ...xs: (string | null | undefined)[]) => xs.some((x) => !!x && norm(x).includes(q))
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')
/** The part of a long text around the first match, on one line: "…every Monday, summarise the weekly notes…". */
export function snippetAround(text: string, q: string, before = 24, after = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const i = norm(flat).indexOf(q)
  if (i < 0) return ''
  const from = Math.max(0, i - before), to = Math.min(flat.length, i + q.length + after)
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`
}

/** The lists Search reads once when it opens; null while loading, 'error' when one could not be read. */
function useList<T>(load: () => Promise<T>): T | null | 'error' {
  const [v, setV] = useState<T | null | 'error'>(null)
  useEffect(() => {
    let live = true
    load().then((x) => live && setV(x), () => live && setV('error'))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return v
}
const ok = <T,>(v: T | null | 'error'): T | null => (v === 'error' ? null : v)
/** What a task's search may match besides its name: a task's own instruction. A template's prompt is the server's own
 *  and never shown, so it is not searched. */
const scheduleText = (s: Schedule) => (s.templateId ? '' : s.prompt)

function SearchBox({ onClose }: { onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const chatActions = useChatActions()
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<SearchTab>('all')
  const [sel, setSel] = useState(0)
  const [menu, setMenu] = useState<{ row: Row; top: number } | null>(null)
  const [found, setFound] = useState<Chat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // files whose name contains the text (null while it loads or with no text), and whether that search failed
  const [names, setNames] = useState<FileEntry[] | null>(null)
  const [namesFailed, setNamesFailed] = useState(false)
  // Esc closes an open row menu first, then the dialog
  useFocusTrap(ref, true, () => (menu ? closeMenu() : onClose()))

  const recent = useList(() => api.call(API.listChats, { query: { limit: 30 } }).then((p) => p.items))
  const projects = useList(() => api.call(API.listProjects).then((r) => r.items))
  const skills = useList<Skill[]>(() => api.call(API.listSkills).then((r) => r.items))
  const schedules = useList(() => api.call(API.listSchedules).then((r) => r.items))
  const mcp = useList(() => api.call(API.listIntegrations))
  const unread = useList(() => api.call(API.listNotifications, { query: { limit: 1 } }).then((r) => r.unreadCount))

  const query = norm(q.trim())
  // chats by title and content, on the server
  useEffect(() => {
    if (!query) {
      setFound(null)
      setError(null)
      return
    }
    let live = true
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const page = await api.call(API.listChats, { query: { q: q.trim(), limit: 30 }, signal: ctrl.signal })
        if (live) {
          setFound(page.items)
          setError(null)
        }
      } catch (e) {
        if (live && !ctrl.signal.aborted) setError(errorText(e, locale, t('error.network')))
      }
    }, 200)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  // files by name, on the server, only where file rows are shown
  const wantNames = !!query && (tab === 'all' || tab === 'files')
  useEffect(() => {
    setNames(null)
    setNamesFailed(false)
    if (!wantNames) return
    let live = true
    const timer = setTimeout(() => {
      api.call(API.findFiles, { query: { q: q.trim(), path: '', limit: 30 } }).then(
        (r) => live && setNames(r.items),
        () => {
          if (!live) return
          setNames([])
          setNamesFailed(true)
        },
      )
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, wantNames])

  const projectName = useMemo(() => new Map((ok(projects) ?? []).map((p) => [p.id, p.name])), [projects])
  const chatRow = (c: Chat, attention?: string): Row => ({
    key: `chat:${c.id}`, kind: 'chat', icon: MessageSquare, title: c.title || t('chat.untitled'), href: `/c/${c.id}`, chat: c,
    sub: attention ?? (c.projectId ? projectName.get(c.projectId) : undefined), attention: !!attention, match: true,
  })
  const projectRow = (p: Project): Row => ({ key: `project:${p.id}`, kind: 'project', icon: FolderKanban, title: p.name, sub: p.folderPath, href: `/projects/${p.id}`, match: true })
  const skillRow = (s: Skill): Row => ({ key: `skill:${s.path}`, kind: 'skill', icon: BookMarked, title: skillTitle(s), sub: parentOf(s.path), href: skillFileLink(s.path), match: true })
  /** A task's name as the Scheduled page shows it. When the typed text is only in its instruction (hidden in the list),
   *  the second part shows that part of the instruction, highlighted, so the row does not look like a wrong result. */
  const scheduleRow = (s: Schedule, attention?: string): Row => {
    const title = scheduleName(s, t)
    const inInstruction = !attention && !!query && !has(query, title) ? snippetAround(scheduleText(s), query) : ''
    return {
      key: `schedule:${s.id}`, kind: 'schedule', icon: CalendarClock, title, href: `/scheduled/${encodeURIComponent(s.id)}`, match: true,
      sub: attention ?? (inInstruction ? t('search.inInstruction', { text: inInstruction }) : s.projectId ? projectName.get(s.projectId) : undefined),
      subMatch: !!inInstruction, attention: !!attention,
    }
  }
  const mcpRow = (i: Integration, attention?: string): Row => ({
    key: `mcp:${i.id}`, kind: 'mcp', icon: Cable, title: i.name, href: '/settings/integrations', match: true,
    sub: attention ?? (i.scope === 'team' ? t('search.team') : undefined), attention: !!attention,
  })
  const fileNameRow = (f: FileEntry): Row => ({
    key: `file:${f.path}`, kind: 'file', icon: f.type === 'folder' ? Folder : FileIcon, title: f.name, sub: parentOf(f.path), match: true,
    href: f.type === 'folder' ? `/files?path=${encodeURIComponent(f.path)}` : skillFileLink(f.path),
  })
  const filesRow = (): Row => ({ key: 'files', kind: 'file', icon: FileSearch, title: t('search.inFiles', { q: q.trim() }), href: `/files?q=${encodeURIComponent(q.trim())}` })

  const actions: Row[] = useMemo(() => {
    const list: Row[] = [
      { key: 'act:chat', kind: 'action', icon: MessageSquarePlus, title: t('sidebar.newChat'), href: '/' },
      { key: 'act:project', kind: 'action', icon: FolderPlus, title: t('projects.new'), href: '/projects?new=1' },
      { key: 'act:schedule', kind: 'action', icon: CalendarPlus, title: t('search.newScheduled'), href: '/scheduled' },
    ]
    const m = ok(mcp)
    if (m?.personalAllowed) list.push({ key: 'act:mcp', kind: 'action', icon: Plus, title: t('search.addMcp'), href: '/settings/integrations?add=1' })
    list.push({ key: 'act:files', kind: 'action', icon: FolderOpen, title: t('search.openFiles'), href: '/files' })
    // the inbox lives in Settings > Notifications; unread notifications show as a count and an attention dot
    const n = ok(unread) ?? 0
    list.push({
      key: 'act:inbox', kind: 'action', icon: Bell, title: t('inbox.open'), href: '/settings/notifications', terms: `${t('inbox.title')} ${t('notifications.title')}`,
      sub: n > 0 ? t('notifications.unread', { count: n }) : undefined, attention: n > 0,
    })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcp, unread, locale])

  const sections: Section[] = useMemo(() => {
    const chats = ok(recent) ?? []
    const allProjects = ok(projects) ?? []
    const allSkills = ok(skills) ?? []
    const allSchedules = ok(schedules) ?? []
    const allMcp = ok(mcp)?.items ?? []
    const out: Section[] = []
    const push = (id: string, label: string, rows: Row[]) => rows.length && out.push({ id, label, rows })
    const typeLabel = (x: SearchTab) => t(TAB_LABEL[x])

    if (!query) {
      if (tab === 'all') {
        const attention: Row[] = [
          ...chats.filter((c) => c.runState !== 'idle').map((c) => chatRow(c, t(c.runState === 'running' ? 'search.attn.running' : 'search.attn.queued'))),
          ...allSchedules.filter((s) => s.needsReview).map((s) => scheduleRow(s, t('search.attn.review'))),
          ...allMcp.filter((i) => i.status !== 'connected').map((i) => mcpRow(i, t(i.status === 'needs_auth' ? 'search.attn.signIn' : 'search.attn.error'))),
        ].slice(0, 5)
        push('attention', t('search.attention'), attention)
        const busy = new Set(attention.map((r) => r.key))
        const mixed = [
          ...chats.slice(0, 8).map((c) => ({ at: c.updatedAt, row: chatRow(c) })),
          ...[...allProjects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 2).map((p) => ({ at: p.createdAt, row: projectRow(p) })),
        ]
          .filter((x) => !busy.has(x.row.key))
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 6)
          .map((x) => x.row)
        push('recents', t('search.recents'), mixed)
        push('actions', t('search.actions'), actions)
      } else if (tab === 'chats') push('chats', typeLabel('chats'), chats.map((c) => chatRow(c)))
      else if (tab === 'projects') push('projects', typeLabel('projects'), allProjects.map(projectRow))
      else if (tab === 'skills') push('skills', typeLabel('skills'), allSkills.map(skillRow))
      else if (tab === 'scheduled') push('scheduled', typeLabel('scheduled'), allSchedules.map((s) => scheduleRow(s)))
      else if (tab === 'mcp') push('mcp', typeLabel('mcp'), allMcp.map((i) => mcpRow(i)))
      else if (tab === 'files') push('files', typeLabel('files'), actions.filter((a) => a.key === 'act:files'))
      return out
    }

    const few = tab === 'all' ? 4 : 50
    if (tab === 'all' || tab === 'chats') push('chats', typeLabel('chats'), (found ?? []).slice(0, tab === 'all' ? 5 : 30).map((c) => chatRow(c)))
    if (tab === 'all' || tab === 'projects') push('projects', typeLabel('projects'), allProjects.filter((p) => has(query, p.name, p.folderPath)).slice(0, few).map(projectRow))
    if (tab === 'all' || tab === 'skills') push('skills', typeLabel('skills'), allSkills.filter((s) => has(query, s.name, s.title, s.description)).slice(0, few).map(skillRow))
    if (tab === 'all' || tab === 'scheduled') push('scheduled', typeLabel('scheduled'), allSchedules.filter((s) => has(query, scheduleName(s, t), scheduleText(s))).slice(0, few).map((s) => scheduleRow(s)))
    if (tab === 'all' || tab === 'mcp') push('mcp', typeLabel('mcp'), allMcp.filter((i) => has(query, i.name, i.url)).slice(0, few).map((i) => mcpRow(i)))
    if (tab === 'all' || tab === 'files')
      push('files', typeLabel('files'), [...(names ?? []).slice(0, tab === 'all' ? 4 : 30).map(fileNameRow), ...(contentQueryReady(q) ? [filesRow()] : [])])
    if (tab === 'all') push('actions', t('search.actions'), actions.filter((a) => has(query, a.title, a.terms)))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, recent, projects, skills, schedules, mcp, found, names, actions, locale])

  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const active = rows[Math.min(sel, rows.length - 1)]
  useEffect(() => setSel(0), [query, tab])
  useEffect(() => {
    if (active) listRef.current?.querySelector(`[data-key="${CSS.escape(active.key)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = (r: Row) => {
    onClose()
    navigate(r.href)
  }
  const closeMenu = () => {
    setMenu(null)
    inputRef.current?.focus()
  }
  const openMenu = (r: Row) => {
    if (!r.chat) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(r.key)}"]`)
    const box = ref.current?.getBoundingClientRect()
    const at = el?.getBoundingClientRect()
    setMenu({ row: r, top: at && box ? at.bottom - box.top : 0 })
  }
  // the type tabs scroll sideways on a phone: fade the cut edge, and bring the chosen one into view (arrow keys at the
  // ends of the text choose another)
  const tabRow = useRef<HTMLDivElement>(null)
  useEdgeFade(tabRow)
  useEffect(() => {
    const row = tabRow.current
    if (!row || row.scrollWidth <= row.clientWidth) return
    row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])
  const moveTab = (d: 1 | -1) => setTab((x) => SEARCH_TABS[(SEARCH_TABS.indexOf(x) + d + SEARCH_TABS.length) % SEARCH_TABS.length]!)
  const loading = (tab === 'chats' && (query ? found === null && !error : recent === null)) || (tab === 'projects' && projects === null) || (tab === 'skills' && skills === null) || (tab === 'scheduled' && schedules === null) || (tab === 'mcp' && mcp === null) || (tab === 'files' && wantNames && names === null)
  const failed = (tab === 'projects' && projects === 'error') || (tab === 'skills' && skills === 'error') || (tab === 'scheduled' && schedules === 'error') || (tab === 'mcp' && mcp === 'error') || (tab === 'chats' && !query && recent === 'error')

  const mark = (text: string): ReactNode => {
    const i = query ? norm(text).indexOf(query) : -1
    if (i < 0) return text
    return (
      <>
        {text.slice(0, i)}
        <mark className="rounded-sm bg-accent/20 text-inherit">{text.slice(i, i + query.length)}</mark>
        {text.slice(i + query.length)}
      </>
    )
  }
  const optId = (r: Row) => `sr-${r.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 sm:p-4 sm:pt-[10vh]" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t('search.title')}
        data-testid="search-palette"
        className="relative flex h-full w-full flex-col overflow-hidden bg-surface shadow-2xl sm:h-auto sm:max-h-[80vh] sm:max-w-2xl sm:rounded-2xl sm:border sm:border-line"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-4 pb-2">
          <input
            ref={inputRef}
            data-autofocus
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls="search-results"
            aria-activedescendant={active ? optId(active) : undefined}
            aria-label={t('search.title')}
            className="h-10 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-faint"
            placeholder={t('search.placeholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setMenu(null)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              const input = e.currentTarget
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setMenu(null)
                if (rows.length) setSel((s) => (e.key === 'ArrowDown' ? Math.min(rows.length - 1, s + 1) : Math.max(0, s - 1)))
              } else if (e.key === 'Enter' && e.altKey) {
                e.preventDefault()
                if (active?.chat) (menu ? closeMenu() : openMenu(active))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (active) go(active)
              } else if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && input.selectionStart === input.selectionEnd) {
                // ← at the start or → at the end of the text changes the type; elsewhere the caret moves as usual
                if (e.key === 'ArrowRight' && input.selectionEnd === input.value.length) {
                  e.preventDefault()
                  moveTab(1)
                } else if (e.key === 'ArrowLeft' && input.selectionStart === 0) {
                  e.preventDefault()
                  moveTab(-1)
                }
              }
            }}
          />
          <button type="button" onClick={onClose} aria-label={t('search.close')} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover hover:text-text">
            <X size={18} aria-hidden />
          </button>
        </div>
        {/* the line under the tabs sits outside the row, so the row's edge fade does not fade it too */}
        <div className="shrink-0 border-b border-line">
          <div ref={tabRow} role="tablist" aria-label={t('search.types')} className="scroll-thin edge-fade flex gap-1 overflow-x-auto px-4 pb-3">
            {SEARCH_TABS.map((x) => (
              <button
                key={x}
                type="button"
                role="tab"
                aria-selected={tab === x}
                tabIndex={tab === x ? 0 : -1}
                data-testid={`search-tab-${x}`}
                onClick={() => {
                  setTab(x)
                  inputRef.current?.focus()
                }}
                className={clsx('shrink-0 rounded-lg px-3 py-1.5 text-sm', tab === x ? 'bg-hover font-medium text-text' : 'text-muted hover:text-text')}
              >
                {t(TAB_LABEL[x])}
              </button>
            ))}
          </div>
        </div>
        <div ref={listRef} id="search-results" role="listbox" aria-label={t('search.title')} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 sm:max-h-[56vh]">
          {error && <p className="px-3 py-2 text-sm text-danger">{error}</p>}
          {failed && <p className="px-3 py-2 text-sm text-danger">{t('search.loadFailed')}</p>}
          {namesFailed && wantNames && <p className="px-3 py-2 text-sm text-danger" data-testid="search-names-failed">{t('search.fileNamesFailed')}</p>}
          {sections.map((s) => (
            <div key={s.id} role="group" aria-labelledby={`sh-${s.id}`} data-testid={`search-section-${s.id}`} className="pb-1">
              <p id={`sh-${s.id}`} className="px-3 pt-3 pb-1.5 text-xs text-faint">{s.label}</p>
              {s.rows.map((r) => {
                const on = r === active
                const Icon = r.icon
                return (
                  <div
                    key={r.key}
                    id={optId(r)}
                    data-key={r.key}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => !on && setSel(rows.indexOf(r))}
                    onClick={() => go(r)}
                    className={clsx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm', on && 'bg-hover')}
                  >
                    <span className="relative shrink-0 text-muted">
                      <Icon size={16} aria-hidden />
                      {r.attention && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" data-testid="search-attention-dot" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {r.match ? mark(r.title) : r.title}
                      {r.sub && <span className={clsx('ml-2 text-xs', r.attention ? 'text-accent-text' : 'text-faint')}>{r.subMatch ? mark(r.sub) : r.sub}</span>}
                    </span>
                    {on && r.chat && (
                      <span
                        role="presentation"
                        title={t('search.rowActions')}
                        data-testid="search-row-more"
                        className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-text"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (menu?.row.key === r.key) closeMenu()
                          else openMenu(r)
                        }}
                      >
                        <MoreHorizontal size={16} aria-hidden />
                      </span>
                    )}
                    {on && <CornerDownLeft size={15} className="shrink-0 text-faint" aria-hidden />}
                  </div>
                )
              })}
            </div>
          ))}
          {!sections.length && !loading && !failed && !error && (
            <p className="px-3 py-8 text-center text-sm text-faint" data-testid="search-none">{tab === 'files' && !query ? t('search.filesHint') : t('search.none')}</p>
          )}
          {!sections.length && loading && <p className="px-3 py-8 text-center text-sm text-faint">…</p>}
        </div>
        {menu?.row.chat && (
          <div role="menu" aria-label={t('search.rowActions')} data-testid="search-row-menu" className="absolute right-6 z-10 w-44 rounded-xl border border-line bg-surface p-1 shadow-xl" style={{ top: menu.top }}>
            {[
              { label: t('chat.rename'), icon: Pencil, run: () => void chatActions.rename(menu.row.chat!) },
              { label: t('common.delete'), icon: Trash2, run: () => void chatActions.remove(menu.row.chat!), danger: true },
            ].map((m, i) => (
              <button
                key={m.label}
                type="button"
                role="menuitem"
                autoFocus={i === 0}
                className={clsx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover', m.danger && 'text-danger')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const items = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
                    items[(items.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
                  }
                }}
                onClick={() => {
                  onClose()
                  m.run()
                }}
              >
                <m.icon size={15} aria-hidden /> {m.label}
              </button>
            ))}
          </div>
        )}
        <div className="hidden shrink-0 items-center gap-5 border-t border-line px-5 py-2.5 text-xs text-faint sm:flex" data-testid="search-hints">
          <Hint label={t('search.hintClose')} keys={['Esc']} />
          <Hint label={t('search.hintType')} keys={['←', '→']} />
          <Hint label={t('search.hintOpen')} keys={['↵']} />
          {active?.chat && <Hint label={t('search.hintActions')} keys={[onMac() ? '⌥' : 'Alt', '↵']} />}
        </div>
      </div>
    </div>
  )
}

function Hint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="flex items-center gap-1.5">
      {label}
      {keys.map((k) => (
        <kbd key={k} className="rounded border border-line px-1.5 py-px font-sans text-micro text-muted">{k}</kbd>
      ))}
    </span>
  )
}
