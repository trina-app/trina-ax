#!/usr/bin/python3 -I
# Stand-in model proxy for the spike (runs as the server account, one unix socket per box). It does what the real
# proxy must do for a box, without any real AI credential:
#   - the socket tells which box calls (the TCP peer check of server/src/proxy/model-proxy.ts cannot work through a
#     box's own network namespace, so P1 binds the token to the box socket instead)
#   - a per-turn token (Bearer or x-api-key) must exist, be unexpired, unrevoked and issued for THIS box
#   - every request is logged (method, path, header names, model) to /srv/trina/proxy-log/<box>.log
# It answers with a scripted Anthropic Messages stream: step N of the turn calls the Bash tool with commands[N]; after
# the last command it answers with text. A command "WRITE:<path>:<text>" asks for the Write tool instead. No model is called.
#
#   model-proxy.py SOCKET BOX                      serve
#   model-proxy.py issue BOX TTL_S CMD [CMD...]    print a new turn token; the turn's Bash commands are CMD...
#   model-proxy.py revoke BOX                      revoke every token of the box
import hashlib, json, os, secrets, socket, socketserver, sys, time, http.server

STATE = '/srv/trina/secrets'
LOGS = '/srv/trina/proxy-log'
h = lambda t: hashlib.sha256(t.encode()).hexdigest()
tok_file = lambda box: f'{STATE}/tokens-{box}.json'


def load(box):
    try:
        return json.load(open(tok_file(box)))
    except FileNotFoundError:
        return {}


def save(box, d):
    tmp = tok_file(box) + '.tmp'
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(d, f)
    os.replace(tmp, tok_file(box))


if sys.argv[1] == 'issue':
    box, ttl, cmds = sys.argv[2], int(sys.argv[3]), sys.argv[4:]
    t = 'mpx_' + secrets.token_urlsafe(32)
    d = load(box)
    d[h(t)] = {'box': box, 'exp': time.time() + ttl, 'revoked': False, 'cmds': cmds}
    save(box, d)
    print(t)
    sys.exit(0)
if sys.argv[1] == 'revoke':
    box = sys.argv[2]
    d = load(box)
    for v in d.values():
        v['revoked'] = True
    save(box, d)
    sys.exit(0)

SOCK, BOX = sys.argv[1], sys.argv[2]
os.makedirs(LOGS, mode=0o700, exist_ok=True)
logf = open(f'{LOGS}/{BOX}.log', 'a', buffering=1)


def log(**kw):
    logf.write(json.dumps({'t': round(time.time(), 3), 'box': BOX, **kw}) + '\n')


def sse(events):
    return ''.join(f'event: {e["type"]}\ndata: {json.dumps(e)}\n\n' for e in events).encode()


def answer(model, block, stop):
    mid = 'msg_' + secrets.token_hex(8)
    start = {'type': 'message_start', 'message': {'id': mid, 'type': 'message', 'role': 'assistant', 'model': model,
             'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 1}}}
    if block['type'] == 'tool_use':
        cb = {'type': 'tool_use', 'id': block['id'], 'name': block['name'], 'input': {}}
        delta = {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])}
    else:
        cb = {'type': 'text', 'text': ''}
        delta = {'type': 'text_delta', 'text': block['text']}
    return [start, {'type': 'content_block_start', 'index': 0, 'content_block': cb},
            {'type': 'content_block_delta', 'index': 0, 'delta': delta},
            {'type': 'content_block_stop', 'index': 0},
            {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 5}},
            {'type': 'message_stop'}], {'id': mid, 'type': 'message', 'role': 'assistant', 'model': model,
            'content': [block], 'stop_reason': stop, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 5}}


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def address_string(self):
        return BOX

    def reply(self, code, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def auth(self):
        a = self.headers.get('authorization', '')
        t = a[7:] if a.lower().startswith('bearer ') else self.headers.get('x-api-key', '')
        row = load(BOX).get(h(t)) if t else None
        if not row:
            return None, 'unknown token'
        if row['box'] != BOX:
            return None, 'token of another box'
        if row['revoked']:
            return None, 'revoked'
        if row['exp'] < time.time():
            return None, 'expired'
        return row, None

    def do_GET(self):
        self.handle_any(None)

    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        self.handle_any(json.loads(self.rfile.read(n) or b'{}'))

    def handle_any(self, body):
        row, why = self.auth()
        log(method=self.command, path=self.path, headers=sorted(k.lower() for k in self.headers.keys()),
            model=(body or {}).get('model'), stream=(body or {}).get('stream'), ok=row is not None, why=why)
        if not row:
            return self.reply(401, {'type': 'error', 'error': {'type': 'authentication_error', 'message': why}})
        path = self.path.split('?')[0]
        if path == '/v1/messages/count_tokens':
            return self.reply(200, {'input_tokens': 10})
        if path != '/v1/messages':
            return self.reply(404, {'type': 'error', 'error': {'type': 'not_found_error', 'message': 'spike proxy'}})
        model = body.get('model', 'claude')
        msgs = body.get('messages', [])
        # side requests (titles, quota checks) carry no tools: plain text
        step = sum(1 for m in msgs if m.get('role') == 'assistant')
        if not body.get('tools') or step >= len(row['cmds']):
            block, stop = {'type': 'text', 'text': 'spike: done'}, 'end_turn'
        else:
            cmd = row['cmds'][step]
            if cmd.startswith('WRITE:'):  # WRITE:<absolute path>:<content> -> Claude Code's Write tool
                _, fp, content = cmd.split(':', 2)
                block = {'type': 'tool_use', 'id': 'toolu_' + secrets.token_hex(8), 'name': 'Write',
                         'input': {'file_path': fp, 'content': content}}
            else:
                block = {'type': 'tool_use', 'id': 'toolu_' + secrets.token_hex(8), 'name': 'Bash',
                         'input': {'command': cmd, 'description': f'spike step {step}'}}
            stop = 'tool_use'
            if msgs and isinstance(msgs[-1].get('content'), list):
                for c in msgs[-1]['content']:
                    if c.get('type') == 'tool_result':
                        log(tool_result=str(c.get('content'))[:4000])
        events, full = answer(model, block, stop)
        if body.get('stream'):
            return self.reply(200, sse(events), 'text/event-stream')
        return self.reply(200, full)

    def log_message(self, *a):
        pass


class S(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


try:
    os.unlink(SOCK)
except FileNotFoundError:
    pass
S(SOCK, H).serve_forever()
