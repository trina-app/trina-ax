// The two pages of "Sign in with Slack" (and of the official app's "Add to Slack") outside Settings (docs/SLACK.md).
// /slack/signin-return: Slack (or the hosting service) sent the browser back to the server with no session there (the
//   desktop app opens Slack in the system browser, the phone app in an in-app browser); the person signed in, and this
//   page sends the browser to the callback again with the same state and code (or handoff). Only to those fixed
//   addresses, with only those values.
// /slack/done: the end of a sign-in or an install started in the desktop or phone app, in the browser it finished in:
//   done, back to the app (its Settings line shows the link when the app is used again).
import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useT } from '../i18n'
import { installOutcome, outcomeText, resumeTarget } from '../lib/slackSignIn'

export function SlackSignInReturn() {
  const t = useT()
  const { search } = useLocation()
  const target = resumeTarget(search)
  useEffect(() => { if (target) window.location.replace(target) }, [target])
  return (
    <section className="mx-auto max-w-xl space-y-3 p-4 sm:p-6" data-testid="slack-signin-return">
      <h1 className="text-xl font-semibold">Slack</h1>
      <p className="text-sm text-muted">{t(target ? 'slack.signin.resuming' : 'slack.signin.returnBad')}</p>
    </section>
  )
}

export function SlackDone({ signedIn }: { signedIn: boolean }) {
  const t = useT()
  const code = new URLSearchParams(useLocation().search).get('slack') ?? ''
  const ok = code === 'linked' || code === 'installed'
  return (
    <section className="mx-auto max-w-xl space-y-3 p-4 sm:p-6" data-testid="slack-done">
      <h1 className="text-xl font-semibold">Slack</h1>
      <p className={`text-sm ${ok ? '' : 'text-warn'}`} role="status" data-testid="slack-done-text">{t(code === 'linked' ? 'slack.signin.doneApp' : code === 'installed' ? 'slack.install.doneApp' : outcomeText(code))}</p>
      {signedIn && !installOutcome(code) && <Link to="/connectors" className="text-sm text-accent underline-offset-2 hover:underline">{t('slack.link.toSettings')}</Link>}
    </section>
  )
}
