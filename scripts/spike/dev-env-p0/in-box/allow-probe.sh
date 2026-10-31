#!/bin/sh
# Allowlist box probe: no direct network; HTTPS only through the egress proxy (127.0.0.1:3128 -> egress.sock).
P=http://127.0.0.1:3128
t() { code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 $3 "$2" 2>/dev/null); echo "$1: http=$code rc=$?"; }
t "direct https://example.com (no proxy)" https://example.com ""
t "proxy https://pypi.org/simple/flask/" https://pypi.org/simple/flask/ "-x $P"
t "proxy https://registry.npmjs.org/react" https://registry.npmjs.org/react "-x $P"
t "proxy https://github.com (not listed)" https://github.com "-x $P"
t "proxy http://pypi.org (plain http)" http://pypi.org/ "-x $P"
t "proxy CONNECT pypi.org, SNI github.com" https://github.com "-x $P --connect-to github.com:443:pypi.org:443"
t "proxy https://169.254.169.254 (metadata)" https://169.254.169.254/ "-x $P"
