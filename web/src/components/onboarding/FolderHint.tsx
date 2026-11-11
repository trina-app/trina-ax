// The hint under a skill folder picker (docs/DECISIONS.md "SK", "W5", "MC"): where Claude's folder (.claude) and Codex's
// (.codex, .agents) are, and the keys that show hidden folders in this computer's folder window. Team skills › Bring my
// skills (components/skills/BringSkillsSheet.tsx) and a member's skill folder pick (ContributeSheet.tsx) show it.
import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import { withNodes } from './SkillShareReview'

export type Os = 'mac' | 'windows' | 'linux' | 'other'
export function osOf(): Os {
  if (typeof navigator === 'undefined') return 'other'
  const n = navigator as Navigator & { userAgentData?: { platform?: string } }
  const p = `${n.userAgentData?.platform ?? ''} ${n.platform ?? ''} ${n.userAgent ?? ''}`
  if (/Mac|iPhone|iPad/i.test(p)) return 'mac'
  if (/Win/i.test(p)) return 'windows'
  if (/Linux|X11|CrOS/i.test(p)) return 'linux'
  return 'other'
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mx-px inline-block min-w-5 rounded-[5px] border border-b-2 border-line-strong bg-surface px-1 text-center font-mono text-xs leading-[1.0625rem] text-ink">{children}</kbd>
}

/**
 * The hint's text for this way of picking: `app` (the Mac App Store build opens its own window at .claude), `handle`
 * (Chrome and Edge: the folder window shows hidden folders with a key), else <input webkitdirectory> (Safari, Firefox:
 * pick .claude/skills).
 */
export function FolderHint({ app, handle, os = osOf() }: { app: boolean; handle: boolean; os?: Os }) {
  const t = useT()
  const folder = <b className="font-semibold text-ink">.claude</b>
  const codex = <b className="font-semibold text-ink">.codex</b>
  const agents = <b className="font-semibold text-ink">.agents</b>
  const keys = (shown: string[], said: string) => (
    <>
      {/* the keys stay together on one line (⌘ at a line's end and ⇧ . on the next read as two hints) */}
      <span aria-hidden className="whitespace-nowrap">{shown.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
      <span className="sr-only">{said}</span>
    </>
  )
  if (app) return <>{withNodes(t('welcome.skills.hintDesktop'), { folder: <span className="font-mono">.claude</span>, codex: <span className="font-mono">.codex</span>, agents: <span className="font-mono">.agents</span>, button: <b className="font-semibold text-ink">{t('welcome.skills.desktopButton')}</b> })}</>
  if (!handle) return <>{withNodes(t(os === 'mac' ? 'welcome.skills.hintSkillsOnlyMac' : 'welcome.skills.hintSkillsOnly'), { folder, codex, agents, keys: keys(['⌘', '⇧', '.'], t('welcome.skills.keysMac')) })}</>
  if (os === 'mac') return <>{withNodes(t('welcome.skills.hintMac'), { folder, codex, agents, keys: keys(['⌘', '⇧', '.'], t('welcome.skills.keysMac')) })}</>
  if (os === 'linux') return <>{withNodes(t('welcome.skills.hintLinux'), { folder, codex, agents, keys: keys(['Ctrl', 'H'], t('welcome.skills.keysLinux')) })}</>
  return <>{withNodes(t('welcome.skills.hintWindows'), { folder, codex, agents })}</>
}
