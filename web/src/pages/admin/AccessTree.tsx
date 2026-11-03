// Admin › Folder permissions › By folder: the team folder as a tree, read from the top. Each row is one folder with who
// can open it and where that comes from (GET /api/admin/access/tree, put into words by lib/access-view.ts); folders
// without rules of their own are dimmed as inherited. Choosing a folder shows its rules and every person's access and
// the reason (GET /api/admin/access/folder, the stage 2 answer, with the stage 3 reasons), with the rule editor
// (RulesEditor) and "remove all rules" (shared/, skills/ and a group's folder keep theirs). Rows of folders that are
// not in the tree (gone from disk, inside users/) are folded under it to clean up. Nothing here decides access.
//
// The keyboard follows the WAI-ARIA tree pattern: one Tab stop (the row last focused), Up and Down move, Right opens a
// folder or goes into it, Left closes it or goes to the folder above, Home and End, typing jumps to a name, Enter or
// Space chooses (choosing asks the server, so moving alone does not). "N more" and "Try again" are rows of the tree too.
import clsx from 'clsx'
import { ArrowLeft, Briefcase, Cable, ChevronRight, Folder as FolderIcon, FolderTree, Loader2, Lock, Plus, RotateCw, SlidersHorizontal, Sparkles, TriangleAlert, UserRound, UsersRound, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { AccessTreeNode, AccessTreeResponse, Folder, FolderAccessResponse, Group } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { ancestorsOf, isPersonalPath, isRestricted, kindText, levelOf, nodeName, parentOf, reasonText, riskTexts, sourceText, whoSeesText, type Names } from '../../lib/access-view'
import { useLocale, useT } from '../../i18n'
import { Badge, Button, ErrorNote, Skeleton } from '../../components/ui'
import FolderPicker from '../../components/FolderPicker'
import { accessErrorText, LevelLabel } from './AccessResults'
import { RemoveRulesButton, RulesEditor, isSkillsFolder, useRemoveRules } from './Folders'
import { Card, useFocusAfterRemove, useLoad } from './common'

/** One level as loaded so far: its children's paths in the server's order. */
interface Level { children: string[]; total: number; nextCursor: string | null }
interface TreeData { nodes: Map<string, AccessTreeNode>; levels: Map<string, Level>; people: number; members: number }

/** rows asked for when a level opens; after a change, as many as were shown come again */
const PAGE = 200
const MAX_PAGE = 500
const within = (p: string, top: string) => top === '' || p === top || p.startsWith(top + '/')

/** The tree's data: levels by the folder they are in, nodes by path. Every answer also brings the folder asked for
 * itself (`self`), so a level asked for again renews its own row too. */
function useTreeData() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = useState<TreeData | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** levels being asked for (opening, more, again) and those that failed, with the words */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map())
  const dataRef = useRef(data)
  dataRef.current = data

  const ask = (path: string, q: { cursor?: string; limit?: number; open?: boolean } = {}) =>
    api.call(API.explainAccessTree, { query: { path, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), ...(q.limit ? { limit: q.limit } : {}), ...(q.open ? { open: '1' as const } : {}) } })
  const merge = (answers: AccessTreeResponse[], append?: string) =>
    setData((d) => {
      const nodes = new Map(d?.nodes)
      const levels = new Map(d?.levels)
      let counts = d ? { people: d.people, members: d.members } : { people: 0, members: 0 }
      for (const r of answers) {
        nodes.set(r.self.path, r.self)
        counts = { people: r.people, members: r.members }
        for (const l of r.levels) {
          for (const c of l.children) nodes.set(c.path, c)
          const before = levels.get(l.path)
          const paths = l.children.map((c) => c.path)
          const children = append === l.path && before ? [...before.children, ...paths.filter((p) => !before.children.includes(p))] : paths
          levels.set(l.path, { children, total: l.total, nextCursor: l.nextCursor })
        }
      }
      return { nodes, levels, ...counts }
    })
  const mark = (path: string, on: boolean, err?: string) => {
    setBusy((b) => {
      const n = new Set(b)
      if (on) n.add(path)
      else n.delete(path)
      return n
    })
    setFailed((f) => {
      const n = new Map(f)
      if (err) n.set(path, err)
      else n.delete(path)
      return n
    })
  }
  const failText = (e: unknown) => accessErrorText(e, locale, t)

  /** the root with the way down to rule, group, project and connected folders opened: the paths opened */
  const loadRoot = useCallback(async (): Promise<string[] | null> => {
    setError(null)
    try {
      const r = await ask('', { open: true })
      setData(null)
      merge([r])
      return r.levels.map((l) => l.path)
    } catch (e) {
      setError(failText(e))
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])

  /** the first page of a folder's level (nothing when it is there already) */
  const openLevel = async (path: string): Promise<boolean> => {
    if (dataRef.current?.levels.has(path)) return true
    mark(path, true)
    try {
      merge([await ask(path, { limit: PAGE })])
      mark(path, false)
      return true
    } catch (e) {
      mark(path, false, failText(e))
      return false
    }
  }

  /** the next page of a level: the paths it brought */
  const more = async (path: string): Promise<string[]> => {
    const l = dataRef.current?.levels.get(path)
    if (!l?.nextCursor || busy.has(path)) return []
    mark(path, true)
    try {
      const r = await ask(path, { cursor: l.nextCursor, limit: PAGE })
      merge([r], path)
      mark(path, false)
      return r.levels[0]!.children.map((c) => c.path)
    } catch (e) {
      mark(path, false, failText(e))
      return []
    }
  }

  /** After rules changed at `changed`: its own row (in the level above, or the root) and every level shown at or below
   * it come again, as many rows as were shown (access below a folder follows its rules). */
  const refresh = async (changed: string) => {
    const d = dataRef.current
    if (!d) return
    const above = parentOf(changed)
    const targets = [...d.levels.keys()].filter((p) => p === above || within(p, changed))
    const again = async (path: string): Promise<AccessTreeResponse[]> => {
      const want = d.levels.get(path)?.children.length ?? 0
      const out: AccessTreeResponse[] = []
      let cursor: string | undefined
      let got = 0
      do {
        const r = await ask(path, { cursor, limit: Math.min(MAX_PAGE, Math.max(PAGE, want - got)) })
        out.push(r)
        got += r.levels[0]!.children.length
        cursor = r.levels[0]!.nextCursor ?? undefined
      } while (cursor && got < want)
      return out
    }
    const results = await Promise.allSettled(targets.map(again))
    // each level that came again: its pages in order replace what it showed (a level that failed stays as it was)
    setData((x) => {
      if (!x) return x
      const nodes = new Map(x.nodes)
      const levels = new Map(x.levels)
      let counts = { people: x.people, members: x.members }
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value.length) continue
        const children: string[] = []
        for (const pg of r.value) {
          nodes.set(pg.self.path, pg.self)
          counts = { people: pg.people, members: pg.members }
          for (const c of pg.levels[0]!.children) {
            nodes.set(c.path, c)
            if (!children.includes(c.path)) children.push(c.path)
          }
        }
        const last = r.value[r.value.length - 1]!.levels[0]!
        levels.set(last.path, { children, total: last.total, nextCursor: last.nextCursor })
      }
      return { nodes, levels, ...counts }
    })
  }

  return { data, error, busy, failed, loadRoot, openLevel, more, refresh, mark }
}

/** The rows on the screen, in order: a folder, "N more" after a level's last loaded child, "try again" for a level
 * that failed to open. */
type Row =
  | { kind: 'node'; key: string; path: string; level: number; pos: number; size: number }
  | { kind: 'more'; key: string; parent: string; level: number; left: number; pos: number; size: number }
  | { kind: 'failed'; key: string; parent: string; level: number }

function flatten(data: TreeData, open: ReadonlySet<string>, failed: ReadonlyMap<string, string>): Row[] {
  const out: Row[] = []
  const visit = (path: string, level: number, pos: number, size: number) => {
    out.push({ kind: 'node', key: `n:${path}`, path, level, pos, size })
    if (!open.has(path)) return
    const l = data.levels.get(path)
    if (!l) {
      if (failed.has(path)) out.push({ kind: 'failed', key: `f:${path}`, parent: path, level: level + 1 })
      return
    }
    const n = l.children.length + (l.nextCursor ? 1 : 0)
    l.children.forEach((c, i) => data.nodes.has(c) && visit(c, level + 1, i + 1, n))
    if (l.nextCursor) out.push({ kind: 'more', key: `m:${path}`, parent: path, level: level + 1, left: Math.max(0, l.total - l.children.length), pos: n, size: n })
  }
  if (data.nodes.has('')) visit('', 1, 1, 1)
  return out
}

const KIND_ICON = (n: AccessTreeNode): LucideIcon =>
  n.path === '' ? FolderTree : n.kinds.includes('personal') ? UserRound : n.kinds.includes('group') ? UsersRound : n.kinds.includes('project') ? Briefcase : n.kinds.includes('connected') ? Cable : n.path === 'skills' || n.path.startsWith('skills/') ? Sparkles : FolderIcon

export default function AccessTree() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const tree = useTreeData()
  const folders = useLoad(async () => (await api.call(API.listFolders)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  /** below the width where the tree and the folder sit side by side: the folder replaces the tree until Back */
  const [showDetail, setShowDetail] = useState(false)
  const [editing, setEditing] = useState<{ folder: Folder | null; path: string } | null>(null)
  const [picking, setPicking] = useState(false)
  /** asks the chosen folder's people again after a change */
  const [detailKey, setDetailKey] = useState(0)
  const treeBox = useRef<HTMLDivElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const rootName = t('accessView.rootFolder')
  const removal = useRemoveRules(rootName)

  // the first answer opens the way down to rule, group, project and connected folders; a folder in the address
  // (?folder=) is opened to and chosen
  useEffect(() => {
    void (async () => {
      const opened = await tree.loadRoot()
      if (!opened) return
      setOpen(new Set(['', ...opened]))
      const wanted = params.get('folder')
      if (wanted !== null && !isPersonalPath(wanted)) void reveal(wanted)
      else if (wanted !== null) setSelected('users')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** open every folder above `path` (asking for the levels not loaded) and choose it; its row comes into view */
  const reveal = async (path: string) => {
    for (const a of ancestorsOf(path)) if (!(await tree.openLevel(a))) return
    setOpen((o) => new Set([...o, ...ancestorsOf(path)]))
    choose(path)
    scrollTo.current = path
  }
  const scrollTo = useRef<string | null>(null)
  useLayoutEffect(() => {
    const path = scrollTo.current
    if (path === null) return
    const row = [...(treeBox.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find((r) => r.dataset.path === path)
    if (!row) return
    scrollTo.current = null
    row.scrollIntoView({ block: 'nearest' })
  })
  const choose = (path: string) => {
    setSelected(path)
    setShowDetail(true)
    // replace, not push: moving through the tree is not a history of pages
    const q = new URLSearchParams(window.location.search)
    q.set('folder', path)
    setParams(q, { replace: true })
  }

  const ruleRows = folders.data
  const rowOf = (p: string) => ruleRows?.find((f) => f.path === p)
  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name
  const subject = (type: string, id: string | null) => {
    if (type === 'everyone') return t('rules.everyone')
    if (type === 'role') return t('rules.roleOf', { role: t(id === 'admin' ? 'role.admin' : 'role.member') })
    if (type === 'group') return t('rules.groupOf', { name: (id && groupName(id)) ?? '?' })
    return users.data?.find((u) => u.id === id)?.name ?? id ?? '?'
  }
  const ruleFolders = useMemo(() => (folders.data ? new Set(folders.data.filter((f) => f.rules.length).map((f) => f.path)) : undefined), [folders.data])
  const names: Names = { group: groupName, person: (id) => users.data?.find((u) => u.id === id)?.name, ruleFolders }

  /** after rules changed at `path`: the rule rows, the tree around it, the chosen folder's people */
  const changed = async (path: string) => {
    await Promise.all([folders.reload(), tree.refresh(path)])
    setDetailKey((n) => n + 1)
  }

  // rows of folders that are not in the tree: gone from disk, or inside users/ (rules there never apply)
  const outside = (ruleRows ?? []).filter((f) => f.path !== '' && (!f.exists || isPersonalPath(f.path))).sort((a, b) => a.path.localeCompare(b.path))
  const node = selected !== null ? tree.data?.nodes.get(selected) : undefined

  let body: ReactNode
  if (tree.error) body = <ErrorNote onRetry={() => void tree.loadRoot().then((o) => o && setOpen(new Set(['', ...o])))}>{tree.error}</ErrorNote>
  else if (!tree.data) body = <Skeleton lines={8} />
  else {
    body = (
      <div className="@container">
        <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-start @2xl:gap-0">
          <div ref={treeBox} className={clsx('min-w-0 flex-1 @2xl:pr-4', showDetail && selected !== null && '@max-2xl:hidden')}>
            <Tree
              data={tree.data}
              open={open}
              busy={tree.busy}
              failed={tree.failed}
              selected={selected}
              onToggle={async (path, to) => {
                if (!to) {
                  setOpen((o) => new Set([...o].filter((p) => p !== path)))
                  return
                }
                setOpen((o) => new Set([...o, path]))
                await tree.openLevel(path)
              }}
              onMore={tree.more}
              onRetry={(path) => {
                tree.mark(path, false)
                void tree.openLevel(path)
              }}
              onChoose={choose}
            />
            <OutsideRules rows={outside} folders={folders.data} subject={subject} groups={groups.data ?? []} onEdit={(f) => setEditing({ folder: f, path: f.path })} removal={removal} onRemoved={() => folders.reload()} />
          </div>
          <div className={clsx('min-w-0 @2xl:sticky @2xl:top-4 @2xl:max-h-[calc(100dvh-2rem)] @2xl:w-80 @2xl:shrink-0 @2xl:overflow-y-auto @2xl:border-l @2xl:border-line @2xl:pl-5 @3xl:w-96 scroll-thin', !(showDetail && selected !== null) && '@max-2xl:hidden')} data-testid="folder-detail-box">
            {node ? (
              <FolderDetail
                key={node.path}
                node={node}
                members={tree.data.members}
                row={rowOf(node.path)}
                rowsReady={!!folders.data}
                names={names}
                subject={subject}
                reloadKey={detailKey}
                headingRef={detailHeading}
                removal={removal}
                onEdit={() => setEditing({ folder: rowOf(node.path) ?? null, path: node.path })}
                onRemoved={async () => {
                  await changed(node.path)
                  // the delete button went with the rules: the focus goes to the rules button, not to the page
                  requestAnimationFrame(() => {
                    const a = document.activeElement
                    if (!a || a === document.body || !a.isConnected) document.querySelector<HTMLElement>('[data-testid="folder-detail-edit"]')?.focus()
                  })
                }}
                onBack={() => {
                  setShowDetail(false)
                  requestAnimationFrame(() => treeBox.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus())
                }}
              />
            ) : (
              <p className="py-6 text-sm text-faint @max-2xl:hidden">{t('accessTree.pick')}</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  // a folder chosen while the tree is hidden (narrow): the folder's heading takes the focus, not the page
  useLayoutEffect(() => {
    if (!showDetail || selected === null) return
    if (treeBox.current && treeBox.current.offsetParent === null) detailHeading.current?.focus()
  }, [showDetail, selected])

  return (
    <>
      <Card
        title={t('accessTree.title')}
        desc={t('accessTree.desc')}
        actions={
          <Button size="sm" variant="primary" onClick={() => setPicking(true)} data-testid="folder-rule-new">
            <Plus size={14} aria-hidden /> {t('rules.addFolder')}
          </Button>
        }
      >
        {(folders.error || groups.error || users.error) && (
          <div className="mb-4" data-testid="access-side-error">
            <ErrorNote
              onRetry={() => {
                if (folders.error) void folders.reload()
                if (groups.error) void groups.reload()
                if (users.error) void users.reload()
              }}
            >
              {[folders.error && `${t('accessView.foldersFailed')} ${folders.error}`, groups.error && `${t('accessView.groupsFailed')} ${groups.error}`, users.error].filter(Boolean).join(' ')}
            </ErrorNote>
          </div>
        )}
        {body}
      </Card>
      <FolderPicker
        open={picking}
        title={t('rules.addFolder')}
        confirmLabel={t('common.choose')}
        needWrite={false}
        onClose={() => setPicking(false)}
        onPick={(path) => {
          setPicking(false)
          setEditing({ folder: rowOf(path) ?? null, path })
        }}
      />
      {editing && (
        <RulesEditor
          folder={editing.folder}
          path={editing.path}
          users={users.data ?? []}
          groups={groups.data ?? []}
          subject={subject}
          rootName={rootName}
          onClose={() => setEditing(null)}
          onSaved={() => {
            const path = editing.path
            setEditing(null)
            // the folder saved is opened to and chosen (a folder that is not on disk stays in the list under the tree)
            void changed(path).then(() => {
              if (!isPersonalPath(path) && rowOf(path)?.exists !== false) void reveal(path)
            })
          }}
        />
      )}
    </>
  )
}

// ---------------- the tree ----------------

/** How long typed letters add up to one name to jump to. */
const TYPE_AHEAD_MS = 700

function Tree({ data, open, busy, failed, selected, onToggle, onMore, onRetry, onChoose }: {
  data: TreeData
  open: ReadonlySet<string>
  busy: ReadonlySet<string>
  failed: ReadonlyMap<string, string>
  selected: string | null
  onToggle: (path: string, open: boolean) => Promise<void> | void
  onMore: (path: string) => Promise<string[]>
  onRetry: (path: string) => void
  onChoose: (path: string) => void
}) {
  const t = useT()
  const rows = useMemo(() => flatten(data, open, failed), [data, open, failed])
  const [active, setActive] = useState<string>(selected !== null ? `n:${selected}` : 'n:')
  const els = useRef(new Map<string, HTMLElement>())
  /** the row to focus once it is on the screen (after opening, loading more, closing) */
  const focusNext = useRef<string | null>(null)
  const typed = useRef({ text: '', at: 0 })

  // the Tab stop: the row last focused; if it went away (its folder closed), the nearest row above it that is there
  let tabStop = rows.find((r) => r.key === active)?.key
  if (!tabStop) {
    const path = active.slice(2)
    const up = [path, ...ancestorsOf(path).reverse()].find((p) => rows.some((r) => r.key === `n:${p}`))
    tabStop = up !== undefined ? `n:${up}` : rows[0]?.key
  }
  useLayoutEffect(() => {
    const k = focusNext.current
    if (k === null) return
    const el = els.current.get(k)
    if (!el) return
    focusNext.current = null
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
  })
  const go = (key: string | undefined) => {
    if (!key) return
    setActive(key)
    focusNext.current = key
    // already on the screen: focus now (the effect above runs only on a render)
    const el = els.current.get(key)
    if (el) {
      focusNext.current = null
      el.focus()
      el.scrollIntoView({ block: 'nearest' })
    }
  }

  const activate = async (r: Row) => {
    if (r.kind === 'node') onChoose(r.path)
    else if (r.kind === 'failed') onRetry(r.parent)
    else {
      const got = await onMore(r.parent)
      // the first folder that came takes the focus (the "more" row moved below it, or went)
      if (got[0]) go(`n:${got[0]}`)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.key === tabStop)
    const r = rows[i]
    if (!r) return
    const n = r.kind === 'node' ? data.nodes.get(r.path) : undefined
    switch (e.key) {
      case 'ArrowDown':
        go(rows[i + 1]?.key)
        break
      case 'ArrowUp':
        go(rows[i - 1]?.key)
        break
      case 'Home':
        go(rows[0]?.key)
        break
      case 'End':
        go(rows[rows.length - 1]?.key)
        break
      case 'ArrowRight':
        if (r.kind !== 'node' || !n?.folders) break
        if (!open.has(r.path)) void onToggle(r.path, true)
        else if (rows[i + 1] && rows[i + 1]!.level > r.level) go(rows[i + 1]!.key)
        break
      case 'ArrowLeft':
        if (r.kind === 'node' && n?.folders && open.has(r.path)) void onToggle(r.path, false)
        else {
          const up = r.kind === 'node' ? parentOf(r.path) : r.parent
          if (up !== null) go(`n:${up}`)
        }
        break
      case 'Enter':
      case ' ':
        void activate(r)
        break
      default: {
        // type to jump: the next folder whose name starts with what was typed
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
        const now = Date.now()
        const text = (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : '') + e.key.toLocaleLowerCase()
        typed.current = { text, at: now }
        const order = [...rows.slice(i + (text.length === 1 ? 1 : 0)), ...rows.slice(0, i + (text.length === 1 ? 1 : 0))]
        const hit = order.find((x) => x.kind === 'node' && nodeName(t, data.nodes.get(x.path)!).toLocaleLowerCase().startsWith(text))
        if (hit) go(hit.key)
        break
      }
    }
    e.preventDefault()
  }

  return (
    <div role="tree" aria-label={t('accessTree.label')} className="@container/tree -mx-1.5" onKeyDown={onKey} data-testid="folder-tree">
      {rows.map((r) => {
        const ref = (el: HTMLElement | null) => {
          if (el) els.current.set(r.key, el)
          else els.current.delete(r.key)
        }
        const common = {
          ref,
          role: 'treeitem' as const,
          'aria-level': r.level,
          tabIndex: r.key === tabStop ? 0 : -1,
          onFocus: () => setActive(r.key),
          style: { '--d': r.level - 1 } as React.CSSProperties,
        }
        if (r.kind === 'node') {
          const n = data.nodes.get(r.path)!
          return (
            <TreeRow
              key={r.key}
              {...common}
              n={n}
              level={r.level}
              pos={r.pos}
              size={r.size}
              members={data.members}
              open={open.has(r.path)}
              busy={busy.has(r.path) && !data.levels.has(r.path)}
              selected={selected === r.path}
              onToggle={() => {
                setActive(r.key)
                void onToggle(r.path, !open.has(r.path))
              }}
              onChoose={() => {
                setActive(r.key)
                onChoose(r.path)
              }}
            />
          )
        }
        const extra = r.kind === 'more' ? { 'aria-posinset': r.pos, 'aria-setsize': r.size } : {}
        const err = failed.get(r.parent)
        const loading = busy.has(r.parent)
        return (
          <div
            key={r.key}
            {...common}
            {...extra}
            aria-busy={loading || undefined}
            onClick={() => {
              setActive(r.key)
              void activate(r)
            }}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg py-2 pr-2 text-[13px] font-medium text-muted transition-[background-color,color] hover:bg-hover hover:text-ink focus-visible:-outline-offset-2 max-sm:min-h-10"
            data-testid={r.kind === 'more' ? 'tree-more' : 'tree-failed'}
          >
            <Indent />
            <span className="inline-flex size-6 shrink-0 items-center justify-center" aria-hidden>
              {loading ? <Loader2 size={14} className="animate-spin" /> : r.kind === 'more' ? <Plus size={14} /> : <RotateCw size={14} />}
            </span>
            {r.kind === 'more' ? <span>{t('accessTree.more', { n: r.left })}</span> : <span className="text-danger">{t('accessTree.failed')}</span>}
            {/* what went wrong (the server's words), for a level that did not open or a page that did not come */}
            {err && <span className="min-w-0 text-xs font-normal text-danger">{err}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** Room for the depth: 12px a level up to four on a narrow tree, 16px up to eight on a wide one. Deeper rows say so. */
function Indent() {
  return <span className="w-[calc(min(var(--d),4)*0.75rem)] shrink-0 @xl/tree:w-[calc(min(var(--d),8)*1rem)]" aria-hidden />
}

function TreeRow({ n, level, pos, size, members, open, busy, selected, onToggle, onChoose, ...item }: {
  n: AccessTreeNode
  level: number
  pos: number
  size: number
  members: number
  open: boolean
  busy: boolean
  selected: boolean
  onToggle: () => void
  onChoose: () => void
  ref: (el: HTMLElement | null) => void
  role: 'treeitem'
  'aria-level': number
  tabIndex: number
  onFocus: () => void
  style: React.CSSProperties
}) {
  const t = useT()
  const personal = n.kinds.includes('personal')
  const own = n.rules > 0
  const Icon = KIND_ICON(n)
  const kind = kindText(t, n)
  const depth = level - 1
  const name = nodeName(t, n)
  const risks = riskTexts(t, n)
  const restricted = isRestricted(n)
  return (
    <div
      {...item}
      aria-posinset={pos}
      aria-setsize={size}
      aria-expanded={n.folders ? open : undefined}
      aria-selected={selected}
      aria-busy={busy || undefined}
      onClick={onChoose}
      title={n.path || name}
      // only the fill fades: a transition of the outline would draw the focus ring in ink before the accent
      className={clsx('flex cursor-pointer items-start gap-1.5 rounded-lg py-2 pr-2 transition-[background-color] focus-visible:-outline-offset-2', selected ? 'bg-accent-soft' : 'hover:bg-hover')}
      data-testid="tree-row"
      data-path={n.path}
      data-rules={n.rules}
    >
      <Indent />
      {/* the open / close target (the row itself chooses the folder); no Tab stop of its own, the arrow keys do it */}
      <span
        onClick={(e) => {
          e.stopPropagation()
          if (n.folders) onToggle()
        }}
        className={clsx('-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-faint max-sm:size-9', n.folders && 'hover:bg-hover hover:text-ink')}
        aria-hidden
        data-testid="tree-toggle"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : n.folders && <ChevronRight size={15} className={clsx('transition', open && 'rotate-90')} />}
      </span>
      <Icon size={16} className={clsx('mt-0.5 shrink-0', own || n.path === '' ? 'text-muted' : 'text-faint')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-x-2">
          <span className={clsx('min-w-0 truncate text-sm', own || n.path === '' ? 'font-medium text-ink' : 'text-muted')}>
            {/* deeper than the room for depth: said in front of the name; the whole path is the row's title */}
            {depth > 4 && <span className={clsx('text-faint', depth <= 8 && '@xl/tree:hidden')} aria-hidden>…/</span>}
            {name}
          </span>
          {kind && <span className="shrink-0 text-xs text-faint">{personal ? t('accessTree.personal.count', { n: n.people ?? 0 }) : kind}</span>}
          {restricted && (
            <span className="inline-flex shrink-0 self-center text-muted" title={t('accessTree.restricted')}>
              <Lock size={12} aria-hidden />
              <span className="sr-only">{t('accessTree.restricted')}</span>
            </span>
          )}
        </div>
        {personal ? (
          <p className="mt-0.5 text-[13px] leading-5 text-muted">
            {t('accessTree.personal.who')} <span className="text-xs text-faint">· {t('accessTree.personal.fixed')}</span>
          </p>
        ) : (
          <p className="mt-0.5 text-[13px] leading-5">
            <span className={own || n.path === '' ? 'text-ink' : 'text-muted'} data-testid="tree-who">
              {whoSeesText(t, n, members)}
            </span>{' '}
            <span className="text-xs text-faint" data-testid="tree-source">
              · {sourceText(t, n, members)}
            </span>
          </p>
        )}
        {risks.map((r) => (
          <p key={r} className="mt-1 flex items-start gap-1 text-xs text-warn" data-testid="tree-risk">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
            {r}
          </p>
        ))}
      </div>
    </div>
  )
}

// ---------------- the chosen folder ----------------

/** One folder's people, page by page (GET /api/admin/access/folder); asked again when `reloadKey` changes. */
function useFolderAnswer(path: string | null, reloadKey: number) {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = useState<FolderAccessResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const [attempt, setAttempt] = useState(0)
  const shown = useRef(0)
  shown.current = data?.people.length ?? 0
  useEffect(() => {
    if (path === null) return
    let live = true
    const want = shown.current
    setError(null)
    void (async () => {
      try {
        let r = await api.call(API.explainFolderAccess, { query: { path } })
        // after a change: as many people as were shown come again
        while (live && r.nextCursor !== null && r.people.length < want) {
          const next = await api.call(API.explainFolderAccess, { query: { path, cursor: r.nextCursor } })
          r = { ...next, people: [...r.people, ...next.people] }
        }
        if (live) setData(r)
      } catch (e) {
        if (live) setError(accessErrorText(e, locale, t))
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadKey, attempt])
  const loadMore = async () => {
    if (!data?.nextCursor || more.busy || path === null) return
    setMore({ busy: true, error: null })
    try {
      const r = await api.call(API.explainFolderAccess, { query: { path, cursor: data.nextCursor } })
      setData({ ...r, people: [...data.people, ...r.people] })
      setMore({ busy: false, error: null })
    } catch (e) {
      setMore({ busy: false, error: accessErrorText(e, locale, t) })
    }
  }
  return { data, error, more, loadMore, retry: () => setAttempt((n) => n + 1) }
}

function FolderDetail({ node: n, members, row, rowsReady, names, subject, reloadKey, headingRef, removal, onEdit, onRemoved, onBack }: {
  node: AccessTreeNode
  members: number
  /** the folder's rule row, if it has one (Admin › Folder permissions' list) */
  row: Folder | undefined
  rowsReady: boolean
  names: Names
  subject: (type: string, id: string | null) => string
  reloadKey: number
  headingRef: React.Ref<HTMLHeadingElement>
  removal: ReturnType<typeof useRemoveRules>
  onEdit: () => void
  onRemoved: () => void | Promise<void>
  onBack: () => void
}) {
  const t = useT()
  const id = useId()
  const personal = n.kinds.includes('personal')
  const answer = useFolderAnswer(personal ? null : n.path, reloadKey)
  const name = n.path === '' ? t('accessView.rootFolder') : n.path
  const kind = kindText(t, n)
  const rules = row?.rules ?? []
  const keep = row?.keep === 'team' ? t('rules.keepTeam') : row?.keep === 'group' ? t('rules.keepGroup', { name: names.group(row.groupId ?? '') ?? '?' }) : null
  return (
    <section aria-labelledby={id} data-testid="folder-detail" data-path={n.path}>
      <button type="button" onClick={onBack} className="-mx-2 mb-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-muted transition hover:bg-hover hover:text-ink max-sm:min-h-10 @2xl:hidden" data-testid="folder-detail-back">
        <ArrowLeft size={15} aria-hidden /> {t('accessTree.back')}
      </button>
      <h3 id={id} ref={headingRef} tabIndex={-1} className="text-base font-semibold break-words text-ink outline-none">
        {name}
      </h3>
      {kind && <p className="mt-0.5 text-xs text-muted">{personal ? `${kind} · ${t('accessTree.personal.count', { n: n.people ?? 0 })}` : kind}</p>}

      {personal ? (
        <div className="mt-3 space-y-2 text-sm text-muted" data-testid="folder-detail-personal">
          <p>{t('accessTree.personal.detail')}</p>
          <p>
            <Link to="/admin/folders?view=people" className="text-accent-text underline-offset-2 hover:underline">
              {t('accessTree.personal.byPerson')}
            </Link>
          </p>
        </div>
      ) : (
        <>
          {/* the rules: change them here, or remove them all (rows the server keeps say why instead) */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onEdit} disabled={!rowsReady} data-testid="folder-detail-edit" data-row-focus>
              <SlidersHorizontal size={14} aria-hidden /> {rules.length ? t('accessTree.editRules') : t('accessTree.addRules')}
            </Button>
            {/* a row without rules left (its group was deleted) can go too, as on the list before */}
            {row && !keep && (
              <RemoveRulesButton f={row} label={t('common.deleteNamed', { name: n.path || t('accessView.rootFolder') })} checking={removal.checking} onClick={() => void removal.remove(row, onRemoved)} testId="folder-detail-delete" />
            )}
            {keep && (
              <span className="inline-flex p-1.5 text-faint max-sm:p-2" title={keep} aria-hidden>
                <Lock size={15} />
              </span>
            )}
          </div>
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted">{t('accessTree.ownRules')}</h4>
            {rules.length ? (
              <RuleBadges rules={rules} path={n.path} subject={subject} />
            ) : (
              <p className="mt-1 text-xs text-muted">{t('accessTree.noOwnRules')}</p>
            )}
            {isSkillsFolder(n.path) && <p className="mt-1.5 text-xs text-muted">{t('skillMgr.folderHint')}</p>}
            {keep && (
              <p className="mt-1.5 text-xs text-muted" data-testid="folder-keep-reason">
                {keep}
              </p>
            )}
          </div>
          {riskTexts(t, n, true).map((r) => (
            <p key={r} role="note" className="mt-3 flex items-start gap-1.5 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="folder-detail-risk">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
              {r}
            </p>
          ))}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted">{t('accessTree.people')}</h4>
            <p className="mt-1 text-[13px] text-ink">{whoSeesText(t, n, members)}</p>
            <p className="text-xs text-faint">{sourceText(t, n, members)}</p>
            <People answer={answer} path={n.path} names={names} />
          </div>
        </>
      )}
    </section>
  )
}

/** A folder's own rules, as the list showed them: who, the access, and on skills/ the team skill managers. */
function RuleBadges({ rules, path, subject }: { rules: Folder['rules']; path: string; subject: (type: string, id: string | null) => string }) {
  const t = useT()
  return (
    <span className="mt-1.5 flex flex-wrap gap-1" data-testid="folder-rules">
      {rules.map((r) => (
        <Badge key={r.id}>
          {subject(r.subjectType, r.subjectId)}: {t(`access.${r.access}`)}
          {isSkillsFolder(path) && r.access === 'write' && (r.subjectType === 'user' || r.subjectType === 'group') && <span data-testid="skill-manager-badge"> · {t('skillMgr.ruleBadge')}</span>}
        </Badge>
      ))}
    </span>
  )
}

function People({ answer, path, names }: { answer: ReturnType<typeof useFolderAnswer>; path: string; names: Names }) {
  const t = useT()
  const { data, error } = answer
  if (error && !data) return <div className="mt-3"><ErrorNote onRetry={answer.retry}>{error}</ErrorNote></div>
  if (!data) return <Skeleton lines={4} className="mt-3" />
  const s = data.summary.access
  // the stage 3 reason of each person, at this folder
  const asRow = (p: Pick<FolderAccessResponse['people'][number], 'access' | 'reason' | 'listable' | 'via' | 'viaMore'>) => ({ path, kinds: [], exists: data.exists, ...p })
  return (
    <>
      <p className="mt-2 text-xs text-muted tabular-nums" data-testid="folder-detail-counts">
        {t('accessTree.counts', { see: s.read + s.write, write: s.write, none: s.none })}
      </p>
      <ul className="mt-1 divide-y divide-line" data-testid="folder-people">
        {data.people.map((p) => {
          const level = levelOf(p)
          return (
            <li key={p.user.id} className="py-2" data-testid="folder-person" data-person={p.user.id} data-level={level}>
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-ink">{p.user.name}</span>
                <span className="shrink-0 text-xs text-faint">{t(`role.${p.role}`)}</span>
              </div>
              <LevelLabel level={level} className="mt-0.5 flex text-xs" />
              <div className="mt-0.5 space-y-0.5 text-xs text-muted">
                {reasonText(t, asRow(p), p.role, names).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      {data.nextCursor !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void answer.loadMore()} busy={answer.more.busy} data-testid="folder-people-more">
            {t('common.loadMore')}
          </Button>
          <span className="text-xs text-faint tabular-nums">{t('accessView.loaded', { n: data.people.length, total: data.total })}</span>
        </div>
      )}
      {answer.more.error && <div className="mt-2"><ErrorNote onRetry={() => void answer.loadMore()}>{answer.more.error}</ErrorNote></div>}
      {data.inactive.length > 0 && (
        <div className="mt-4">
          <h5 className="text-xs font-semibold text-muted">{t('accessTree.inactive')}</h5>
          <ul className="mt-1 divide-y divide-line">
            {data.inactive.map((p) => (
              <li key={p.user.id} className="py-2" data-testid="folder-inactive">
                <span className="block truncate text-sm text-ink">{p.user.name}</span>
                <LevelLabel level={levelOf({ access: p.access, listable: p.access !== 'none' })} className="mt-0.5 flex text-xs" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

// ---------------- rules of folders not in the tree ----------------

/** Rule rows whose folder is not in the tree: gone from disk (moved or deleted outside the app), or inside users/ (rules
 * there never apply). Folded; each can be edited or removed, as on the list before the tree. */
function OutsideRules({ rows, folders, subject, groups, onEdit, removal, onRemoved }: {
  rows: Folder[]
  folders: Folder[] | null
  subject: (type: string, id: string | null) => string
  groups: Group[]
  onEdit: (f: Folder) => void
  removal: ReturnType<typeof useRemoveRules>
  onRemoved: () => Promise<void>
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const id = useId()
  const focus = useFocusAfterRemove(folders, () => document.querySelector<HTMLElement>('[data-testid="folder-rule-new"]'))
  if (!rows.length) return null
  const allMissing = rows.every((f) => !isPersonalPath(f.path))
  return (
    <div className="mt-5 border-t border-line pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-muted transition hover:bg-hover hover:text-ink max-sm:min-h-10"
        data-testid="folder-outside-toggle"
      >
        <ChevronRight size={15} className={clsx('shrink-0 transition', open && 'rotate-90')} aria-hidden />
        {t(allMissing ? 'accessTree.outside' : 'accessTree.outsideMixed', { n: rows.length })}
      </button>
      <div id={id} hidden={!open} ref={focus.box} data-testid="folder-outside">
        <p className="mt-1 text-xs text-muted">{t('accessTree.outsideHint')}</p>
        <ul className="divide-y divide-line" data-testid="folder-list">
          {rows.map((f, i) => {
            const keep = f.keep === 'team' ? t('rules.keepTeam') : f.keep === 'group' ? t('rules.keepGroup', { name: groups.find((g) => g.id === f.groupId)?.name ?? '?' }) : null
            return (
              <li key={f.id} className="flex flex-wrap items-start gap-3 py-3 text-sm" data-testid="folder-row" data-path={f.path}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium break-all text-ink">{f.path}</span>
                  <span className="mt-0.5 block text-xs text-faint">{isPersonalPath(f.path) ? t('accessTree.inPersonal') : t('rules.missingOnDisk')}</span>
                  <RuleBadges rules={f.rules} path={f.path} subject={subject} />
                  {keep && (
                    <span className="mt-1 block text-xs text-muted" data-testid="folder-keep-reason">
                      {keep}
                    </span>
                  )}
                </span>
                <Button size="sm" variant="ghost" onClick={() => onEdit(f)} data-row-focus={keep ? true : undefined}>
                  {t('common.edit')}
                </Button>
                {keep ? (
                  <span className="inline-flex p-1.5 text-faint max-sm:p-2" title={keep} aria-hidden>
                    <Lock size={15} />
                  </span>
                ) : (
                  <RemoveRulesButton
                    f={f}
                    label={t('common.deleteNamed', { name: f.path })}
                    checking={removal.checking}
                    onClick={() =>
                      void removal.remove(f, async () => {
                        focus.removed(i)
                        await onRemoved()
                      })
                    }
                  />
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
