// Stand-in for `claude setup-token` (Claude Code 2.1.305 shape), started by the real launcher on its pseudo-terminal for
// the Claude sign-in tests (docs/DECISIONS.md "Claude 구독 연결: 브라우저에서"). Like the real CLI it refuses to run
// without a terminal (isatty on stdin and stdout), switches the terminal to raw mode, never opens a browser
// (BROWSER must be the no-op the launcher sets), draws its screen with column jumps instead of spaces and colours, the
// authorize address as an OSC 8 hyperlink and as text, then the paste prompt; it reads a pasted code (bracketed paste
// and Enter), exchanges it through HTTPS_PROXY like the real one (CONNECT platform.claude.com:443 with the proxy user
// and password of the URL, then the profile lookup on api.anthropic.com:443, whose refusal it ignores) and prints the
// token. A code other than the good one ends like a 401 (the error and "Press Enter to retry"), and it waits.
// Settings (a wrapper script may export them): FAKE_CLAUDE_GOOD_CODE (good-code#good-state), FAKE_CLAUDE_TOKEN,
// FAKE_CLAUDE_URL (the authorize address), FAKE_CLAUDE_PROMPT_MS (0: how long before the prompt), FAKE_CLAUDE_LINGER=1
// (does not exit after the token), FAKE_CLAUDE_NO_EXCHANGE=1 (prints the token without the CONNECT).
import net from 'node:net'
import tty from 'node:tty'

export const FAKE_CLAUDE_TOKEN = 'sk-ant-oat01-' + 'fakeLoginToken'.repeat(6) + '-AA'
export const FAKE_CLAUDE_GOOD_CODE = 'good-code#good-state'
export const FAKE_CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-0000-0000-0000-000000000000&response_type=code'
  + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=fakeChallenge&code_challenge_method=S256&state=good-state'

const ESC = '\x1b'
/** words placed with column jumps, as Claude Code's renderer does */
const jumps = (s: string, col = 2) => s.split(' ').map((w) => { const out = `${ESC}[${col}G${w}`; col += w.length + 1; return out }).join('')

function connect(target: string): Promise<string> {
  const px = new URL(process.env.HTTPS_PROXY ?? 'http://x:y@127.0.0.1:1')
  return new Promise((res) => {
    const c = net.connect(Number(px.port), px.hostname)
    let b = ''
    c.on('connect', () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(px.username)}:${decodeURIComponent(px.password)}`).toString('base64')}\r\n\r\n`))
    c.on('data', (x) => { b += x.toString(); if (b.includes('\r\n')) { c.destroy(); res(b.split('\r\n')[0]!) } })
    c.on('error', (e) => res('error ' + e.message))
    c.on('close', () => res(b.split('\r\n')[0] || 'closed'))
  })
}

export async function fakeSetupToken(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] !== 'setup-token') { process.stderr.write('fake claude: only setup-token\n'); return 2 }
  if (!tty.isatty(0) || !tty.isatty(1)) { process.stderr.write('fake claude: setup-token needs a terminal (stdin is not a TTY)\n'); return 3 }
  if (process.env.BROWSER !== 'true') { process.stderr.write('fake claude: would open a browser\n'); return 4 }
  const out = (s: string) => process.stdout.write(s)
  const url = process.env.FAKE_CLAUDE_URL || FAKE_CLAUDE_URL
  const good = process.env.FAKE_CLAUDE_GOOD_CODE || FAKE_CLAUDE_GOOD_CODE
  const token = process.env.FAKE_CLAUDE_TOKEN || FAKE_CLAUDE_TOKEN
  process.stdin.setRawMode(true)
  out(`${ESC}7${ESC}[r${ESC}8${ESC}[?25l${ESC}[?2004h${ESC}[38;5;174m${jumps('Welcome to Claude Code', 1)}${ESC}[39m ${ESC}[38;5;246mv2.1.305${ESC}[39m\r\r\n\r\r\n`)
  out(`${ESC}[>0q${ESC}[c${ESC}[1m${jumps('This will guide you through long-lived (1-year) auth token setup for your Claude account.')}${ESC}[22m\r\r\n\r\r\n`)
  out(`${jumps("The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.")}\r\r\n`)
  out(`${ESC}[38;5;246m${jumps('Use the URL below to sign in (c to copy)')}${ESC}[39m\r\r\n\r\r\n`)
  out(`${ESC}]8;id=fake1;${url}\x07${ESC}[38;5;246m${url}${ESC}[39m${ESC}]8;;\x07\r\r\n\r\r\n`)
  await Bun.sleep(Number(process.env.FAKE_CLAUDE_PROMPT_MS ?? 0))
  out(`${jumps('Paste code here >')}\r\r\n`)
  // the code: a bracketed paste, then Enter (raw mode: every byte as it comes)
  let typed = ''
  const code = await new Promise<string>((res) => {
    process.stdin.on('data', (d: Buffer) => {
      typed += d.toString('utf8')
      const i = typed.indexOf('\r')
      if (i >= 0) res(typed.slice(0, i).replace(`${ESC}[200~`, '').replace(`${ESC}[201~`, ''))
      else out(`${ESC}[19G${'*'.repeat(Math.min(typed.length, 60))}`)
    })
  })
  process.stdin.pause()
  const refused = async () => {
    out(`\r\r\n${ESC}[31m${jumps('OAuth error: Authentication failed: Invalid authorization code')}${ESC}[39m\r\r\n\r\r\n${ESC}[35m${jumps('Press Enter to retry.')}${ESC}[39m\r\r\n`)
    await new Promise(() => {}) // waits for Enter, like the real one
  }
  if (code !== good) { await refused(); return 1 }
  if (!process.env.FAKE_CLAUDE_NO_EXCHANGE) {
    const st = await connect('platform.claude.com:443')
    if (!/ 200 /.test(st)) {
      out(`\r\r\n${ESC}[31m${jumps('OAuth error: Failed to exchange authorization code for access token. Please try again.')}${ESC}[39m\r\r\n\r\r\n${jumps('Press Enter to retry.')}\r\r\n`)
      await new Promise(() => {})
    }
    await connect('api.anthropic.com:443') // the profile lookup: refused, which the real CLI only logs
  }
  // the success screen redraws the region above (cursor up, erase), like Ink
  out(`${ESC}[3A${ESC}[J${ESC}[32m✓ ${jumps('Long-lived authentication token created successfully!', 4)}${ESC}[39m\r\r\n\r\r\n`)
  out(`${jumps('Your OAuth token (valid for 1 year):')}\r\r\n\r\r\n${ESC}[2G${ESC}[33m${token}${ESC}[39m\r\r\n\r\r\n`)
  out(`${ESC}[2m${jumps("Store this token securely. You won't be able to see it again.")}${ESC}[22m\r\r\n`)
  out(`${ESC}[2m${jumps('Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>')}${ESC}[22m\r\r\n`)
  if (process.env.FAKE_CLAUDE_LINGER) await new Promise(() => {})
  await Bun.sleep(500)
  out(`${ESC}[?2004l${ESC}[?25h`)
  return 0
}

if (import.meta.main) process.exit(await fakeSetupToken())
