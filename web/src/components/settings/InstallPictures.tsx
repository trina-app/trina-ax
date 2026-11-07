// Settings > Apps: the steps of installing the app, each with a small picture of the screen and the place to tap or
// click: a phone's home screen (iPhone, Android) and a computer (Chrome or Edge from the address bar, Safari on a Mac
// from File → Add to Dock). The pictures are drawn with HTML so their words follow the five languages and their colours
// follow the theme; they repeat what the caption says, so screen readers skip them. They show this team's own address
// and the product's icon in the tab, the page and as the installed app's icon, as the real ones are (a team logo shows
// only in the computer's sidebar header; docs/DECISIONS.md "Team logo as the tab icon", changed 2026-11-07). iOS 26:
// Safari's default layout has no share button in sight, it is in the ⋯ menu next to the address bar
// (older systems and the other Safari layouts show it in the toolbar: the caption says so).
import { ChevronLeft, ChevronRight, Minus, MonitorDown, MoreHorizontal, MoreVertical, Share, Square, SquarePlus, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { PRODUCT } from '@mycel/shared'
import { useT, type MessageKey } from '../../i18n'

type Translate = ReturnType<typeof useT>

/** what to tap */
const TARGET = 'bg-accent-soft font-semibold text-accent-text ring-2 ring-accent'
const HOME_APPS = 8

function Phone({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden="true" className="relative flex aspect-[3/5] w-full select-none flex-col overflow-hidden rounded-[18px] border-2 border-line-strong/50 bg-canvas text-[10px] leading-tight text-ink shadow-sm">
      {children}
    </div>
  )
}

/** the tab icon (and the page's and the share sheet's): the product's mark, as index.html links it */
const TabIcon = ({ className }: { className: string }) => <img src="/favicon.svg" alt="" className={className} />
/** the installed app's icon (install sheets, home screen, Dock, its window): the product's (web/public/icons) */
const AppIcon = ({ className }: { className: string }) => <img src="/icons/icon-512.png" alt="" className={className} data-testid="install-app-icon" />
const host = () => (typeof location === 'undefined' ? '' : location.host)

/** the team page, as a calm outline */
function Page() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2.5">
      <div className="flex items-center gap-1.5">
        <TabIcon className="size-4 rounded" />
        <span className="truncate font-semibold">{PRODUCT.displayName}</span>
      </div>
      <Lines />
    </div>
  )
}

function Lines() {
  return (
    <>
      <span className="h-1.5 w-11/12 rounded-full bg-line" />
      <span className="h-1.5 w-3/4 rounded-full bg-line" />
      <span className="h-1.5 w-5/6 rounded-full bg-line" />
    </>
  )
}

/** the rows of a menu that do not matter */
function Rows({ n = 2 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="flex items-center gap-1.5 px-2 py-1.5">
          <span className="size-2.5 shrink-0 rounded-sm bg-line" />
          <span className="h-1.5 flex-1 rounded-full bg-line" />
        </span>
      ))}
    </>
  )
}

function Row({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`flex items-center justify-between gap-1 rounded-md px-2 py-1.5 ${TARGET}`}>
      <span className="min-w-0">{children}</span>
      {icon}
    </span>
  )
}

/** Safari's bar on iOS 26: at the bottom, with ⋯ beside the address */
function SafariBar({ target }: { target?: boolean }) {
  return (
    <div className="flex items-center gap-1 bg-subtle px-1.5 py-1.5">
      <ChevronLeft size={13} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate rounded-full bg-surface px-2 py-1 text-center text-[9px] text-muted">{host()}</span>
      <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${target ? TARGET : 'text-muted'}`}><MoreHorizontal size={13} /></span>
    </div>
  )
}

function IosMore({ t }: { t: Translate }) {
  return (
    <Phone>
      <Page />
      <div className="absolute inset-x-1.5 bottom-9 flex flex-col rounded-xl border border-line bg-surface p-1 shadow-sm">
        <Row icon={<Share size={12} className="shrink-0" />}>{t('apps.mockShare')}</Row>
        <Rows />
      </div>
      <SafariBar target />
    </Phone>
  )
}

function IosShare({ t }: { t: Translate }) {
  return (
    <Phone>
      <div className="flex min-h-0 flex-1 flex-col bg-subtle pt-5">
        <div className="flex min-h-0 flex-1 flex-col rounded-t-xl bg-surface p-1">
          <span className="flex items-center gap-1.5 p-1.5">
            <TabIcon className="size-5 rounded" />
            <span className="min-w-0 truncate text-[9px] text-muted">{host()}</span>
          </span>
          <Rows n={3} />
          <Row icon={<SquarePlus size={12} className="shrink-0" />}>{t('apps.mockAddHome')}</Row>
          <Rows />
        </div>
      </div>
    </Phone>
  )
}

function IosAdd({ t }: { t: Translate }) {
  return (
    <Phone>
      <div className="flex min-h-0 flex-1 flex-col bg-subtle pt-5">
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 rounded-t-xl bg-surface p-1.5">
          <span className="flex items-center justify-between">
            <span className="px-1 text-muted">{t('apps.mockCancel')}</span>
            <span className={`rounded-md px-2 py-1 ${TARGET}`}>{t('apps.mockAdd')}</span>
          </span>
          <span className="flex items-center gap-1.5 rounded-lg bg-subtle p-1.5">
            <AppIcon className="size-7 shrink-0 rounded-md" />
            <span className="min-w-0">
              <span className="block truncate font-semibold">{PRODUCT.displayName}</span>
              <span className="block truncate text-[9px] text-muted">{host()}</span>
            </span>
          </span>
          <span className="flex items-center justify-between gap-1 rounded-lg bg-subtle p-1.5">
            <span className="min-w-0 text-[9px]">{t('apps.mockWebApp')}</span>
            <span className="flex h-3 w-5 shrink-0 items-center justify-end rounded-full bg-ok p-0.5"><span className="size-2 rounded-full bg-surface" /></span>
          </span>
        </div>
      </div>
    </Phone>
  )
}

/** Chrome's bar on Android: at the top, with ⋮ at the end */
function ChromeBar({ target }: { target?: boolean }) {
  return (
    <div className="flex items-center gap-1 bg-subtle px-1.5 py-1.5">
      <span className="min-w-0 flex-1 truncate rounded-full bg-surface px-2 py-1 text-[9px] text-muted">{host()}</span>
      <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${target ? TARGET : 'text-muted'}`}><MoreVertical size={13} /></span>
    </div>
  )
}

function AndroidMenuButton() {
  return (
    <Phone>
      <ChromeBar target />
      <Page />
      <div className="flex items-center justify-between bg-subtle px-3 py-1.5 text-muted"><ChevronLeft size={12} /><ChevronRight size={12} /></div>
    </Phone>
  )
}

function AndroidMenu({ t }: { t: Translate }) {
  return (
    <Phone>
      <ChromeBar />
      <Page />
      <div className="absolute inset-x-1.5 top-8 flex flex-col rounded-lg border border-line bg-surface p-1 shadow-sm">
        <Rows n={3} />
        <Row>{t('apps.mockInstallApp')}</Row>
        <Rows />
      </div>
    </Phone>
  )
}

function AndroidInstall({ t }: { t: Translate }) {
  return (
    <Phone>
      <ChromeBar />
      <div className="flex min-h-0 flex-1 flex-col justify-end bg-subtle">
        <div className="flex flex-col gap-2.5 rounded-t-xl bg-surface p-2">
          <span className="flex items-center justify-between text-muted"><span className="min-w-0 truncate font-semibold text-ink">{t('apps.mockInstallApp')}</span><X size={11} className="shrink-0" /></span>
          <span className="flex items-center gap-1.5">
            <AppIcon className="size-7 shrink-0 rounded-full" />
            <span className="min-w-0">
              <span className="block truncate font-semibold">{PRODUCT.displayName}</span>
              <span className="block truncate text-[9px] text-muted">{host()}</span>
            </span>
          </span>
          <span className="flex items-center justify-end gap-1">
            <span className="px-1.5 text-muted">{t('apps.mockCancel')}</span>
            <span className={`rounded-full px-2.5 py-1 ${TARGET}`}>{t('apps.mockInstall')}</span>
          </span>
        </div>
      </div>
    </Phone>
  )
}

function HomeScreen({ round }: { round?: boolean }) {
  const shape = round ? 'rounded-full' : 'rounded-xl'
  return (
    <Phone>
      <div className="grid flex-1 grid-cols-3 content-start gap-x-2.5 gap-y-2 bg-subtle p-3 pt-5">
        {Array.from({ length: HOME_APPS }, (_, i) => (
          <span key={i} className="flex min-w-0 flex-col items-center gap-1">
            <span className={`aspect-square w-full bg-line ${shape}`} />
            <span className="h-1 w-2/3 rounded-full bg-line" />
          </span>
        ))}
        <span className={`-m-1 flex min-w-0 flex-col items-center gap-1 rounded-lg p-1 ${TARGET}`}>
          <AppIcon className={`aspect-square w-full ${shape}`} />
          <span className="max-w-full truncate text-[9px]">{PRODUCT.displayName}</span>
        </span>
      </div>
    </Phone>
  )
}

export type PicturePlatform = 'ios' | 'android'

const STEPS: Record<PicturePlatform, { caption: MessageKey; picture: (t: Translate) => ReactNode }[]> = {
  ios: [
    { caption: 'apps.iosShot1', picture: (t) => <IosMore t={t} /> },
    { caption: 'apps.iosShot2', picture: (t) => <IosShare t={t} /> },
    { caption: 'apps.iosShot3', picture: (t) => <IosAdd t={t} /> },
    { caption: 'apps.iosStep3', picture: () => <HomeScreen /> },
  ],
  android: [
    { caption: 'apps.androidShot1', picture: () => <AndroidMenuButton /> },
    { caption: 'apps.androidShot2', picture: (t) => <AndroidMenu t={t} /> },
    { caption: 'apps.androidShot3', picture: (t) => <AndroidInstall t={t} /> },
    { caption: 'apps.androidStep3', picture: () => <HomeScreen round /> },
  ],
}

export function InstallPictures({ platform }: { platform: PicturePlatform }) {
  const t = useT()
  return (
    <ol className="mt-3 grid max-w-2xl grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4" data-testid={`install-steps-${platform}`}>
      {STEPS[platform].map((s, i) => (
        <li key={s.caption} className="min-w-0">
          {s.picture(t)}
          <p className="mt-2 flex gap-1.5 break-keep text-xs leading-relaxed text-muted">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-text">{i + 1}</span>
            <span className="min-w-0">{t(s.caption)}</span>
          </p>
        </li>
      ))}
    </ol>
  )
}

// ---------------- a computer ----------------

/** a computer's screen: wider than a phone's */
function Screen({ children, desk }: { children: ReactNode; desk?: boolean }) {
  return (
    <div aria-hidden="true" className={`relative flex aspect-[16/10] w-full select-none flex-col overflow-hidden rounded-lg border-2 border-line-strong/50 text-[9px] leading-tight text-ink shadow-sm ${desk ? 'bg-subtle' : 'bg-canvas'}`}>
      {children}
    </div>
  )
}

/** a browser's tab and toolbar; `install`: the install icon at the end of the address bar (Chrome and Edge) */
function BrowserBar({ install, target }: { install?: boolean; target?: boolean }) {
  return (
    <>
      <div className="flex items-end gap-1 bg-subtle px-1.5 pt-1">
        <span className="flex min-w-0 max-w-[55%] items-center gap-1 rounded-t-md bg-surface px-1.5 py-1">
          <TabIcon className="size-2.5 shrink-0 rounded-sm" />
          <span className="truncate">{PRODUCT.displayName}</span>
        </span>
      </div>
      <div className="flex items-center gap-1 border-b border-line bg-surface px-1.5 py-1">
        <ChevronLeft size={10} className="shrink-0 text-muted" />
        <ChevronRight size={10} className="shrink-0 text-muted" />
        <span className="flex min-w-0 flex-1 items-center gap-1 rounded-full bg-subtle py-0.5 pr-0.5 pl-2">
          <span className="min-w-0 flex-1 truncate text-muted">{host()}</span>
          {install && <span className={`flex size-4 shrink-0 items-center justify-center rounded-full ${target ? TARGET : 'text-muted'}`}><MonitorDown size={10} /></span>}
        </span>
        <MoreVertical size={10} className="shrink-0 text-muted" />
      </div>
    </>
  )
}

function ChromeAddress() {
  return (
    <Screen>
      <BrowserBar install target />
      <Page />
    </Screen>
  )
}

function ChromeInstall({ t }: { t: Translate }) {
  return (
    <Screen>
      <BrowserBar install />
      <Page />
      <div className="absolute top-[42%] right-2 flex w-[64%] flex-col gap-1.5 rounded-lg border border-line bg-surface p-1.5 shadow-md">
        <span className="font-semibold">{t('apps.mockInstallApp')}</span>
        <span className="flex items-center gap-1.5">
          <AppIcon className="size-5 shrink-0 rounded" />
          <span className="min-w-0">
            <span className="block truncate font-semibold">{PRODUCT.displayName}</span>
            <span className="block truncate text-[8px] text-muted">{host()}</span>
          </span>
        </span>
        <span className="flex items-center justify-end gap-1">
          <span className="px-1 text-muted">{t('apps.mockCancel')}</span>
          <span className={`rounded-full px-2 py-0.5 ${TARGET}`}>{t('apps.mockInstall')}</span>
        </span>
      </div>
    </Screen>
  )
}

export type ComputerOs = 'mac' | 'windows' | 'other'

/** the installed app: its own window without an address bar, and its icon in the Dock (Mac) or the taskbar (Windows) */
function AppWindow({ os }: { os: ComputerOs }) {
  const icons = (
    <>
      {Array.from({ length: 3 }, (_, i) => <span key={i} className="size-3.5 rounded bg-line" />)}
      <span className={`flex rounded p-0.5 ${TARGET}`}><AppIcon className="size-3.5 rounded" /></span>
    </>
  )
  return (
    <Screen desk>
      <div className={`mx-[9%] mt-[5%] flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-line bg-canvas shadow-sm ${os === 'other' ? 'mb-[5%]' : ''}`}>
        <span className="flex items-center gap-1 border-b border-line bg-surface px-1.5 py-1">
          {os === 'mac' && <span className="flex shrink-0 gap-0.5">{['bg-danger/70', 'bg-warn/70', 'bg-ok/70'].map((c) => <span key={c} className={`size-1.5 rounded-full ${c}`} />)}</span>}
          <AppIcon className="size-2.5 shrink-0 rounded-sm" />
          <span className="min-w-0 flex-1 truncate">{PRODUCT.displayName}</span>
          {os === 'windows' && <span className="flex shrink-0 items-center gap-1 text-muted"><Minus size={8} /><Square size={7} /><X size={8} /></span>}
        </span>
        <Page />
      </div>
      {os === 'mac' && <span className="mx-auto my-1 flex items-center gap-1 rounded-md border border-line bg-surface px-1 py-0.5">{icons}</span>}
      {os === 'windows' && <span className="mt-1 flex items-center justify-center gap-1 border-t border-line bg-surface py-0.5">{icons}</span>}
    </Screen>
  )
}

/** Safari on a Mac: the menu bar's File menu open on Add to Dock… */
function SafariFileMenu({ t }: { t: Translate }) {
  return (
    <Screen>
      <span className="flex items-center gap-2 border-b border-line bg-surface px-1.5 py-0.5">
        <span className="font-semibold">Safari</span>
        <span className={`rounded px-1 ${TARGET}`}>{t('apps.mockFile')}</span>
        <span className="text-muted">{t('apps.mockEdit')}</span>
        <span className="text-muted">{t('apps.mockView')}</span>
      </span>
      <div className="flex items-center gap-1 border-b border-line bg-subtle px-1.5 py-1">
        <span className="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-0.5 text-center text-muted">{host()}</span>
      </div>
      <Page />
      <div className="absolute top-4 left-8 flex w-[52%] flex-col rounded-md border border-line bg-surface p-0.5 shadow-md">
        <Rows />
        <Row>{t('apps.mockAddToDock')}</Row>
        <Rows />
      </div>
    </Screen>
  )
}

function SafariAdd({ t }: { t: Translate }) {
  return (
    <Screen>
      <span className="flex items-center gap-2 border-b border-line bg-surface px-1.5 py-0.5"><span className="font-semibold">Safari</span></span>
      {/* the page behind the sheet, dimmed: only the sheet is read */}
      <div className="flex min-h-0 flex-1 flex-col opacity-30"><Page /></div>
      <div className="absolute inset-x-[16%] top-[22%] flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-1.5 shadow-md">
        <span className="flex items-center gap-1.5">
          <AppIcon className="size-6 shrink-0 rounded-md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate rounded border border-line px-1 py-0.5">{PRODUCT.displayName}</span>
            <span className="mt-0.5 block truncate text-[8px] text-muted">{host()}</span>
          </span>
        </span>
        <span className="flex items-center justify-end gap-1">
          <span className="rounded px-1.5 py-0.5 text-muted">{t('apps.mockCancel')}</span>
          <span className={`rounded px-2 py-0.5 ${TARGET}`}>{t('apps.mockAdd')}</span>
        </span>
      </div>
    </Screen>
  )
}

/** what opens the installed app next time, by computer */
const OPEN_AGAIN: Record<ComputerOs, MessageKey> = { mac: 'apps.desktopShot3Mac', windows: 'apps.desktopShot3Windows', other: 'apps.desktopShot3Other' }

export type ComputerFlow = 'chromium' | 'safari'

/** A computer's steps with pictures: Chrome or Edge (the address bar's install icon), or Safari on a Mac (File → Add
 * to Dock). The last picture is the app in its own window, in the Dock or the taskbar. */
export function ComputerPictures({ flow, os }: { flow: ComputerFlow; os: ComputerOs }) {
  const t = useT()
  const steps: { caption: MessageKey; picture: ReactNode }[] = flow === 'safari'
    ? [
        { caption: 'apps.safariShot1', picture: <SafariFileMenu t={t} /> },
        { caption: 'apps.safariShot2', picture: <SafariAdd t={t} /> },
        { caption: 'apps.safariShot3', picture: <AppWindow os="mac" /> },
      ]
    : [
        { caption: 'apps.desktopShot1', picture: <ChromeAddress /> },
        { caption: 'apps.desktopShot2', picture: <ChromeInstall t={t} /> },
        { caption: OPEN_AGAIN[os], picture: <AppWindow os={os} /> },
      ]
  return (
    <ol className="mt-3 grid max-w-3xl gap-x-3 gap-y-4 sm:grid-cols-3" data-testid={`install-steps-${flow}`}>
      {steps.map((s, i) => (
        <li key={s.caption} className="max-w-[280px] min-w-0 sm:max-w-none">
          {s.picture}
          <p className="mt-2 flex gap-1.5 break-keep text-xs leading-relaxed text-muted">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-text">{i + 1}</span>
            <span className="min-w-0">{t(s.caption, { product: PRODUCT.displayName })}</span>
          </p>
        </li>
      ))}
    </ol>
  )
}
