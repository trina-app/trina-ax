# Process flood, sent into the box by vm-tests.sh: fork until the kernel refuses, print the count, end the children.
# HOLD (seconds) at the top of the text: keep them for that time first, so the box stays at its limit.
: "${HOLD:=0}"
HOLD=$HOLD python3 - <<'PY'
import os, signal, time
kids, why = [], 'no limit met'
try:
    while len(kids) < 2000:
        p = os.fork()
        if p == 0:
            time.sleep(60)
            os._exit(0)
        kids.append(p)
except OSError as e:
    why = e.strerror
print('forked', len(kids), 'then:', why, flush=True)
time.sleep(int(os.environ['HOLD']))
for p in kids:
    os.kill(p, signal.SIGKILL)
for p in kids:
    os.waitpid(p, 0)
PY
