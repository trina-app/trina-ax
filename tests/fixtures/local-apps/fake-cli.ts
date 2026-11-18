// A stand-in for a plain CLI such as ego lite's ego-browser (tests/unit/e-local-apps.test.ts): `skill` prints a
// guide, `nodejs` reads a script on stdin and says what it got, `args` prints its argument list. A script with FAIL in
// it exits 3; ECHO_TOKEN prints the FAKE_TOKEN setting.
const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'skill') { console.log('# fake guide\nUse taskSpace() and page.goto().'); process.exit(0) }
if (cmd === 'args') { console.log(JSON.stringify(rest)); process.exit(0) }
if (cmd === 'nodejs') {
  const script = await new Response(Bun.stdin.stream()).text()
  if (script.includes('ECHO_TOKEN')) console.log(`token: ${process.env.FAKE_TOKEN ?? '(none)'}`)
  console.log(`ran ${script.length} chars: ${JSON.stringify(script.slice(0, 80))}`)
  if (script.includes('FAIL')) { console.error('script failed on purpose'); process.exit(3) }
  process.exit(0)
}
console.error(`unknown command ${cmd}`)
process.exit(2)
export {}
