#!/bin/bash
# Measurements for the spike, one step at a time (run as the devbox account). Prints JSON lines (measure.py).
#   bench.sh web     Vite/React project in box "web" (open network)
#   bench.sh py      Flask project in box "py" (allowlist network, pip through the egress proxy)
#   bench.sh next    Next.js 15 + Tailwind project in box "next" (open network)
#   bench.sh life    start / stop / pause / resume times of box "web", and time until the dev server answers
#   bench.sh disk    image, volume and folder sizes
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/box.sh"
M() { local box=$1; shift; QUIET=1 python3 -I "$HERE/measure.py" "$("$B" cgroup "$box")" "$@"; }
wait_http() { # wait_http BOX URL: seconds until the URL answers inside the box
  local t0=$(date +%s.%N)
  for _ in $(seq 1 300); do "$B" exec "$1" curl -s -o /dev/null -m 1 "$2" && break; sleep 0.1; done
  echo "$(date +%s.%N) - $t0" | bc
}
case $1 in
web)
  "$B" exec web sh -c 'rm -rf /cache/npm /work/node_modules/* /work/node_modules/.[!.]* /work/dist'
  M web npm-install-cold -- "$B" exec web npm install --no-audit --no-fund --loglevel=error
  "$B" exec web sh -c 'rm -rf /work/node_modules/* /work/node_modules/.[!.]*'
  M web npm-install-warm -- "$B" exec web npm install --no-audit --no-fund --loglevel=error --prefer-offline
  M web vite-build -- "$B" exec web npx vite build
  podman exec -d -w /work box-web sh -c 'npx vite --host 127.0.0.1 --port 5173 > /tmp/vite.log 2>&1'
  echo "{\"step\": \"dev-server-ready-s\", \"value\": $(wait_http web http://127.0.0.1:5173/)}"
  M web dev-server-idle-60s --idle 60
  ( for i in $(seq 1 10); do sleep 2; "$B" exec web sh -c "sed -i 's/clicked [0-9]*/clicked $i/; s/clicked {n}/clicked {n}/' src/App.jsx"; done ) &
  M web dev-server-active-30s -- "$B" exec web sh -c 'end=$(($(date +%s)+30)); while [ $(date +%s) -lt $end ]; do
      for u in / /src/main.jsx /src/App.jsx /@vite/client /node_modules/.vite/deps/react-dom_client.js; do curl -s -o /dev/null http://127.0.0.1:5173$u; done; done'
  wait
  "$B" exec web sh -c "sed -i 's/clicked [0-9]*/clicked {n}/' src/App.jsx; pkill -f vite || true"
  ;;
next)
  "$B" exec next sh -c 'rm -rf /cache/npm /work/node_modules/* /work/node_modules/.[!.]* /work/.next'
  M next npm-install-cold -- "$B" exec next npm install --no-audit --no-fund --loglevel=error
  M next next-build -- "$B" exec next sh -c 'NEXT_TELEMETRY_DISABLED=1 npx next build'
  podman exec -d -w /work -e NEXT_TELEMETRY_DISABLED=1 box-next sh -c 'npx next dev -H 127.0.0.1 -p 3000 > /tmp/next.log 2>&1'
  echo "{\"step\": \"next-dev-first-page-s\", \"value\": $(wait_http next http://127.0.0.1:3000/)}"
  M next next-dev-idle-60s --idle 60
  M next next-dev-active-30s -- "$B" exec next sh -c 'end=$(($(date +%s)+30)); while [ $(date +%s) -lt $end ]; do curl -s -o /dev/null http://127.0.0.1:3000/; done'
  "$B" exec next pkill -f next
  ;;
py)
  "$B" exec py sh -c 'rm -rf /cache/pip /work/.venv/* /work/.venv/.[!.]*'
  M py venv-create -- "$B" exec py python3 -m venv /work/.venv
  M py pip-install-cold -- podman exec -w /work -e HTTPS_PROXY=http://127.0.0.1:3128 box-py /work/.venv/bin/pip install -q -r requirements.txt
  podman exec -d -w /work box-py sh -c '/work/.venv/bin/python app.py > /tmp/flask.log 2>&1'
  echo "{\"step\": \"flask-ready-s\", \"value\": $(wait_http py http://127.0.0.1:8000/)}"
  M py flask-idle-30s --idle 30
  M py flask-active-20s -- "$B" exec py sh -c 'end=$(($(date +%s)+20)); while [ $(date +%s) -lt $end ]; do curl -s -o /dev/null http://127.0.0.1:8000/; done'
  "$B" exec py pkill -f app.py
  ;;
life)
  t() { local t0=$(date +%s.%N); "$@" >/dev/null; echo "$(date +%s.%N) - $t0" | bc; }
  echo "{\"step\": \"box-stop-s\", \"value\": $(t "$B" stop web)}"
  echo "{\"step\": \"box-start-s\", \"value\": $(t "$B" start web)}"
  t0=$(date +%s.%N); podman exec -d -w /work box-web sh -c 'npx vite --host 127.0.0.1 --port 5173 > /tmp/vite.log 2>&1'
  r=$(wait_http web http://127.0.0.1:5173/); echo "{\"step\": \"start-to-dev-server-s\", \"value\": $(echo "$(date +%s.%N) - $t0" | bc)}"
  echo "{\"step\": \"box-pause-s\", \"value\": $(t "$B" pause web)}"
  echo "{\"step\": \"paused-mem-mb\", \"value\": $(( $(cat "$("$B" cgroup web)/memory.current") / 1048576 ))}"
  echo "{\"step\": \"box-unpause-s\", \"value\": $(t "$B" unpause web)}"
  echo "{\"step\": \"after-unpause-http-s\", \"value\": $(wait_http web http://127.0.0.1:5173/)}"
  "$B" exec web pkill -f vite
  echo "{\"step\": \"box-idle-no-dev-server-mem-mb\", \"value\": $(sleep 3; echo $(( $(cat "$("$B" cgroup web)/memory.current") / 1048576 )))}"
  ;;
disk)
  podman image ls --format '{"step": "image-size", "value": "{{.Size}}"}' localhost/trina-devbox:p0
  for b in web py; do
    echo "{\"step\": \"volume-$b\", \"value\": \"$(du -sh /srv/devbox/vol/$b 2>/dev/null | cut -f1)\", \"node_modules\": \"$(du -sh /srv/devbox/vol/$b/node_modules | cut -f1)\", \"venv\": \"$(du -sh /srv/devbox/vol/$b/venv | cut -f1)\", \"cache\": \"$(du -sh /srv/devbox/vol/$b/cache | cut -f1)\"}"
  done
  echo "{\"step\": \"claude-binary\", \"value\": \"$(du -sh /srv/devbox/claude | cut -f1)\"}"
  echo "{\"step\": \"container-storage\", \"value\": \"$(du -sh ~/.local/share/containers 2>/dev/null | cut -f1)\"}"
  ;;
esac
