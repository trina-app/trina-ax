// The team's conversation categories on screen (shared/src/api/room-categories.ts). Everyone sees them in the Chats
// list as sections between 고정 and 채널, each holding the channels of it they are in. Admins and the owner manage them:
//   - the + on the Channels header's left ("새 카테고리"), or the quiet "새 카테고리" row when there is none yet;
//   - a category's "⋯" (CategoryMenu): 이름 바꾸기 · 위로 · 아래로 · 카테고리 지우기 (only the category goes);
//   - a channel row's "카테고리로 옮기기" / "카테고리에서 빼기" (useCategoryRowItems): for everyone in the channel at once.
// A 1:1 or an unnamed group chat never goes in one: it is personal.
import { ArrowDown, ArrowUp, FolderMinus, FolderPlus, Pencil, Tag, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import clsx from 'clsx'
import { graphemeCount, NAV_FOLDER_NAME_MAX, RoomCategoryName, type Room, type RoomCategory } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { categoryNameTaken, createCategory, deleteCategory, moveCategory, renameCategory, setCategory, useRoomCategories, watchRoomCategories } from '../../store/roomCategories'
import { isAdmin, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { confirmDialog, promptDialog } from '../ui'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'
import { panelRowBox } from '../panels/PanelFrame'
import { Tooltip } from '../Tooltip'

/** the team's categories, read when first needed and kept current */
export function useCategories(): RoomCategory[] {
  const list = useRoomCategories((s) => s.categories)
  useEffect(() => watchRoomCategories(), [])
  return list ?? []
}

/** admins and the owner manage categories */
export const useManagesCategories = (): boolean => isAdmin(useMe())

/** a channel (team room, everyone room, named group room) can go in a category; a DM cannot */
export const canCategorize = (room: Pick<Room, 'kind' | 'name'>): boolean => room.kind === 'all' || room.kind === 'team' || (room.kind === 'group' && !!room.name)

type T = ReturnType<typeof useT>

function nameCheck(t: T, except?: string) {
  return (v: string): string | null => {
    if (!v.trim()) return null
    if (graphemeCount(v.normalize('NFC').trim()) > NAV_FOLDER_NAME_MAX) return t('navFolders.tooLong', { n: NAV_FOLDER_NAME_MAX })
    if (!RoomCategoryName.safeParse(v).success) return t('navFolders.nameInvalid')
    if (categoryNameTaken(useRoomCategories.getState().categories, v, except)) return t('roomCategories.nameTaken')
    return null
  }
}

export function useCategoryActions() {
  const t = useT()
  const locale = useLocale()
  const fail = (e: unknown) => {
    toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    return null
  }
  return {
    async create(): Promise<RoomCategory | null> {
      const name = await promptDialog({ title: t('roomCategories.new'), label: t('roomCategories.nameLabel'), confirm: t('roomCategories.make'), validate: nameCheck(t), maxLength: 200 })
      if (!name?.trim()) return null
      return createCategory(name.trim()).catch(fail)
    },
    async rename(c: RoomCategory) {
      const name = await promptDialog({ title: t('navFolders.rename'), label: t('roomCategories.nameLabel'), initial: c.name, confirm: t('common.save'), validate: nameCheck(t, c.id), maxLength: 200 })
      if (!name?.trim() || name.trim() === c.name) return
      await renameCategory(c, name.trim()).catch(fail)
    },
    async remove(c: RoomCategory) {
      if (!(await confirmDialog({ title: t('roomCategories.deleteTitle', { name: c.name }), body: t('roomCategories.deleteBody'), confirm: t('roomCategories.delete'), danger: true }))) return
      await deleteCategory(c).catch(fail)
    },
    async move(c: RoomCategory, by: -1 | 1) {
      await moveCategory(c, by).catch(fail)
    },
    async file(roomId: string, to: RoomCategory | null, from?: RoomCategory | null) {
      const r = await setCategory(roomId, to?.id ?? null).catch(fail)
      if (!r) return
      if (to) toast({ level: 'success', text: t('roomCategories.moved', { name: to.name }) })
      else if (from) toast({ level: 'success', text: t('roomCategories.takenOut', { name: from.name }) })
    },
  }
}

/** "새 카테고리" as a section's + (admins only) */
export function NewCategoryButton() {
  const t = useT()
  const act = useCategoryActions()
  if (!useManagesCategories()) return null
  // its own mark (a folder with +), so it never reads as the Channels header's other + (Create a channel)
  return (
    <Tooltip label={t('roomCategories.new')}>
      <button type="button" aria-label={t('roomCategories.new')} onClick={() => void act.create()} className="touch-hit flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink md:pointer-coarse:-m-2.5 md:pointer-coarse:size-11" data-testid="room-category-new">
        <FolderPlus size={14} aria-hidden />
      </button>
    </Tooltip>
  )
}

/** "새 카테고리" as a quiet row (admins only, while there is none) */
export function NewCategoryRow({ className }: { className?: string }) {
  const t = useT()
  const act = useCategoryActions()
  if (!useManagesCategories()) return null
  return (
    <button type="button" className={clsx(panelRowBox, 'text-row text-muted', className)} onClick={() => void act.create()} data-testid="room-category-new-row">
      <FolderPlus size={16} className="text-faint" aria-hidden /> <span className="truncate">{t('roomCategories.new')}</span>
    </button>
  )
}

/** a category's "⋯" (admins only): rename, up, down, delete */
export function CategoryMenu({ category }: { category: RoomCategory }) {
  const t = useT()
  const act = useCategoryActions()
  const list = useCategories()
  if (!useManagesCategories()) return null
  const i = list.findIndex((c) => c.id === category.id)
  const items: MenuItem[] = [
    { label: t('navFolders.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => void act.rename(category), testId: 'category-menu-rename' },
    ...(i > 0 ? [{ label: t('navFolders.moveUp'), icon: <ArrowUp size={14} aria-hidden />, onSelect: () => void act.move(category, -1), testId: 'category-menu-up' }] : []),
    ...(i >= 0 && i < list.length - 1 ? [{ label: t('navFolders.moveDown'), icon: <ArrowDown size={14} aria-hidden />, onSelect: () => void act.move(category, 1), testId: 'category-menu-down' }] : []),
    { label: t('roomCategories.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => void act.remove(category), testId: 'category-menu-delete' },
  ]
  return <MenuButton label={t('roomCategories.menu', { name: category.name })} tip={t('roomCategories.menu', { name: category.name })} items={items} compact buttonClassName="size-6" sheetTitle={category.name} testId="category-menu" />
}

/** A channel row's category items for its "⋯" (admins only) and the picker they open. */
export function useCategoryRowItems(o: { on: boolean; room: Room; more: RefObject<HTMLButtonElement | null> }): { items: MenuItem[]; picker: ReactNode } {
  const t = useT()
  const admin = useManagesCategories()
  const on = o.on && admin && canCategorize(o.room)
  const list = useRoomCategories((s) => s.categories) ?? []
  useEffect(() => { if (on) watchRoomCategories() }, [on])
  const act = useCategoryActions()
  const [pick, setPick] = useState(0)
  if (!on) return { items: [], picker: null }
  const current = list.find((c) => c.id === o.room.categoryId) ?? null
  const items: MenuItem[] = [
    { label: t('roomCategories.moveTo'), icon: <Tag size={14} aria-hidden />, onSelect: () => setPick((n) => n + 1), testId: 'row-category-move' },
    ...(current ? [{ label: t('roomCategories.takeOut'), icon: <FolderMinus size={14} aria-hidden />, onSelect: () => void act.file(o.room.id, null, current), testId: 'row-category-out' }] : []),
  ]
  const choices: MenuItem[] = [
    ...list.map((c) => ({ label: c.name, icon: <Tag size={14} aria-hidden />, checked: c.id === current?.id, onSelect: () => void (c.id !== current?.id && act.file(o.room.id, c, current)), testId: 'row-category-pick' })),
    {
      label: t('roomCategories.newAndMove'),
      icon: <FolderPlus size={14} aria-hidden />,
      onSelect: async () => {
        const c = await act.create()
        if (c) await act.file(o.room.id, c, current)
      },
      testId: 'row-category-pick-new',
    },
  ]
  const picker = pick > 0 && (
    <MenuButton
      label={t('roomCategories.moveTo')}
      heading={t('roomCategories.heading')}
      items={choices}
      footer={<p className="max-w-60 px-2 pt-1 pb-1.5 text-xs text-muted max-md:px-3 max-md:pb-2">{t('roomCategories.everyoneSees')}</p>}
      openRequest={pick}
      className="absolute right-1.5 bottom-0"
      buttonClassName="hidden!"
      focusBack={() => o.more.current?.focus()}
      testId="row-category-picker"
    />
  )
  return { items, picker }
}
