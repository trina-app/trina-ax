#!/bin/sh
# Set up (or update) the free-roam demo on a Linux host, as root (README "Hosting on Linux"). Idempotent: run it again
# after a new stage to update the app and the programs. It touches only its own users, folders, nft table, units and
# sudoers file; it never changes another service, another user or another firewall table.
#   sh STAGE/app/demo-gate/linux/install.sh --stage STAGE --origin https://demo-staging.trina.app [--no-start]
# STAGE is what stage.sh prepared (tools/, app/ built). Optional files in STAGE/secrets/ (each moved in, never
# printed): turnstile-secret, canary-sealed, tunnel-creds.json (+ tunnel-id, tunnel-hostname).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022
STAGE= ORIGIN= START=1 SITEKEY=
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE=$2; shift 2 ;;
    --origin) ORIGIN=$2; shift 2 ;;
    --site-key) SITEKEY=$2; shift 2 ;;
    --no-start) START=0; shift ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
say() { echo "install: $*"; }
die() { echo "install: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo sh $0 ...)"
[ -n "$STAGE" ] && [ -d "$STAGE/tools" ] && [ -x "$STAGE/app/native/bin/linux-amd64/mycel-gate" ] || die "--stage must be a folder stage.sh prepared"
HERE=$STAGE/app/demo-gate/linux
. "$HERE/pins.env"
O=/opt/trina-demo G=/var/demo-gate FS=/srv/tdg IMG=/var/lib/trina-demo/tdg.xfs

# ---- packages (only what is missing; nothing is upgraded or removed) ----
need=
command -v mkfs.xfs >/dev/null || need="$need xfsprogs"
command -v heif-convert >/dev/null || command -v heif-dec >/dev/null || need="$need libheif-examples"
for c in bwrap nft choom runuser; do command -v $c >/dev/null || die "$c is missing"; done
if [ -n "$need" ]; then say "apt:$need"; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $need >/dev/null; fi

# ---- users (system users, no login shell) ----
mkuser() { id -u "$1" >/dev/null 2>&1 || { useradd --system --user-group --home-dir "$2" --no-create-home --shell /usr/sbin/nologin "$1"; say "user $1"; }; }
mkuser tdgate $G/state
mkuser tdrun /nonexistent
mkuser tdtunnel /var/demo-tunnel
mkuser tdbuild /var/demo-build
mkuser tdcred /var/lib/trina-demo-cred
RUN_UID=$(id -u tdrun) RUN_GID=$(id -g tdrun)

# ---- folders ----
install -d -o root -g root -m 755 $O $O/bin $O/etc /etc/trina-demo /var/lib/trina-demo
install -d -o tdgate -g tdgate -m 700 $G $G/state $G/secrets
install -d -o tdtunnel -g tdtunnel -m 700 /var/demo-tunnel
install -d -o tdbuild -g tdbuild -m 700 /var/demo-build
install -d -o tdcred -g tdcred -m 700 /var/lib/trina-demo-cred

# ---- the instances' file system: XFS with reflink on a loop image, so a clone of a snapshot costs no space ----
if [ ! -f $IMG ]; then truncate -s 60G $IMG; chmod 600 $IMG; fi
if ! blkid -p $IMG 2>/dev/null | grep -q 'TYPE="xfs"'; then mkfs.xfs -q -m reflink=1 -L trina-tdg $IMG; say "XFS image made"; fi
grep -q "^$IMG " /etc/fstab || { echo "$IMG $FS xfs loop,nodev,nosuid,noatime 0 0" >> /etc/fstab; systemctl daemon-reload; say "fstab line added"; }
install -d -m 755 $FS
mountpoint -q $FS || mount $FS
xfs_info $FS | grep -q 'reflink=1' || die "$FS has no reflink"
# instances: tdrun's, listable by the gate's group; others may pass through (the builder) but not list
chown tdrun:tdgate $FS; chmod 751 $FS
install -d -o tdgate -g tdrun -m 750 $FS/.snapshots
install -d -o tdbuild -g tdbuild -m 700 $FS/.build

# ---- programs (checked again) and the app ----
chk() { [ "$(sha256sum "$1" | cut -c1-64)" = "$2" ] || die "$1: sha256 does not match pins.env"; }
chk "$STAGE/dl/node.tar.xz" "$NODE_SHA256"; chk "$STAGE/dl/bun.zip" "$BUN_SHA256"
chk "$STAGE/dl/claude" "$CLAUDE_SHA256"; chk "$STAGE/dl/cloudflared" "$CLOUDFLARED_SHA256"
chk "$STAGE/tools/claude/bin/claude" "$CLAUDE_SHA256"; chk "$STAGE/tools/bin/cloudflared" "$CLOUDFLARED_SHA256"
for d in node claude chrome-headless-shell; do rm -rf "$O/$d.new"; cp -a "$STAGE/tools/$d" "$O/$d.new"; rm -rf "$O/$d"; mv "$O/$d.new" "$O/$d"; done
install -m 755 "$STAGE/tools/bin/bun" "$STAGE/tools/bin/cloudflared" $O/bin/
for f in tdnft-load tdsnap-rebuild tdgate-set-credential tdcred-credsync; do install -m 755 "$HERE/$f" $O/bin/; done
install -m 644 "$HERE/trina-demo.nft" $O/etc/
if [ -d $O/app ]; then rm -rf $O/app-old; mv $O/app $O/app-old; fi
cp -a "$STAGE/app" $O/app.new && mv $O/app.new $O/app
chown -R root:root $O; chmod -R go-w $O; chmod -R a+rX $O
say "programs and app in $O ($(cat $O/app/.git-head 2>/dev/null || echo '?'))"

# ---- sudoers (checked first) ----
visudo -cqf "$HERE/sudoers" || die "sudoers file does not check"
install -m 440 -o root -g root "$HERE/sudoers" /etc/sudoers.d/trina-demo

# ---- secrets from the stage (moved, never printed) ----
S=$STAGE/secrets
if [ -f "$S/turnstile-secret" ]; then install -o tdgate -g tdgate -m 600 "$S/turnstile-secret" $G/secrets/turnstile-secret; rm -f "$S/turnstile-secret"; say "Turnstile secret in place"; fi
if [ -f "$S/canary-sealed" ]; then install -o root -g tdbuild -m 640 "$S/canary-sealed" /etc/trina-demo/canary-sealed; rm -f "$S/canary-sealed"; say "canary list in place"; fi
if [ -f "$S/tunnel-creds.json" ]; then
  TID=$(cat "$S/tunnel-id") HOST=$(cat "$S/tunnel-hostname")
  install -o tdtunnel -g tdtunnel -m 600 "$S/tunnel-creds.json" /var/demo-tunnel/creds.json; rm -f "$S/tunnel-creds.json"
  umask 077; cat > /var/demo-tunnel/config.yml <<YML
tunnel: $TID
credentials-file: /var/demo-tunnel/creds.json
no-autoupdate: true
metrics: 127.0.0.1:19180
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:19190
  - service: http_status:404
YML
  umask 022; chown tdtunnel:tdtunnel /var/demo-tunnel/config.yml; say "tunnel $HOST configured"
fi
# until a person signs in as tdcred: a placeholder the gate can start with (every AI answer is then "busy")
[ -f $G/secrets/ai-credential ] || { (umask 077; echo sk-ant-oat01-placeholder-no-login-yet > $G/secrets/ai-credential); chown tdgate:tdgate $G/secrets/ai-credential; say "AI credential: placeholder until the tdcred login"; }

# ---- the gate's config: made once from the example, then only codeVersion follows the app ----
VER=$($O/node/bin/node -p 'require("/opt/trina-demo/app/server/package.json").version')
if [ ! -f $G/gate.json ]; then
  [ -n "$ORIGIN" ] && [ -n "$SITEKEY" ] || die "first install: --origin and --site-key are needed for gate.json"
  $O/node/bin/node -e '
    const fs = require("node:fs"); const [src, origin, siteKey, ver, uid, gid] = process.argv.slice(1)
    const c = JSON.parse(fs.readFileSync(src, "utf8"))
    c.publicOrigin = origin; c.turnstile.siteKey = siteKey; c.pool.codeVersion = ver
    c.pool.snapshotsDir = "/srv/tdg/.snapshots"; c.pool.runAs = { uid: +uid, gid: +gid }
    fs.writeFileSync("/var/demo-gate/gate.json", JSON.stringify(c, null, 2) + "\n", { mode: 0o600 })
  ' "$O/app/demo-gate/gate.example.linux.json" "$ORIGIN" "$SITEKEY" "$VER" "$RUN_UID" "$RUN_GID"
  say "gate.json made ($ORIGIN, codeVersion $VER)"
else
  $O/node/bin/node -e '
    const fs = require("node:fs"); const f = "/var/demo-gate/gate.json"; const c = JSON.parse(fs.readFileSync(f, "utf8"))
    if (c.pool.codeVersion !== process.argv[1]) { c.pool.codeVersion = process.argv[1]; fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 }); console.log("install: gate.json codeVersion " + process.argv[1]) }
  ' "$VER"
fi
chown tdgate:tdgate $G/gate.json; chmod 600 $G/gate.json
$O/node/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "import {parseConfig} from '$O/app/demo-gate/src/config.ts'; import fs from 'node:fs'; parseConfig(JSON.parse(fs.readFileSync('$G/gate.json','utf8')), '$G')" || die "gate.json does not parse"

# ---- units ----
for u in "$HERE"/systemd/*; do install -m 644 "$u" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable --now trina-demo-nft.timer >/dev/null
/opt/trina-demo/bin/tdnft-load
systemctl enable trina-demo-snapshots.timer trina-demo-credsync.timer trina-demo-gate.service >/dev/null
systemctl start trina-demo-snapshots.timer trina-demo-credsync.timer
[ -f /var/demo-tunnel/config.yml ] && systemctl enable trina-demo-tunnel.service >/dev/null

# ---- checks: reflink as the instance user, bwrap as the instance user ----
t=$FS/.reflink-check; rm -rf $t $t.c; install -d -o tdrun -g tdrun -m 700 $t
runuser -u tdrun -- sh -c "head -c 1048576 /dev/urandom > $t/f && cp --reflink=always -R $t $t.c" || die "cp --reflink=always failed as tdrun"
rm -rf $t $t.c; say "reflink clone ok"
runuser -u tdrun -- bwrap --ro-bind / / --unshare-all --die-with-parent /bin/true || die "bwrap does not run as tdrun"
say "bwrap ok as tdrun"

if [ "$START" = 1 ]; then
  if ! ls $FS/.snapshots/*/*/manifest.json >/dev/null 2>&1; then say "no snapshots yet: building them (several minutes)"; systemctl start trina-demo-snapshots.service || say "snapshot build had failures: journalctl -u trina-demo-snapshots"; fi
  systemctl restart trina-demo-gate.service
  [ -f /var/demo-tunnel/config.yml ] && systemctl restart trina-demo-tunnel.service
  say "started: systemctl status trina-demo-gate trina-demo-tunnel; curl -s 127.0.0.1:19190/__demo/health"
fi
say done
