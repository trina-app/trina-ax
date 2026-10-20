// A team server that floods PINGs and never reads its connection (Node, so the socket can be paused).
// node flood-team.mjs <relay ws url> <team id> <base64 private key PEM> <repo root>
import { createRequire } from 'node:module'
import path from 'node:path'
const [, , url, teamId, pemB64, repo] = process.argv
const WebSocket = createRequire(path.join(repo, 'relay', 'package.json'))('ws')
const { encodeFrame, FrameType, pingPayload, authSigningString, signB64, loadPrivateKey } = await import(path.join(repo, 'shared/src/relay-protocol/index.ts'))
const key = loadPrivateKey(Buffer.from(pemB64, 'base64').toString())
const ws = new WebSocket(url)
ws.on('message', (d, bin) => {
  if (bin) return
  const m = JSON.parse(d.toString())
  if (m.t === 'challenge') {
    const ts = Date.now()
    ws.send(JSON.stringify({ t: 'auth', v: 2, team: teamId, instance: 'flooder1', conn: 0, ts, sig: signB64(key, authSigningString(teamId, 'flooder1', m.nonce, ts)) }))
    return
  }
  if (m.t !== 'ok') return
  console.log('authed')
  ws._socket.pause()
  const ping = encodeFrame(FrameType.PING, 0, 0, pingPayload(1))
  const batch = Buffer.concat(Array.from({ length: 3000 }, () => ping))
  let sent = 0
  const t = setInterval(() => {
    for (let i = 0; i < 20 && ws.readyState === 1; i++) { ws.send(batch); sent += 3000 }
    if (sent >= 6_000_000 || ws.readyState !== 1) { clearInterval(t); console.log('pings sent', sent) }
  }, 5)
})
ws.on('close', (c) => { console.log('closed', c); process.exit(0) })
ws.on('error', () => {})
