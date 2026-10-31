#!/usr/bin/python3 -I
# Measure one step in a box: wall time, CPU time, memory peak of the whole box cgroup, OOM kills.
#   measure.py CGROUP_DIR LABEL -- CMD...        (CMD normally is `box.sh exec BOX ...`)
#   measure.py CGROUP_DIR LABEL --idle SECONDS   (no command: measure the box as it is, e.g. an idle dev server)
# mem_peak = memory.peak (anon + page cache); anon_peak = sampled every 0.2 s from memory.stat (what the box
# really needs; page cache is given back under pressure). memory.peak is reset for this open file (kernel 6.12+: a write starts a new peak for the writer's fd).
# Prints one JSON line.
import json, os, subprocess, sys, threading, time

cg, label = sys.argv[1], sys.argv[2]
rest = sys.argv[3:]


def cpu_us():
    for line in open(f'{cg}/cpu.stat'):
        if line.startswith('usage_usec'):
            return int(line.split()[1])


def ev(name):
    for line in open(f'{cg}/memory.events'):
        k, v = line.split()
        if k == name:
            return int(v)


peak_fd = os.open(f'{cg}/memory.peak', os.O_RDWR)
os.write(peak_fd, b'0')
mx, samples, anon, filec, stop = 0, [], [], [], False


def stat():
    d = dict(l.split() for l in open(f'{cg}/memory.stat'))
    return int(d['anon']), int(d['file'])


def sample():
    global mx
    while not stop:
        cur = int(open(f'{cg}/memory.current').read())
        mx = max(mx, cur)
        samples.append(cur)
        a, fi = stat()
        anon.append(a)
        filec.append(fi)
        time.sleep(0.2)


c0, oom0, t0 = cpu_us(), ev('oom_kill'), time.time()
th = threading.Thread(target=sample, daemon=True)
th.start()
rc = None
if rest[0] == '--idle':
    time.sleep(float(rest[1]))
else:
    rc = subprocess.call(rest[1:] if rest[0] == '--' else rest, stdout=subprocess.DEVNULL if os.environ.get('QUIET') else None)
stop = True
th.join()
wall = time.time() - t0
cpu = (cpu_us() - c0) / 1e6
os.lseek(peak_fd, 0, 0)
peak = int(os.read(peak_fd, 64))
print(json.dumps({'step': label, 'rc': rc, 'wall_s': round(wall, 2), 'cpu_s': round(cpu, 2),
                  'cpu_avg_pct': round(100 * cpu / wall, 1) if wall else 0, 'mem_peak_mb': round(peak / 2**20),
                  'mem_end_mb': round(samples[-1] / 2**20) if samples else None,
                  'mem_avg_mb': round(sum(samples) / len(samples) / 2**20) if samples else None,
                  'anon_peak_mb': round(max(anon) / 2**20) if anon else None,
                  'anon_avg_mb': round(sum(anon) / len(anon) / 2**20) if anon else None,
                  'file_cache_end_mb': round(filec[-1] / 2**20) if filec else None,
                  'oom_kills': ev('oom_kill') - oom0}), flush=True)
