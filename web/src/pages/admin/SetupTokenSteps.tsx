// Connecting a Claude subscription: run one command, approve in the browser, paste what the terminal printed. The field
// for the token is the third step itself (children), so "paste it here" points at the box under the words, and a picture
// shows which line to copy. Installing Claude Code is folded away, with this computer's command first: most people who
// come here have it.
import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import { CopyButton } from '../../components/ui'
import { platform } from '../../lib/pwa'

function CommandLine({ text }: { text: string }) {
  return (
    <span className="my-1 flex items-center gap-1 rounded-md bg-subtle px-2 py-1 font-mono text-xs">
      <code className="min-w-0 flex-1 [overflow-wrap:anywhere]">{text}</code>
      <CopyButton text={text} />
    </span>
  )
}

function Step({ n, title, last, children }: { n: number; title: string; last?: boolean; children?: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex shrink-0 flex-col items-center">
        <span className="flex size-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">{n}</span>
        {!last && <span className="w-px flex-1 bg-line" />}
      </span>
      <div className={`min-w-0 flex-1 ${last ? '' : 'pb-4'}`}>
        <p className="pt-0.5 text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  )
}

/** The terminal after the command: which line is the token. The middle of it is dots, no token looks like this. */
function TerminalPicture() {
  return (
    <div aria-hidden="true" className="mt-2 select-none overflow-hidden rounded-lg bg-code-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed text-code-ink">
      <p className="truncate opacity-70">$ claude setup-token</p>
      <p className="truncate"><span className="rounded bg-accent px-1 py-0.5 font-semibold text-accent-ink">sk-ant-oat01-••••••••••••••••••••••</span></p>
    </div>
  )
}

export function SetupTokenSteps({ children }: { children: ReactNode }) {
  const t = useT()
  const mac = (
    <>
      <span className="text-xs text-muted">{t('credentials.setupToken.steps.1mac')}</span>
      <CommandLine text="curl -fsSL https://claude.ai/install.sh | bash" />
    </>
  )
  const windows = (
    <>
      <span className="text-xs text-muted">{t('credentials.setupToken.steps.1win')}</span>
      <CommandLine text="irm https://claude.ai/install.ps1 | iex" />
    </>
  )
  return (
    <ol data-testid="setup-token-steps">
      <Step n={1} title={t('credentials.setupToken.steps.1')}>
        <CommandLine text="claude setup-token" />
        <details className="text-xs" data-testid="setup-token-install">
          <summary className="cursor-pointer py-1 text-accent-text">{t('credentials.setupToken.install')}</summary>
          <div>
            {platform() === 'windows' ? <>{windows}{mac}</> : <>{mac}{windows}</>}
          </div>
        </details>
      </Step>
      <Step n={2} title={t('credentials.setupToken.steps.2')}>
        <p className="mt-0.5 text-xs text-muted">{t('credentials.setupToken.steps.2hint')}</p>
      </Step>
      <Step n={3} title={t('credentials.setupToken.steps.3')} last>
        <TerminalPicture />
        <div className="mt-2 space-y-1">
          {children}
          <p className="text-xs text-muted">{t('credentials.setupToken.steps.3hint')}</p>
        </div>
      </Step>
    </ol>
  )
}
