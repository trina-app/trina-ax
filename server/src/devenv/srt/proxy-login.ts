// srt's proxy login in a run's output (QA TC-4928). srt 0.0.81 gives each run's command the login of its own network
// proxy in the environment (sandbox-utils.js generateProxyEnvVars): http_proxy / https_proxy / ALL_PROXY / … as
// http://srt.<the command, base64>:<token>@localhost:<port>, CLOUDSDK_PROXY_PASSWORD, socat's proxyauth= and the
// "Proxy-Authorization: Basic …" line of GIT_SSH_COMMAND's SRT_SSH_PROXY_COMMAND. The token is random per srt process
// (sandbox-manager.js: randomBytes(16) when the proxy starts), so per run; the proxy lives in that process and ends with
// the run, and only the run reaches it (Linux: through the bridge inside the run's own network namespace; the host
// proxy listens on 127.0.0.1 of the server, where no other run's namespace reaches; macOS: a run may connect only to
// its own proxy port). So the login is useless outside its run and gone when it ends. Commands need it (curl, npm, pip
// and git read these variables), so it stays in the environment; what a command prints is shown with it hidden, so an
// AI never pastes it into a chat (a shared chat's people see the output).
const HIDDEN = '<hidden>'

/** The text with every srt proxy login in it hidden. */
export function hideProxyLogin(s: string): string {
  if (!s) return s
  return s
    // user:token@ in a proxy URL (the user is srt or srt.<base64 of the command, percent-encoded>)
    .replace(/\b(srt(?:\.[A-Za-z0-9%+/=._-]*)?):[0-9a-f]{32}@/g, `$1:${HIDDEN}@`)
    // gcloud's variable, socat's proxyauth=user:token
    .replace(/\b(CLOUDSDK_PROXY_PASSWORD=)[0-9a-f]{32}\b/g, `$1${HIDDEN}`)
    .replace(/\b(proxyauth=srt[^:\s,]*):[0-9a-f]{32}\b/g, `$1:${HIDDEN}`)
    // a Basic proxy header (the ssh proxy script, curl -v)
    .replace(/(Proxy-Authorization:\s*Basic\s+)[A-Za-z0-9+/=]{8,}/gi, `$1${HIDDEN}`)
}
