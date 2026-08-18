#!/usr/bin/env python3
"""Lokal admin-server för Hallandsek — proxar GitHub API (kringgår CORS)."""
import http.server
import urllib.request
import os

PORT = 8000
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))


class AdminHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_PUT(self):
        if self.path.startswith('/ghproxy/'):
            self._proxy('PUT')
        else:
            self.send_error(405)

    def do_GET(self):
        if self.path.startswith('/ghproxy/'):
            self._proxy('GET')
        else:
            super().do_GET()

    def _proxy(self, method):
        gh_path = self.path[len('/ghproxy/'):]
        url = 'https://api.github.com/' + gh_path

        body = None
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length > 0:
            body = self.rfile.read(content_length)

        headers = {}
        for h in ('Authorization', 'Accept', 'Content-Type'):
            if h in self.headers:
                headers[h] = self.headers[h]

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req)
            self._send_proxy_response(resp.status, resp.read(),
                                       resp.headers.get('Content-Type', 'application/json'))
        except urllib.error.HTTPError as e:
            self._send_proxy_response(e.code, e.read(), 'application/json')

    def _send_proxy_response(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if '/ghproxy/' in (args[0] if args else ''):
            print(f'  [proxy] {args[0]}')


if __name__ == '__main__':
    os.chdir(STATIC_DIR)
    server = http.server.HTTPServer(('', PORT), AdminHandler)
    print(f'Hallandsek admin: http://localhost:{PORT}/admin/')
    print('Ctrl+C för att stänga')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStänger.')
