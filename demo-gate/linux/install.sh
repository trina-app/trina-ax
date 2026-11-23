#!/bin/sh
# Set up (or update) the free-roam demo on a Linux host, as root (README "Hosting on Linux"). Idempotent: run it again
# after a new stage to update the app and the programs. It touches only its own users, folders, nft table, units and
# sudoers file; it never changes another service, another user or another firewall table.
#   sh STAGE/app/demo-gate/linux/install.sh --stage STAGE --origin https://demo-staging.trina.app --site-key KEY [--no-start]
# STAGE is what stage.sh prepared (dl/ with the downloads, app/ built). It is copied to a folder of root's first and
# only that copy is read; the downloads are checked against pins.env (and scripts/system/packages.json for
# chrome-headless-shell) and unpacked here, never taken from the stage's unpacked tools/. Optional files in
# STAGE/secrets/ (copied in, never printed, then removed from the stage as its owner): turnstile-secret,
# canary-sealed, tunnel-creds.json (+ tunnel-id, tunnel-hostname).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022
STAGE='' ORIGIN='' START=1 SITEKEY=''
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
case "$STAGE" in /*) ;; *) die "--stage must be an absolute path" ;; esac
[ -d "$STAGE/dl" ] && [ -x "$STAGE/app/native/bin/linux-amd64/mycel-gate" ] || die "--stage must be a folder stage.sh prepared"
O=/opt/trina-demo G=/var/demo-gate FS=/srv/tdg IMG=/var/lib/trina-demo/tdg.xfs SIZE_GB=60
LOCALES="en ko ja zh es id"

# ---- the stage, copied to root's own folder; everything below reads only the copy ----
install -d -o root -g root -m 755 /var/lib/trina-demo
ST=/var/lib/trina-demo/install
rm -rf "${ST:?}"; install -d -o root -g root -m 700 "$ST"
cp -a "$STAGE/dl" "$STAGE/app" "$ST/"
if [ -e "$STAGE/secrets" ] || [ -L "$STAGE/secrets" ]; then
  # secrets are plain files only: a link could make root copy (and later move into place) a file it should not
  [ -d "$STAGE/secrets" ] && [ ! -L "$STAGE/secrets" ] || die "$STAGE/secrets must be a plain folder"
  [ -z "$(find "$STAGE/secrets" -mindepth 1 ! -type f -print -quit)" ] || die "$STAGE/secrets may hold plain files only (no links, folders or devices)"
  cp -P -R "$STAGE/secrets" "$ST/"
  [ -z "$(find "$ST/secrets" -mindepth 1 ! -type f -print -quit)" ] || die "$STAGE/secrets changed while it was copied"
fi
chown -R root:root "$ST"; chmod -R go-w "$ST"
HERE=$ST/app/demo-gate/linux
# shellcheck source=demo-gate/linux/pins.env
. "$HERE/pins.env"
chk() { [ "$(sha256sum "$1" | cut -c1-64)" = "$2" ] || die "$1: sha256 does not match the pin"; }
chk "$ST/dl/node.tar.xz" "$NODE_SHA256"; chk "$ST/dl/bun.zip" "$BUN_SHA256"
chk "$ST/dl/claude" "$CLAUDE_SHA256"; chk "$ST/dl/cloudflared" "$CLOUDFLARED_SHA256"
CH=$(python3 -I -c 'import json,sys;a=json.load(open(sys.argv[1]))["artifacts"]["chrome-headless-shell"];p=a["platforms"]["linux-amd64"];print(a["version"],p["sha256"],p["dir"])' "$ST/app/scripts/system/packages.json")
# shellcheck disable=SC2086
set -- $CH; CH_VERSION=$1 CH_SHA=$2 CH_DIR=$3
chk "$ST/dl/chrome.zip" "$CH_SHA"
say "downloads checked"

# ---- packages (only what is missing; nothing is upgraded or removed) ----
need=''
command -v mkfs.xfs >/dev/null || need="$need xfsprogs"
command -v heif-convert >/dev/null || command -v heif-dec >/dev/null || need="$need libheif-examples"
for c in bwrap nft choom runuser curl fallocate unzip; do command -v $c >/dev/null || die "$c is missing"; done
# shellcheck disable=SC2086
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
install -d -o root -g root -m 755 $O $O/bin $O/etc /etc/trina-demo
install -d -o tdgate -g tdgate -m 700 $G $G/state $G/secrets
install -d -o tdtunnel -g tdtunnel -m 700 /var/demo-tunnel
install -d -o tdbuild -g tdbuild -m 700 /var/demo-build
install -d -o tdcred -g tdcred -m 700 /var/lib/trina-demo-cred

# ---- the instances' file system: XFS with reflink on a loop image, so a clone of a snapshot costs no space ----
if [ ! -f $IMG ]; then
  avail=$(df -B1G --output=avail /var/lib/trina-demo | tail -1 | tr -d ' ')
  [ "$avail" -ge $((SIZE_GB + 40)) ] || die "only ${avail} GB free for the ${SIZE_GB} GB image (want ${SIZE_GB} + 40 GB left over)"
  fallocate -l ${SIZE_GB}G $IMG; chmod 600 $IMG
fi
if ! blkid -p $IMG 2>/dev/null | grep -q 'TYPE="xfs"'; then mkfs.xfs -q -m reflink=1 -L trina-tdg $IMG; say "XFS image made"; fi
FSTAB_LINE="$IMG $FS xfs loop,nodev,nosuid,noatime,nofail,discard 0 0"
if ! grep -qxF "$FSTAB_LINE" /etc/fstab; then
  cp -p /etc/fstab "/etc/fstab.bak-trina-demo-$(date -u +%Y%m%d%H%M%S)"
  grep -v "^$IMG " /etc/fstab > /etc/fstab.trina-demo.new || true
  echo "$FSTAB_LINE" >> /etc/fstab.trina-demo.new
  cat /etc/fstab.trina-demo.new > /etc/fstab; rm -f /etc/fstab.trina-demo.new
  systemctl daemon-reload; say "fstab line set"
fi
install -d -o root -g root -m 755 $FS
mountpoint -q $FS || mount $FS
xfs_info $FS | grep -q 'reflink=1' || die "$FS has no reflink"
# root's: the mount, the snapshots and the build folders; tdrun's: the instances (listable by the gate's group)
chown root:root $FS; chmod 755 $FS
install -d -o tdrun -g tdgate -m 751 $FS/i
install -d -o root -g root -m 755 $FS/.snapshots $FS/.build
for l in $LOCALES; do install -d -o tdgate -g tdrun -m 2750 "$FS/.snapshots/$l"; done

# ---- programs, unpacked from the checked downloads, and the app ----
fresh() { rm -rf "${1:?}.new"; install -d -o root -g root -m 755 "$1.new"; }
swap() { rm -rf "${1:?}.old"; [ ! -e "$1" ] || mv "$1" "$1.old"; mv "$1.new" "$1"; rm -rf "$1.old"; }
fresh $O/node; tar -xJf "$ST/dl/node.tar.xz" -C $O/node.new --strip-components=1 --no-same-owner; swap $O/node
fresh $O/claude; install -d -m 755 $O/claude.new/bin; install -m 755 "$ST/dl/claude" $O/claude.new/bin/claude; swap $O/claude
fresh $O/chrome-headless-shell; install -d -m 755 "$O/chrome-headless-shell.new/$CH_VERSION"
unzip -q "$ST/dl/chrome.zip" -d "$O/chrome-headless-shell.new/$CH_VERSION"
[ -x "$O/chrome-headless-shell.new/$CH_VERSION/$CH_DIR/chrome-headless-shell" ] || die "chrome-headless-shell is not where the list says"
ln -s "$CH_VERSION/$CH_DIR" $O/chrome-headless-shell.new/current; swap $O/chrome-headless-shell
t=$(mktemp -d); unzip -q "$ST/dl/bun.zip" -d "$t"; install -m 755 "$t/bun-linux-x64/bun" $O/bin/bun; rm -rf "$t"
install -m 755 "$ST/dl/cloudflared" $O/bin/cloudflared
chk $O/claude/bin/claude "$CLAUDE_SHA256"; chk $O/bin/cloudflared "$CLOUDFLARED_SHA256"
for f in tdnft-load tdsnap-rebuild tdgate-set-credential tdcred-credsync tdfw-check tdscope; do install -m 755 "$HERE/$f" $O/bin/; done
install -m 644 "$HERE/trina-demo.nft" $O/etc/
rm -rf $O/app.new; mv "$ST/app" $O/app.new
if [ -d $O/app ]; then rm -rf $O/app-old; mv $O/app $O/app-old; fi
mv $O/app.new $O/app
# the app moved out of root's stage copy: its hosting files are read from the installed app from here on
HERE=$O/app/demo-gate/linux
chown -R root:root $O; chmod -R go-w $O; chmod -R a+rX $O
say "programs and app in $O (node $($O/node/bin/node --version), bun $($O/bin/bun --version), app $(cat $O/app/.git-head 2>/dev/null || echo '?'))"

# ---- sudoers (checked first) ----
visudo -cqf "$HERE/sudoers" || die "sudoers file does not check"
install -m 440 -o root -g root "$HERE/sudoers" /etc/sudoers.d/trina-demo
# the host's own sudo settings: I/O logging needs a pty (off for tdgate in our file); a log file only grows
# (a host-wide setting is fine once this host's admin has turned both off for tdgate)
if grep -hsE '^[[:space:]]*Defaults[[:space:]]+([^#]*[[:space:],])?(log_output|log_input)' /etc/sudoers /etc/sudoers.d/* | grep -q . \
   && ! { grep -hsE '^[[:space:]]*Defaults:tdgate[[:space:]][^#]*!log_output' /etc/sudoers /etc/sudoers.d/* | grep -q . \
          && grep -hsE '^[[:space:]]*Defaults:tdgate[[:space:]][^#]*!log_input' /etc/sudoers /etc/sudoers.d/* | grep -q .; }; then
  die "this host logs sudo input/output (log_output/log_input): add Defaults:tdgate !log_output, !log_input for sudo.ws, then run install.sh again"
fi
if grep -hsE '^[[:space:]]*Defaults[^#]*logfile' /etc/sudoers /etc/sudoers.d/* >/dev/null; then
  say "note: this host's sudo writes a log file; every instance the gate starts or checks adds lines to it"
fi

# ---- secrets (from root's copy; never printed; the stage's own copies removed as the stage's owner) ----
S=$ST/secrets
OWNER=$(stat -c %U "$STAGE")
gone() { runuser -u "$OWNER" -- rm -f -- "$STAGE/secrets/$1"; }
if [ -f "$S/turnstile-secret" ]; then install -o tdgate -g tdgate -m 600 "$S/turnstile-secret" $G/secrets/turnstile-secret; gone turnstile-secret; say "Turnstile secret in place"; fi
# the canary refuses a list others can read, so it is tdbuild's, mode 600, in root's folder: tdbuild cannot rename or
# replace the file, but as its owner it CAN change its contents. The list is a check on the builder's output, not a
# boundary against the builder.
if [ -f "$S/canary-sealed" ]; then install -o tdbuild -g tdbuild -m 600 "$S/canary-sealed" /etc/trina-demo/canary-sealed; gone canary-sealed; say "canary list in place"; fi
if [ -f /etc/trina-demo/canary-sealed ] && [ ! -L /etc/trina-demo/canary-sealed ]; then chown tdbuild:tdbuild /etc/trina-demo/canary-sealed; chmod 600 /etc/trina-demo/canary-sealed; fi
if [ -f "$S/tunnel-creds.json" ]; then
  TID=$(cat "$S/tunnel-id") HOST=$(cat "$S/tunnel-hostname")
  printf '%s' "$TID" | grep -qE '^[0-9a-f-]{36}$' || die "tunnel-id is not a tunnel id"
  printf '%s' "$HOST" | grep -qE '^[a-z0-9.-]+$' || die "tunnel-hostname is not a hostname"
  install -o tdtunnel -g tdtunnel -m 600 "$S/tunnel-creds.json" /var/demo-tunnel/creds.json; gone tunnel-creds.json
  (umask 077; cat > /var/demo-tunnel/config.yml <<YML
tunnel: $TID
credentials-file: /var/demo-tunnel/creds.json
no-autoupdate: true
metrics: 127.0.0.1:19180
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:19190
  - service: http_status:404
YML
)
  chown tdtunnel:tdtunnel /var/demo-tunnel/config.yml; say "tunnel $HOST configured"
fi
rm -rf "${S:?}"
# until a person signs in as tdcred: a placeholder the gate can start with (every AI answer is then "busy")
[ -f $G/secrets/ai-credential ] || { (umask 077; echo sk-ant-oat01-placeholder-no-login-yet > $G/secrets/ai-credential); chown tdgate:tdgate $G/secrets/ai-credential; say "AI credential: placeholder until the tdcred login"; }

# ---- the gate's config: made once from the example, then only codeVersion follows the app ----
VER=$($O/node/bin/node -p 'require("/opt/trina-demo/app/server/package.json").version')
if [ ! -f $G/gate.json ]; then
  [ -n "$ORIGIN" ] && [ -n "$SITEKEY" ] || die "first install: --origin and --site-key are needed for gate.json"
  # shellcheck disable=SC2016
  $O/node/bin/node -e '
    const fs = require("node:fs"); const [src, origin, siteKey, ver, uid, gid] = process.argv.slice(1)
    const c = JSON.parse(fs.readFileSync(src, "utf8"))
    c.publicOrigin = origin; c.turnstile.siteKey = siteKey; c.pool.codeVersion = ver; c.pool.runAs = { uid: +uid, gid: +gid }
    fs.writeFileSync("/var/demo-gate/gate.json", JSON.stringify(c, null, 2) + "\n", { mode: 0o600 })
  ' "$O/app/demo-gate/gate.example.linux.json" "$ORIGIN" "$SITEKEY" "$VER" "$RUN_UID" "$RUN_GID"
  say "gate.json made ($ORIGIN, codeVersion $VER)"
else
  # shellcheck disable=SC2016
  $O/node/bin/node -e '
    const fs = require("node:fs"); const f = "/var/demo-gate/gate.json"; const c = JSON.parse(fs.readFileSync(f, "utf8"))
    if (c.pool.codeVersion !== process.argv[1]) { c.pool.codeVersion = process.argv[1]; fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 }); console.log("install: gate.json codeVersion " + process.argv[1]) }
  ' "$VER"
fi
chown tdgate:tdgate $G/gate.json; chmod 600 $G/gate.json
$O/node/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "import {parseConfig} from '$O/app/demo-gate/src/config.ts'; import fs from 'node:fs'; parseConfig(JSON.parse(fs.readFileSync('$G/gate.json','utf8')), '$G')" || die "gate.json does not parse"

# ---- units; this host's CI runner folders hidden from the gate and its instances (a drop-in) ----
for u in "$HERE"/systemd/*; do install -m 644 "$u" /etc/systemd/system/; done
D=/etc/systemd/system/trina-demo-gate.service.d; install -d -m 755 $D
{
  echo "# made by install.sh: this host's CI runner folders"
  echo "[Service]"
  for p in /home/*/actions-runner* /opt/actions-runner* /srv/actions-runner* /var/lib/github-runner*; do
    [ -d "$p" ] || continue
    case "$p" in *[!A-Za-z0-9/._-]*) continue ;; esac
    echo "InaccessiblePaths=-$p"
  done
} > $D/10-runners.conf
systemctl daemon-reload

# ---- sudo as the gate unit runs it: a transient unit with the gate unit's sandbox properties, as tdgate, starts the
# instance sandbox (and a nested bwrap) as tdrun through sudo. Fails when a property turns NoNewPrivileges on. ----
install -d -m 0711 /run/sudo; install -d -m 0700 /run/sudo/ts
PROPS=$(grep -hE '^(ProtectSystem|ReadWritePaths|ProtectHome|PrivateTmp|PrivateDevices|InaccessiblePaths|Protect(Kernel[A-Za-z]*|Clock|ControlGroups|Hostname|Proc)|LockPersonality|Restrict[A-Za-z]*|SystemCall[A-Za-z]*|MemoryDenyWriteExecute|NoNewPrivileges|IPAddress(Deny|Allow))=' /etc/systemd/system/trina-demo-gate.service $D/10-runners.conf)
set --
# (systemd-run takes no "localhost" in IPAddressAllow, unit files do: the same addresses spelled out)
while IFS= read -r line; do
  case "$line" in IPAddressAllow=*) line=$(printf '%s' "$line" | sed -E 's#(=| )localhost( |$)#\1127.0.0.0/8 ::1/128\2#') ;; esac
  [ -n "$line" ] && set -- "$@" -p "$line"
done <<EOF
$PROPS
EOF
runuser -u tdrun -- sh -c 'rm -rf /srv/tdg/i/.unit-check && mkdir -m 700 /srv/tdg/i/.unit-check'
if ! systemd-run --quiet --wait --pipe --collect --uid=tdgate --gid=tdgate "$@" /usr/bin/sudo -n -u "#$RUN_UID" -g "#$RUN_GID" -- \
     /usr/bin/bwrap --die-with-parent --unshare-pid --unshare-ipc --unshare-uts --hostname demo --ro-bind / / --tmpfs /srv/tdg --bind /srv/tdg/i/.unit-check /srv/tdg/i/.unit-check \
     --tmpfs /run --tmpfs /tmp --tmpfs /dev/shm --dev /dev --proc /proc -- /opt/trina-demo/bin/tdscope /usr/bin/bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev /bin/true; then
  runuser -u tdrun -- rm -rf /srv/tdg/i/.unit-check
  die "the gate unit's sandbox cannot start an instance through sudo (NoNewPrivileges, sudoers or bwrap): nothing of the demo was started"
fi
runuser -u tdrun -- rm -rf /srv/tdg/i/.unit-check
say "sudo and the instance sandbox work inside the gate unit's properties"

# ---- the firewall, checked before anything of the demo runs ----
systemctl stop trina-demo-gate.service trina-demo-tunnel.service 2>/dev/null || true
systemctl enable --now trina-demo-nft.timer >/dev/null
$O/bin/tdnft-load
$O/bin/tdfw-check || die "the firewall checks failed: nothing of the demo was started"

# ---- reflink and the instance sandbox, as the instance user (only in tdrun's own folder) ----
# shellcheck disable=SC2016
runuser -u tdrun -- sh -c 'set -e; t=/srv/tdg/i/.reflink-check; rm -rf "$t" "$t.c"; mkdir -m 700 "$t"; head -c 1048576 /dev/urandom > "$t/f"; cp --reflink=always -R "$t" "$t.c"; rm -rf "$t" "$t.c"' || die "cp --reflink=always failed as tdrun"
say "reflink clone ok"
# shellcheck disable=SC2016
runuser -u tdrun -- sh -c 'd=/srv/tdg/i/.bwrap-check; rm -rf "$d"; mkdir -m 700 "$d" && /usr/bin/bwrap --die-with-parent --unshare-pid --unshare-ipc --unshare-uts --hostname demo --ro-bind / / --tmpfs /srv/tdg --bind "$d" "$d" --tmpfs /run --tmpfs /tmp --tmpfs /dev/shm --dev /dev --proc /proc -- /opt/trina-demo/bin/tdscope /usr/bin/bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev /bin/true; r=$?; rm -rf "$d"; exit $r' || die "the instance sandbox (bwrap, with a nested bwrap) does not run as tdrun"
say "bwrap ok as tdrun (instance sandbox and a nested one)"

systemctl enable trina-demo-snapshots.timer trina-demo-gate.service >/dev/null
systemctl start trina-demo-snapshots.timer
# the login copy only where someone signed in as tdcred: a host on a long-lived token (claude setup-token, handed to
# tdgate-set-credential) keeps the timer off, so a later install does not turn it back on
if [ -f /var/lib/trina-demo-cred/.claude/.credentials.json ]; then
  systemctl enable --now trina-demo-credsync.timer >/dev/null
fi
[ -f /var/demo-tunnel/config.yml ] && systemctl enable trina-demo-tunnel.service >/dev/null

if [ "$START" = 1 ]; then
  if ! ls $FS/.snapshots/*/*/manifest.json >/dev/null 2>&1; then say "no snapshots yet: building them (several minutes)"; systemctl start trina-demo-snapshots.service || say "snapshot build had failures: journalctl -u trina-demo-snapshots"; fi
  systemctl restart trina-demo-gate.service
  [ -f /var/demo-tunnel/config.yml ] && systemctl restart trina-demo-tunnel.service
  # the gate must warm at least one instance (through sudo, in the unit) within 5 minutes
  i=0; warm=0
  while [ $i -lt 60 ]; do
    warm=$(curl -s -m 3 http://127.0.0.1:19190/__demo/health | python3 -I -c 'import json,sys
try: print(json.load(sys.stdin)["pool"]["warm"])
except Exception: print(0)')
    [ "$warm" -ge 1 ] 2>/dev/null && break
    i=$((i + 1)); sleep 5
  done
  if ! [ "$warm" -ge 1 ] 2>/dev/null; then
    systemctl stop trina-demo-tunnel.service trina-demo-gate.service
    die "the gate warmed no instance in 5 minutes: the tunnel and the gate were stopped (journalctl -u trina-demo-gate)"
  fi
  say "the gate warmed $warm instance(s)"
  if ! $O/bin/tdfw-check; then
    systemctl stop trina-demo-tunnel.service trina-demo-gate.service
    die "the firewall checks failed with the gate running: the tunnel and the gate were stopped"
  fi
  say "started: systemctl status trina-demo-gate trina-demo-tunnel; curl -s 127.0.0.1:19190/__demo/health"
fi
say "all done"
