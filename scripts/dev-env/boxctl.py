#!/usr/bin/python3 -I
# Tiny boxd client for the VM tests (run as the server stand-in account):
#   boxctl.py SOCK '{"op":"status"}'
#   boxctl.py SOCK exec BOX 'command' [timeout_s] [cwd]
import json, socket, sys
sock = sys.argv[1]
if sys.argv[2] == 'exec':
    req = {"op": "exec", "box": sys.argv[3], "command": sys.argv[4], "timeoutMs": int(float(sys.argv[5] if len(sys.argv) > 5 else 120) * 1000),
           "cwd": sys.argv[6] if len(sys.argv) > 6 else "", "background": False, "actor": "vm-test"}
else:
    req = json.loads(sys.argv[2])
s = socket.socket(socket.AF_UNIX); s.connect(sock); s.sendall((json.dumps(req) + "\n").encode())
buf = b""
while b"\n" not in buf:
    d = s.recv(1 << 20)
    if not d: break
    buf += d
ans = json.loads(buf.split(b"\n")[0] or b'{"ev":"error","message":"no answer"}')
if req["op"] == "exec" and ans.get("ev") == "exit":
    sys.stdout.write(ans["stdout"]); sys.stderr.write(ans["stderr"])
    print(f"[exit {ans['code']} {ans['signal']} {ans['ms']} ms]", file=sys.stderr)
    sys.exit(0 if ans["code"] == 0 else 1)
print(json.dumps(ans))
sys.exit(0 if ans.get("ev") != "error" else 1)
