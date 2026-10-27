// Checks one tenant command's stdout (on stdin) against the contract (shared/src/cloud-protocol TENANT_COMMANDS
// output schemas; TenantStatus is strict). Used by tests/cloud/tenant/in-container.sh.
//   bun check.ts <command> [relay-key-proof: <teamId>]       exit 0 = valid, prints the parsed value
import { keyRotationString, verifyB64 } from '@mycel/shared/relay-protocol'
import { TENANT_COMMANDS, type TenantCommandName } from '@mycel/shared/cloud-protocol'

const [command, extra] = process.argv.slice(2) as [TenantCommandName, string | undefined]
const text = await new Response(Bun.stdin.stream()).text()
// ax-hostd parses the whole stdout as one JSON value (the tenant commands print one line; apply-plan / update indent)
let value: unknown
try { value = JSON.parse(text) } catch { console.error('stdout is not one JSON value'); process.exit(1) }
const r = TENANT_COMMANDS[command].output.safeParse(value)
if (!r.success) { console.error(JSON.stringify(r.error.issues).slice(0, 800)); process.exit(1) }
if (command === 'relay-key-proof') {
  const v = r.data as { publicKey: string; sig: string }
  if (!verifyB64(v.publicKey, keyRotationString(extra!, v.publicKey), v.sig)) { console.error('signature does not verify'); process.exit(1) }
}
console.log(JSON.stringify(r.data))
