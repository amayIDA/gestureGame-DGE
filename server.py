#!/usr/bin/env python3
"""Catch the Target — server for the game screen and the tablet registration app (Mac / any OS).

Serves the game at http://127.0.0.1:7420/ and the registration app at http://<this-computer>:7420/register/
on the local network, plus the small player-queue API the two use to talk to each other.
Implements exactly the same API as launcher-src/server.go (the Windows .exe) — keep them in sync.

    python3 server.py            # port 7420
    python3 server.py 7421       # another port
"""
import csv, http.server, json, os, socket, socketserver, sys, threading, time, unicodedata

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7420
ROOT = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(ROOT, 'registrations.csv')
os.chdir(ROOT)


def now_ms():
    return int(time.time() * 1000)


def clean_text(v, maxlen):
    """trim, drop control characters, collapse whitespace, limit length (characters)"""
    out, space = [], False
    for ch in str(v or '').strip():
        if ch.isspace():
            if not space:
                out.append(' ')
            space = True
            continue
        if unicodedata.category(ch) == 'Cc':
            continue
        space = False
        out.append(ch)
    return ''.join(out).strip()[:maxlen].strip()


def safe_cell(v):
    return "'" + v if v and v[0] in '=+-@\t\r' else v


class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.seq, self.next_id = 0, 1
        self.queue, self.current, self.recent = [], None, []
        self.last_game = 0.0

    @staticmethod
    def view(s):
        return {'id': s['id'], 'mode': s['mode'], 'players': [{'name': p['name']} for p in s['players']],
                'status': s['status'], 'results': s.get('results'), 'winner': s.get('winner'),
                'created': s['created'], 'updated': s['updated']}

    def finish(self, s, status):
        s['status'], s['updated'] = status, now_ms()
        self.recent = ([s] + self.recent)[:10]

    def log(self, event, s, idx, p, res=None):
        try:
            new = not os.path.exists(CSV_PATH)
            with open(CSV_PATH, 'a', newline='', encoding='utf-8-sig' if new else 'utf-8') as f:
                w = csv.writer(f)
                if new:
                    w.writerow(['time', 'event', 'session', 'mode', 'player', 'name', 'email', 'score', 'correct', 'wrong', 'outcome'])
                score = correct = wrong = outcome = ''
                if res:
                    score, correct, wrong = res.get('score', ''), res.get('correct', ''), res.get('wrong', '')
                    win = s.get('winner')
                    outcome = 'solo' if s['mode'] == 'single' else 'tie' if win is None else 'win' if win == idx else 'lose'
                w.writerow([time.strftime('%Y-%m-%d %H:%M:%S'), event, s['id'], s['mode'], idx + 1,
                            safe_cell(p['name']), safe_cell(p.get('email', '')), score, correct, wrong, outcome])
        except OSError:
            pass

    # ── API ──
    def state(self, is_game):
        with self.lock:
            if is_game:
                self.last_game = time.time()
            return 200, {'seq': self.seq, 'now': now_ms(), 'gameOnline': time.time() - self.last_game < 4,
                         'current': self.view(self.current) if self.current else None,
                         'queue': [self.view(s) for s in self.queue], 'recent': [self.view(s) for s in self.recent]}

    def register(self, body):
        mode = body.get('mode')
        want = {'single': 1, 'multi': 2}.get(mode)
        players_in = body.get('players') if isinstance(body.get('players'), list) else []
        if not want or len(players_in) != want:
            return 400, {'error': 'bad_mode'}
        players = []
        for i, p in enumerate(players_in):
            p = p if isinstance(p, dict) else {}
            name, email = clean_text(p.get('name'), 30), clean_text(p.get('email'), 100)
            if not name:
                return 400, {'error': 'name_required', 'player': i + 1}
            if email and ('@' not in email or any(c in email for c in ' ,;')):
                return 400, {'error': 'bad_email', 'player': i + 1}
            players.append({'name': name, 'email': email})
        with self.lock:
            if len(self.queue) >= 30:
                return 409, {'error': 'queue_full'}
            s = {'id': 'S%03d' % self.next_id, 'mode': mode, 'players': players, 'status': 'queued',
                 'results': None, 'winner': None, 'created': now_ms(), 'updated': now_ms()}
            self.next_id += 1
            self.queue.append(s)
            self.seq += 1
            ahead = len(self.queue) - 1 + (1 if self.current else 0)
            for i, p in enumerate(players):
                self.log('registered', s, i, p)
            return 200, {'id': s['id'], 'ahead': ahead}

    def next(self):
        with self.lock:
            self.last_game = time.time()
            if self.current is None and self.queue:
                self.current = self.queue.pop(0)
                self.current['status'], self.current['updated'] = 'waiting', now_ms()
                self.seq += 1
            return 200, {'session': self.view(self.current) if self.current else None}

    def status(self, body):
        st = body.get('status')
        if st not in ('waiting', 'countdown', 'playing', 'results', 'done', 'noshow'):
            return 400, {'error': 'bad_status'}
        with self.lock:
            self.last_game = time.time()
            s = self.current
            if not s or s['id'] != body.get('id'):
                return 409, {'error': 'not_current'}
            if st == 'results':
                results = body.get('results') if isinstance(body.get('results'), list) else []
                clean = []
                for r in results:
                    r = r if isinstance(r, dict) else {}
                    clean.append({'name': clean_text(r.get('name'), 30), **{k: int(r.get(k) or 0) for k in ('score', 'correct', 'wrong', 'best')}})
                win = body.get('winner')
                s['results'], s['winner'] = clean, win if isinstance(win, int) else None
                for i, p in enumerate(s['players']):
                    self.log('result', s, i, p, clean[i] if i < len(clean) else None)
            if st in ('done', 'noshow'):
                if st == 'noshow':
                    for i, p in enumerate(s['players']):
                        self.log('noshow', s, i, p)
                self.finish(s, st)
                self.current = None
            else:
                s['status'], s['updated'] = st, now_ms()
            self.seq += 1
            return 200, {'ok': True}

    def remove(self, body):
        sid = body.get('id')
        with self.lock:
            for i, s in enumerate(self.queue):
                if s['id'] == sid:
                    self.queue.pop(i)
                    self.finish(s, 'cancelled')
                    for j, p in enumerate(s['players']):
                        self.log('cancelled', s, j, p)
                    self.seq += 1
                    return 200, {'ok': True}
            if self.current and self.current['id'] == sid and self.current['status'] == 'waiting':
                s, self.current = self.current, None
                self.finish(s, 'cancelled')
                for j, p in enumerate(s['players']):
                    self.log('cancelled', s, j, p)
                self.seq += 1
                return 200, {'ok': True}
            return 409, {'error': 'not_removable'}


def lan_ips():
    """private IPv4 addresses of this computer, best first"""
    ips = set()
    try:  # the address used to reach the network (no packet is actually sent)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    def private(ip):
        a, b = (int(x) for x in ip.split('.')[:2])
        return a == 10 or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31)
    return sorted((ip for ip in ips if private(ip)), key=lambda ip: (0 if ip.startswith('192.168.') else 1 if ip.startswith('10.') else 2, ip))


HUB = Hub()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
                      '.task': 'application/octet-stream', '.json': 'application/json', '.css': 'text/css',
                      '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass

    def send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def path_only(self):
        return self.path.split('?', 1)[0]

    def do_GET(self):
        p = self.path_only()
        if p == '/__ping':
            data = b'catch-the-target'
            self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        elif p == '/api/info':
            self.send_json(200, {'port': PORT, 'tabletUrls': [f'http://{ip}:{PORT}/register/' for ip in lan_ips()]})
        elif p == '/api/state':
            self.send_json(*HUB.state('client=game' in self.path))
        elif p.startswith('/api/'):
            self.send_json(405, {'error': 'method'})
        else:
            super().do_GET()

    def do_POST(self):
        p = self.path_only()
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > 32 * 1024:
                return self.send_json(400, {'error': 'bad_json'})
            body = json.loads(self.rfile.read(n) or b'{}') if p != '/api/next' else {}
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            return self.send_json(400, {'error': 'bad_json'})
        routes = {'/api/register': lambda: HUB.register(body), '/api/next': HUB.next,
                  '/api/status': lambda: HUB.status(body), '/api/remove': lambda: HUB.remove(body)}
        if p in routes:
            self.send_json(*routes[p]())
        else:
            self.send_json(404, {'error': 'not_found'})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    try:
        httpd = Server(('0.0.0.0', PORT), Handler)
    except OSError:
        print(f'! Port {PORT} is already in use. Is Catch the Target already running?')
        print(f'  Or start on another port:  python3 server.py {PORT + 1}')
        sys.exit(1)
    print('────────────────────────────────────────')
    print('  Catch the Target')
    print('────────────────────────────────────────')
    print(f'✓ Game:          http://127.0.0.1:{PORT}/')
    print(f'✓ Registrations: {CSV_PATH}')
    ips = lan_ips()
    if ips:
        print('\n  ┌─ ON THE TABLET (same Wi-Fi) open: ─────────────')
        for ip in ips:
            print(f'  │   http://{ip}:{PORT}/register/')
        print('  └────────────────────────────────────────────────\n')
    else:
        print("! This computer isn't on a network — the tablet can't reach it.")
    print('Press Ctrl+C to stop.')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
