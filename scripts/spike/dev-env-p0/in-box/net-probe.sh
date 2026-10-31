#!/bin/sh
# Network probe, run inside a box. Each line: target -> REACHED / blocked (curl error).
HOSTIP=${1:-192.168.139.207}; GW=${2:-192.168.139.1}
t() { r=$(curl -s -m 4 "$2" 2>&1 | head -1); c=$?; [ -n "$r" ] && echo "$1: $r" || echo "$1: blocked/none (curl rc=$(curl -s -o /dev/null -m 4 "$2"; echo $?))"; }
t "internet https://example.com" https://example.com
t "LAN 10.99.0.1:80" http://10.99.0.1/
t "metadata 169.254.169.254" http://169.254.169.254/
t "team server $HOSTIP:8080" http://$HOSTIP:8080/
t "gateway $GW:80" http://$GW/
t "host loopback via 169.254.1.2:9999" http://169.254.1.2:9999/
t "host loopback via gw $GW:9999" http://$GW:9999/
t "box 127.0.0.1:9999" http://127.0.0.1:9999/
t "host.containers.internal:8080" http://host.containers.internal:8080/
getent hosts registry.npmjs.org >/dev/null && echo "dns: ok" || echo "dns: fail"
curl -s -m 4 -6 https://example.com -o /dev/null && echo "ipv6 internet: ok" || echo "ipv6 internet: no"
(echo QUIT | timeout 4 curl -s -m 4 telnet://smtp.gmail.com:25 >/dev/null 2>&1) && echo "smtp 25: open" || echo "smtp 25: blocked"
