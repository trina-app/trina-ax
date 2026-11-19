// A stand-in for a plain CLI such as ego lite's ego-browser (tests/unit/e-local-apps.test.ts): `skill` prints a
// guide, `nodejs` reads a script on stdin and says what it got, `args` prints its argument list. A script with FAIL in
// it exits 3; ECHO_TOKEN prints the FAKE_TOKEN setting; `BIG <n> <m>` writes n characters on stdout and m on stderr.
const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'skill') { console.log('# fake guide\nUse taskSpace() and page.goto().'); process.exit(0) }
if (cmd === 'args') { console.log(JSON.stringify(rest)); process.exit(0) }
if (cmd === 'nodejs') {
  const script = await new Response(Bun.stdin.stream()).text()
  // like ego lite's ego-browser: the whole result on stderr, exit 0 (longer than a short error tail)
  if (script.includes('STDERR_OUT')) {
    console.error(`printed on stderr\ntoken: ${process.env.FAKE_TOKEN ?? '(none)'}`)
    for (let i = 0; i < 500; i++) console.error(`line ${i} of the long result`)
    process.exit(0)
  }
  // `BIG <n> <m>`: n characters on stdout and m on stderr (the shared size cap), in chunks like a real program
  const big = /^BIG (\d+) (\d+)$/.exec(script)
  if (big) {
    const write = (s: NodeJS.WriteStream, ch: string, n: number) => new Promise<void>((done) => {
      const chunk = ch.repeat(64 * 1024)
      let left = n
      const next = () => { while (left > 0) { const part = left >= chunk.length ? chunk : chunk.slice(0, left); left -= part.length; if (!s.write(part)) { s.once('drain', next); return } } done() }
      next()
    })
    await Promise.all([write(process.stdout, 'o', Number(big[1])), write(process.stderr, 'e', Number(big[2]))])
    process.exit(0)
  }
  if (script.includes('ECHO_TOKEN')) console.log(`token: ${process.env.FAKE_TOKEN ?? '(none)'}`)
  console.log(`ran ${script.length} chars: ${JSON.stringify(script.slice(0, 80))}`)
  if (script.includes('FAIL')) { console.error('script failed on purpose'); process.exit(3) }
  process.exit(0)
}
console.error(`unknown command ${cmd}`)
process.exit(2)
export {}
