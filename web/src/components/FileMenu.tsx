// The right-click menu of a picture or a file (docs/DECISIONS.md "A right-click menu on pictures and files"): a room's
// or a thread's picture and file chip, an AI chat's attachment, and the image viewer's picture. The app's own menu
// (rooms/MenuButton.tsx, the look of every other menu; a bottom sheet on phones) at the pointer, with what applies
// (lib/fileMenu.ts): 이미지 복사, 링크 복사, 내려받기, 트리나에게 묻기. Ways to it: a right-click (Shift+right-click keeps
// the browser's own menu), the menu key or Shift+F10 on the focused picture, and a long press with a finger. In the
// desktop app the page takes these right-clicks itself, so the app's own menu (desktop/src/main/context-menu.ts) does
// not open over them; it still answers text, links and other pictures.
import { Download, ImageIcon, Link2 } from 'lucide-react'
import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { useT } from '../i18n'
import { canCopyImage, COPY_FAILED, copyImage, pickFromAddress } from '../lib/copyImage'
import { fileMenuActions, isMenuKey, type FileMenuAction, type FileMenuTarget } from '../lib/fileMenu'
import { toast } from '../store/ui'
import { AiMark } from './rooms/AiFace'
import { MenuButton, useLongPress, type MenuItem } from './rooms/MenuButton'
import { useCopy } from './ui'

export type { FileMenuTarget }

/** The link on the clipboard, and who can open it. */
export function useCopyFileLink() {
  const t = useT()
  const { copy } = useCopy()
  return async (link: string) => {
    await copy(link)
    toast({ level: 'success', text: t('fileMenu.linkCopied') })
  }
}

/** 이미지 복사 of a picture read from its address (not the viewer's, which copies what it drew), with its toast. Called
 * inside the click: Safari takes the clipboard only there. */
export function copyImageFrom(image: NonNullable<FileMenuTarget['image']>, t: ReturnType<typeof useT>) {
  void copyImage({ pick: pickFromAddress(image.src, image.thumb) }).then((r) => {
    if (!r.ok && r.reason === 'cancelled') return
    const detail = r.ok ? (r.smaller === 'thumb' ? t('viewer.copiedThumb') : r.smaller === 'scaled' ? t('viewer.copiedScaled') : undefined) : t(COPY_FAILED[r.reason as keyof typeof COPY_FAILED])
    toast({ level: r.ok ? 'success' : 'error', text: r.ok ? t('viewer.copied') : t('viewer.copyFailed'), detail })
  })
}

/** The menu's items for this picture or file. */
export function useFileMenuItems(target: FileMenuTarget | null): MenuItem[] {
  const t = useT()
  const copyLink = useCopyFileLink()
  if (!target) return []
  const icon = (I: typeof Link2) => <I size={14} className="shrink-0" aria-hidden />
  const make: Record<FileMenuAction, () => MenuItem> = {
    copyImage: () => ({ label: t('fileMenu.copyImage'), icon: icon(ImageIcon), onSelect: () => (target.copyImage ? target.copyImage() : copyImageFrom(target.image!, t)), testId: 'file-menu-copy-image' }),
    copyLink: () => ({ label: t('rooms.menu.copyLink'), icon: icon(Link2), onSelect: () => void copyLink(target.link!), testId: 'file-menu-copy-link' }),
    download: () => ({ label: t('common.download'), icon: icon(Download), onSelect: () => target.download!(), testId: 'file-menu-download' }),
    ask: () => ({ label: t('sideChat.askAboutFile'), icon: <AiMark place="menu" />, onSelect: () => target.ask!(), testId: 'file-menu-ask' }),
  }
  return fileMenuActions(target, canCopyImage()).map((a) => make[a]())
}

type Point = { x: number; y: number }

/**
 * The right-click menu of one picture or file: spread `bind` on the element (the picture's button, the file's chip),
 * put `menu` beside it (inside the same dialog, so the keyboard stays in it), and wrap the element's click with `guard`
 * (the finger lifting after a long press opens nothing). null: no menu, the element keeps the browser's own.
 */
export function useFileMenu(target: FileMenuTarget | null): { bind: Record<string, unknown>; menu: ReactNode; guard: (e: MouseEvent) => boolean; on: boolean; openAt: (el: HTMLElement, target: EventTarget, p: Point | null) => void } {
  const t = useT()
  const items = useFileMenuItems(target)
  const [request, setRequest] = useState(0)
  const [signal, setSignal] = useState(0)
  const [at, setAt] = useState<Point | null>(null)
  const from = useRef<HTMLElement | null>(null)
  const pressAt = useRef<Point | null>(null)
  const pressedAt = useRef(0)
  const longPress = useLongPress(() => {
    pressedAt.current = Date.now()
    setAt(pressAt.current)
    setSignal((n) => n + 1)
  })
  const on = !!target && items.length > 0
  /** opened over `el` (at the pointer, else under it); the keyboard comes back to what had it (the picture's button) */
  const openAt = (el: HTMLElement, target: EventTarget, p: Point | null) => {
    from.current = (target instanceof Element ? target.closest<HTMLElement>('button, a[href], [tabindex]') : null) ?? el
    const r = el.getBoundingClientRect()
    setAt(p ?? { x: r.left, y: r.bottom })
    setRequest((n) => n + 1)
  }
  const bind = on
    ? {
        'data-own-menu': '',
        onContextMenu: (e: MouseEvent<HTMLElement>) => {
          // a finger's long press opened it already (and keeps the phone's own menu away); Shift keeps the browser's own
          longPress.onContextMenu(e)
          if (e.defaultPrevented || e.shiftKey) return
          e.preventDefault()
          e.stopPropagation()
          // from the keyboard (the menu key) the browser gives no pointer: under the element
          openAt(e.currentTarget, e.target, e.button === 2 || e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null)
        },
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
          if (!isMenuKey(e)) return
          e.preventDefault()
          e.stopPropagation()
          openAt(e.currentTarget, e.target, null)
        },
        onPointerDown: (e: PointerEvent<HTMLElement>) => {
          from.current = (e.target instanceof Element ? e.target.closest<HTMLElement>('button, a[href], [tabindex]') : null) ?? e.currentTarget
          pressAt.current = { x: e.clientX, y: e.clientY }
          longPress.onPointerDown(e)
        },
        onPointerMove: longPress.onPointerMove,
        onPointerUp: longPress.onPointerUp,
        onPointerCancel: longPress.onPointerCancel,
      }
    : {}
  const menu = on ? (
    <MenuButton
      label={t('files.actionsFor', { name: target!.name })}
      items={items}
      className="absolute"
      buttonClassName="hidden!"
      openRequest={request}
      openSignal={signal}
      at={at}
      sheetTitle={target!.name}
      focusBack={() => from.current?.focus({ preventScroll: true })}
      testId="file-menu"
    />
  ) : null
  return { bind, menu, on, openAt, guard: (e) => {
    if (Date.now() - pressedAt.current >= 800) return false
    e.preventDefault()
    return true
  } }
}
