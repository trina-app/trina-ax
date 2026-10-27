#!/bin/bash
# Runs INSIDE oven/bun:1.3.12-debian (tests/cloud/tenant-commands-docker.sh). /t: mycel-ctl (Linux) and this script;
# /src: the repository (read-only).
set -euo pipefail
pass=0
ok() { echo "  ok  $*"; pass=$((pass + 1)); }
die() { echo "  FAIL $*" >&2; [ -f /tmp/server.log ] && tail -20 /tmp/server.log >&2; exit 1; }
B=/var/lib/mycel
CTL="$B/root/mycel-ctl"
CHECK="bun /src/tests/cloud/tenant/check.ts"

groupadd --system -g 990 axserver && useradd --system -u 990 -g axserver -M -d $B/data -s /usr/sbin/nologin axserver
groupadd --system -g 991 axagent && useradd --system -u 991 -g axagent -M -s /usr/sbin/nologin axagent

# an install base like the kit's (linux-runtime 3.1.1): root-owned base/root/run, the server account's own folders
install -d -m 755 $B $B/root $B/run $B/app $B/app/versions/0.3.0/bin $B/app/versions/0.3.0/server/src
install -d -m 700 -o axserver -g axserver $B/data $B/config $B/secrets $B/team $B/status
install -m 755 /t/mycel-ctl $CTL
echo 0.3.0 > $B/root/VERSION
ln -s /usr/local/bin/bun $B/app/versions/0.3.0/bin/bun
# admin.js of the "installed version" = this checkout's admin CLI
cat > $B/app/versions/0.3.0/server/src/admin.js <<'JS'
const { main } = await import('/src/server/src/system/cli.ts')
process.exit(await main(process.argv.slice(2)))
JS
ln -s versions/0.3.0 $B/app/current
cat > $B/root/install.json <<JSON
{"format":1,"id":"mycel","base":"$B","serverUser":"axserver","agentUser":"axagent","port":47820,"proxyPort":47821,"tlsPort":0,
 "hosted":true,"autoUpdate":false,"allowUnsigned":true,"engines":["claude"],"version":"0.3.0","systemd":false}
JSON
install -m 600 -o axserver -g axserver /dev/stdin $B/config/server.json <<JSON
{"mode":"prod","deployment":"hosted","listen":{"host":"127.0.0.1","port":47820},"engine":{"authMode":"managed","proxyPort":47821},
 "relay":{"url":null,"teamName":null,"officialAvailable":false},"update":{"channel":"stable","feedUrl":null},"publicOrigins":[]}
JSON
# the team server, as the server account (its /api/health, status/status.json and the database)
cd /
setpriv --reuid=990 --regid=990 --clear-groups env -i PATH=/usr/bin:/bin HOME=$B/data MYCEL_MODE=prod MYCEL_CONFIG=$B/config/server.json \
  MYCEL_INSTALL_BASE=$B /usr/local/bin/bun /src/server/src/main.ts > /tmp/server.log 2>&1 &
bun -e 'for (let i = 0; i < 240; i++) { const r = await fetch("http://127.0.0.1:47820/api/health").catch(() => null); if (r?.ok) process.exit(0); await Bun.sleep(500) } process.exit(1)' || die "the team server did not come up"
ok "team server up as axserver"

run() { local c=$1; shift; "$CTL" "$c" --json "$@"; }

# status: the strict TenantStatus
out=$(run status) || die "status"
echo "$out" | $CHECK status >/dev/null || die "status is not a TenantStatus: $out"
echo "$out" | grep -q '"setupNeeded":true' && echo "$out" | grep -q '"health":"ok"' || die "status content: $out"
ok "status --json is a TenantStatus (setup needed, app ok)"
"$CTL" status --detail --json >/dev/null || die "status --detail"

# notices-set: root/notices.json root 644
out=$(echo '{"format":1,"issuedAt":"2026-10-22T00:00:00Z","notices":[{"id":"maint","level":"info","audience":"everyone","text":{"ko":"점검","en":"Maintenance","id":"Pemeliharaan"},"link":null,"until":null}]}' | run notices-set) || die "notices-set"
echo "$out" | $CHECK notices-set >/dev/null || die "notices-set out: $out"
[ "$(stat -c '%U %a' $B/root/notices.json)" = "root 644" ] || die "notices.json owner"
ok "notices-set: root/notices.json root 644"

# set-server-config: only the allowed keys, the server account's file kept as it was
out=$(echo '{"publicOrigins":["https://acme.treesoop.com"],"relay":{"teamName":"acme"},"engine":{"credentialKinds":["anthropic-api-key","openai-api-key"]}}' | run set-server-config) || die "set-server-config"
echo "$out" | $CHECK set-server-config >/dev/null || die "set-server-config out: $out"
grep -q '"https://acme.treesoop.com"' $B/config/server.json && grep -q '"authMode": "managed"' $B/config/server.json || die "server.json: $(cat $B/config/server.json)"
[ "$(stat -c '%U %a' $B/config/server.json)" = "axserver 600" ] || die "server.json owner $(stat -c '%U %a' $B/config/server.json)"
echo '{"listen":{"port":1}}' | run set-server-config >/dev/null 2>&1 && die "set-server-config took a key it may not change"
ok "set-server-config: merged as the server account (axserver 600), other keys refused"

# relay-key-proof: the relay key signs keyRotationString(teamId, publicKey)
T=0f6c2b1e-6a4c-4e0e-9a51-2d1f6f3b7c10
out=$(run relay-key-proof --team-id $T) || die "relay-key-proof"
pk=$(echo "$out" | $CHECK relay-key-proof $T | bun -e 'console.log(JSON.parse(await new Response(Bun.stdin.stream()).text()).publicKey)') || die "relay-key-proof out: $out"
ok "relay-key-proof: signature verifies"

# relay-registration-set: <data>/relay/registration.json axserver 600
out=$(echo "{\"relayRegistration\":{\"relayApi\":\"https://relay.treesoop.com\",\"teamId\":\"$T\",\"teamName\":\"acme\",\"publicKey\":\"$pk\",\"address\":\"https://acme.treesoop.com\"}}" | run relay-registration-set) || die "relay-registration-set"
echo "$out" | $CHECK relay-registration-set >/dev/null || die "relay-registration-set out: $out"
[ "$(stat -c '%U %a' $B/data/relay/registration.json)" = "axserver 600" ] || die "registration.json owner"
ok "relay-registration-set: registration.json axserver 600"

# idle-wait (no launcher: the engine account runs nothing)
out=$(run idle-wait --max 3) || die "idle-wait"
echo "$out" | $CHECK idle-wait | grep -q '"idle":true' || die "idle-wait out: $out"
ok "idle-wait: idle"

# setup-token-rotate while nobody has an account
old=$(cat $B/data/setup-token 2>/dev/null || true)
out=$(run setup-token-rotate) || die "setup-token-rotate"
echo "$out" | $CHECK setup-token-rotate >/dev/null || die "setup-token-rotate out: $out"
[ "$(cat $B/data/setup-token)" != "$old" ] && echo "$out" | grep -q "$(cat $B/data/setup-token)" || die "setup-token not rotated"
ok "setup-token-rotate: new token in data/setup-token"

# an owner, then reset-link at publicOrigins[0]
echo 'tenant test owner pw 1' | setpriv --reuid=990 --regid=990 --clear-groups env -i PATH=/usr/bin:/bin HOME=$B/data MYCEL_MODE=prod MYCEL_CONFIG=$B/config/server.json \
  /usr/local/bin/bun /src/server/src/auth/cli.ts create-owner --username kim --name Owner --team Tenant >/dev/null || die "create-owner"
out=$(run reset-link --owner) || die "reset-link"
echo "$out" | $CHECK reset-link | grep -q 'https://acme.treesoop.com/reset-password/' || die "reset-link out: $out"
run reset-link --username '../root' >/dev/null 2>&1 && die "reset-link took a bad username"
run setup-token-rotate >/dev/null 2>&1 && die "setup-token-rotate after setup"
ok "reset-link at publicOrigins[0]; setup-token-rotate refused after setup"

# backup-prepare: a full local backup staged for upload
out=$(run backup-prepare --kind manual) || die "backup-prepare"
echo "$out" | $CHECK backup-prepare >/dev/null || die "backup-prepare out: ${out:0:300}"
ok "backup-prepare --kind manual"

# credentials-escrow-out: absent before any AI connection key exists
R=$(bun -e 'const { newAgeIdentity } = await import("/src/server/src/system/streams.ts"); console.log((await newAgeIdentity()).recipient)')
out=$(run credentials-escrow-out --recipient "$R") || die "credentials-escrow-out"
echo "$out" | $CHECK credentials-escrow-out | grep -q '"absent":true' || die "credentials-escrow-out out: $out"
ok "credentials-escrow-out: absent"

# apply-plan with the control plane's fields (no systemd: skipped units, the file is in place)
out=$(echo '{"format":1,"plan":"team","maxConcurrency":3,"memoryMiB":4096,"cpuCores":3,"diskGiB":50,"localBackupRetentionDays":3,"updatedAt":"2026-10-22T00:00:00Z","maxActiveMembers":12,"display":{"name":{"ko":"팀","en":"Team","id":"Tim"}},"links":{"account":"https://account.treesoop.com","status":"https://status.treesoop.com","support":"support@treesoop.com"}}' | run apply-plan) || die "apply-plan"
echo "$out" | $CHECK apply-plan >/dev/null || die "apply-plan out: $out"
ok "apply-plan accepts the control plane's plan"

# status after setup: an owner, the plan's seats
out=$(run status) || die "status 2"
echo "$out" | $CHECK status | grep -q '"activeMembers":1' || die "status after setup: $out"
ok "status: one active member, still a strict TenantStatus"

# prepare-stop (no systemd: nothing to stop) and an unknown command
out=$(run prepare-stop --grace 1) || die "prepare-stop"
echo "$out" | $CHECK prepare-stop >/dev/null || die "prepare-stop out: $out"
"$CTL" sh --json >/dev/null 2>&1 && die "an unknown command ran"
ok "prepare-stop answers; unknown commands refused"

echo "tenant commands: $pass checks passed"
