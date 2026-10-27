// Stand-in for `codex login --device-auth` (codex-cli 0.163 output shape), started by the real launcher for the
// codex-login tests: prints the URL and the one-time code like the real CLI (with colours), opens a CONNECT tunnel to
// auth.openai.com:443 through HTTPS_PROXY (as the real CLI does, with the proxy user and password from the URL), and
// on success writes $CODEX_HOME/auth.json. When the proxy refuses the tunnel it fails like the real CLI.
// The wrapper script may set FAKE_LOGIN_ACCOUNT (default acc-login), FAKE_LOGIN_PLAN (plus), FAKE_LOGIN_WAIT_MS (300:
// how long "the person signs in"), FAKE_LOGIN_MISMATCH=1 (an id_token of another account).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const argv = process.argv.slice(2)
const home = process.env.CODEX_HOME ?? ''
if (argv[0] !== 'login' || !argv.includes('--device-auth')) { console.error('fake codex: only login --device-auth'); process.exit(2) }
if (!argv.includes('cli_auth_credentials_store="file"')) { console.error('fake codex: expected the file credential store'); process.exit(2) }
const px = new URL(process.env.HTTPS_PROXY ?? 'http://x:y@127.0.0.1:1')
const status = await new Promise<string>((res) => {
  const c = net.connect(Number(px.port), px.hostname)
  let b = ''
  c.on('connect', () => c.write(`CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`${px.username}:${px.password}`).toString('base64')}\r\n\r\n`))
  c.on('data', (x) => { b += x.toString(); if (b.includes('\r\n')) { c.destroy(); res(b.split('\r\n')[0]!) } })
  c.on('error', (e) => res('error ' + e.message))
  c.on('close', () => res(b.split('\r\n')[0] || 'closed'))
})
if (!/ 200 /.test(status)) {
  console.error(`Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode) [${status}]`)
  process.exit(1)
}
process.stdout.write(`\nWelcome to Codex [v\x1b[90m0.163.0\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mWXYZ-12AB3\x1b[0m\n\n`)
await Bun.sleep(Number(process.env.FAKE_LOGIN_WAIT_MS ?? 300)) // "the person signs in"
const account = process.env.FAKE_LOGIN_ACCOUNT ?? 'acc-login'
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const idToken = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': { chatgpt_plan_type: process.env.FAKE_LOGIN_PLAN ?? 'plus', chatgpt_account_id: process.env.FAKE_LOGIN_MISMATCH ? 'acc-other' : account, chatgpt_user_id: 'u-1' } })}.c2ln`
fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: 'at-login-' + account, refresh_token: 'r-login', account_id: account }, last_refresh: new Date().toISOString() }), { mode: 0o600 })
process.stdout.write('Successfully logged in\n')
