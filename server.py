#!/usr/bin/env python3
"""Local server for Catch the Target (camera access needs http://localhost, not file://)."""
import http.server, socketserver, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.wasm': 'application/wasm', '.task': 'application/octet-stream',
                      '.json': 'application/json', '.css': 'text/css'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'Catch the Target running at http://localhost:{PORT}  (Ctrl+C to stop)')
    httpd.serve_forever()
