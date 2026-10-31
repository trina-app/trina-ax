#!/usr/bin/python3 -I
# Stand-in egress proxy for "allowlist" boxes (runs as the server account, one unix socket per box). Only HTTPS
# CONNECT to port 443 of an allowed host. Checks, in order:
#   1. the CONNECT host is on the box's allowlist (/srv/trina/secrets/allowlist-<box>, one domain per line;
#      "example.org" also allows its subdomains)
#   2. every address the host resolves to is public (no RFC1918, loopback, link-local, metadata: DNS rebinding)
#   3. the TLS ClientHello's SNI is the same host (a client cannot CONNECT to an allowed name and then talk TLS to
#      another name on the same address)
# Every decision is logged to /srv/trina/proxy-log/<box>-egress.log: destination audit (review hole 7).
#   egress-proxy.py SOCKET BOX
import ipaddress, json, os, socket, socketserver, sys, threading, time

SOCK, BOX = sys.argv[1], sys.argv[2]
LOGS = '/srv/trina/proxy-log'
os.makedirs(LOGS, mode=0o700, exist_ok=True)
logf = open(f'{LOGS}/{BOX}-egress.log', 'a', buffering=1)


def log(**kw):
    logf.write(json.dumps({'t': round(time.time(), 3), 'box': BOX, **kw}) + '\n')


def allowed(host):
    try:
        lines = open(f'/srv/trina/secrets/allowlist-{BOX}').read().split()
    except FileNotFoundError:
        return False
    return any(host == d or host.endswith('.' + d) for d in lines)


def public(ip):
    a = ipaddress.ip_address(ip)
    return a.is_global and not a.is_multicast


def sni(hello):
    # TLS record(5) handshake(4) version(2) random(32) session_id cipher_suites compression extensions
    try:
        if hello[0] != 0x16 or hello[5] != 0x01:
            return None
        p = 5 + 4 + 2 + 32
        p += 1 + hello[p]
        p += 2 + int.from_bytes(hello[p:p + 2], 'big')
        p += 1 + hello[p]
        end = p + 2 + int.from_bytes(hello[p:p + 2], 'big')
        p += 2
        while p + 4 <= end:
            typ, ln = int.from_bytes(hello[p:p + 2], 'big'), int.from_bytes(hello[p + 2:p + 4], 'big')
            if typ == 0:
                q = p + 4 + 2
                if hello[q] == 0:
                    n = int.from_bytes(hello[q + 1:q + 3], 'big')
                    return hello[q + 3:q + 3 + n].decode('ascii', 'replace').lower()
            p += 4 + ln
    except IndexError:
        return None
    return None


def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class H(socketserver.BaseRequestHandler):
    def handle(self):
        c = self.request
        head = b''
        while b'\r\n\r\n' not in head and len(head) < 8192:
            d = c.recv(4096)
            if not d:
                return
            head += d
        line = head.split(b'\r\n', 1)[0].decode('latin-1')
        parts = line.split()
        if len(parts) < 2 or parts[0] != 'CONNECT':
            log(decision='refused', why='not CONNECT', line=line[:200])
            c.sendall(b'HTTP/1.1 405 Only CONNECT\r\nContent-Length: 0\r\n\r\n')
            return
        host, _, port = parts[1].rpartition(':')
        host = host.strip('[]').lower()
        if port != '443' or not allowed(host):
            log(decision='refused', why='not on allowlist', host=host, port=port)
            c.sendall(b'HTTP/1.1 403 Not on the allowlist\r\nContent-Length: 0\r\n\r\n')
            return
        try:
            addrs = {ai[4][0] for ai in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        except OSError as e:
            log(decision='refused', why='dns', host=host, err=str(e))
            c.sendall(b'HTTP/1.1 502 DNS\r\nContent-Length: 0\r\n\r\n')
            return
        if not addrs or not all(public(a) for a in addrs):
            log(decision='refused', why='non-public address', host=host, addrs=sorted(addrs))
            c.sendall(b'HTTP/1.1 403 Address not public\r\nContent-Length: 0\r\n\r\n')
            return
        c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        c.settimeout(10)
        hello = c.recv(16384)
        c.settimeout(None)
        name = sni(hello)
        if name != host:
            log(decision='refused', why='sni mismatch', host=host, sni=name)
            return
        try:
            u = socket.create_connection((sorted(addrs)[0], 443), timeout=10)
        except OSError as e:
            log(decision='failed', host=host, err=str(e))
            return
        u.settimeout(None)
        u.sendall(hello)
        log(decision='allowed', host=host, addr=sorted(addrs)[0])
        t = threading.Thread(target=pump, args=(u, c), daemon=True)
        t.start()
        pump(c, u)
        t.join()


class S(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


try:
    os.unlink(SOCK)
except FileNotFoundError:
    pass
S(SOCK, H).serve_forever()
