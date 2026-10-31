#!/bin/bash
# Preview path without a host port (works for open and allowlist boxes): a socat in the box's network namespace but
# in the host's file system turns a unix socket on the host into a TCP connection to the dev server inside the box.
# The preview gateway (server side, separate domain, short-lived token: review hole 3) connects to that socket.
#   preview.sh BOX PORT        (run as the devbox account) -> /srv/devbox/preview/BOX-PORT.sock
set -euo pipefail
b=$1; port=$2; d=/srv/devbox/preview; mkdir -p "$d"; chmod 0711 "$d"
pid=$(podman inspect -f '{{.State.Pid}}' "box-$b")
sock="$d/$b-$port.sock"; rm -f "$sock"
podman unshare nsenter -t "$pid" -n socat "UNIX-LISTEN:$sock,fork,mode=0600" "TCP:127.0.0.1:$port" </dev/null >/dev/null 2>&1 &
for _ in $(seq 1 30); do [ -S "$sock" ] && break; sleep 0.1; done
echo "$sock (pid $!)"
