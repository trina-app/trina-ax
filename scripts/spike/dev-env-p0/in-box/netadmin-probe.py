# Try to change the box's network from inside (needs CAP_NET_ADMIN over the netns): set lo down via rtnetlink, and
# send an nftables "flush ruleset" batch via nfnetlink. Both must fail with EPERM.
import socket, struct, errno, os
def ack(s):
    d = s.recv(65536); t = struct.unpack_from('=LHHLL', d)[1]
    return -struct.unpack_from('=i', d, 16)[0] if t == 2 else 0
s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0)  # NETLINK_ROUTE
ifi = struct.pack('=BxHiII', 0, 0, socket.if_nametoindex('lo'), 0, 1)  # change IFF_UP -> 0
msg = struct.pack('=LHHLL', 16 + len(ifi), 19, 1 | 4, 1, 0) + ifi      # RTM_SETLINK, REQUEST|ACK
s.send(msg); e = ack(s); print('rtnetlink set lo down:', errno.errorcode.get(e, e) if e else 'ALLOWED')
n = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12)  # NETLINK_NETFILTER
def nl(t, flags, seq, payload): return struct.pack('=LHHLL', 16 + len(payload), t, flags, seq, 0) + payload
nfg = struct.pack('=BBH', 0, 0, socket.htons(10))           # nfgenmsg: AF_UNSPEC, v0, res_id = NFNL_SUBSYS_NFTABLES
batch = nl(0x10, 1, 1, nfg) + nl((10 << 8) | 2, 1 | 4, 2, struct.pack('=BBH', 0, 0, 0)) + nl(0x11, 1, 3, nfg)  # BEGIN, DELTABLE(all), END
n.send(batch); e = ack(n); print('nftables flush ruleset:', errno.errorcode.get(e, e) if e else 'ALLOWED')
