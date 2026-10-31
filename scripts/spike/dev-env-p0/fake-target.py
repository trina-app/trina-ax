#!/usr/bin/python3 -I
# A stand-in network target: answers every HTTP request with "REACHED <name>". Used to prove a box cannot reach it.
import sys, http.server
host, port, name = sys.argv[1], int(sys.argv[2]), sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = f"REACHED {name}\n".encode(); self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer((host, port), H).serve_forever()
