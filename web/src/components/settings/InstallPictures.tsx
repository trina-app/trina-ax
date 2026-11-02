// Settings > Apps: the steps of adding the app to a phone's home screen, each with a small picture of the screen and the
// place to tap. The pictures are drawn with HTML so their words follow the five languages and their colours follow the
// theme; they repeat what the caption says, so screen readers skip them. They show this team's own address and icon.
// iOS 26: Safari's default layout has no share button in sight, it is in the ⋯ menu next to the address bar (older
// systems and the other Safari layouts show it in the toolbar: the caption says so).
import { ChevronLeft, ChevronRight, MoreHorizontal, MoreVertical, Share, SquarePlus, X } from 'lucide-react'
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

const TeamIcon = ({ className }: { className: string }) => <img src="/team-icon" alt="" className={className} />
const host = () => (typeof location === 'undefined' ? '' : location.host)

/** the team page, as a calm outline */
function Page() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2.5">
      <div className="flex items-center gap-1.5">
        <TeamIcon className="size-4 rounded" />
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
            <TeamIcon className="size-5 rounded" />
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
            <TeamIcon className="size-7 shrink-0 rounded-md" />
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
            <TeamIcon className="size-7 shrink-0 rounded-full" />
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
          <TeamIcon className={`aspect-square w-full ${shape}`} />
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
