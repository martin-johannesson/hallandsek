#!/usr/bin/env python3
"""Lokal admin-server för Hallandsek — proxar GitHub API med inbyggd token."""
import http.server
import urllib.request
import os
import json
import base64
import time

PORT = 8000
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
TEST_IMG_DIR = os.path.join(STATIC_DIR, 'test_images')
GH_TOKEN = os.environ.get('GH_TOKEN', '')
if not GH_TOKEN:
    _token_file = os.path.join(STATIC_DIR, '.gh_token')
    if os.path.exists(_token_file):
        GH_TOKEN = open(_token_file).read().strip()


class AdminHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/save-test':
            self._handle_save_test()
        elif self.path.startswith('/ghproxy/'):
            self._proxy('POST')
        else:
            self.send_error(404)

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

    def _handle_save_test(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
            os.makedirs(TEST_IMG_DIR, exist_ok=True)
            saved = []

            for key in ('original', 'snapshot'):
                if key not in data:
                    continue
                img_b64 = data[key]
                if ',' in img_b64:
                    img_b64 = img_b64.split(',', 1)[1]
                img_bytes = base64.b64decode(img_b64)

                ts = time.strftime('%Y-%m-%d_%H%M%S')
                filename = f'{key}_{ts}.png'
                filepath = os.path.join(TEST_IMG_DIR, filename)
                with open(filepath, 'wb') as f:
                    f.write(img_bytes)

                latest = os.path.join(TEST_IMG_DIR, f'{key}.png')
                with open(latest, 'wb') as f:
                    f.write(img_bytes)
                saved.append(filename)

            if 'debug' in data:
                dbg_path = os.path.join(TEST_IMG_DIR, 'debug.json')
                with open(dbg_path, 'w') as f:
                    json.dump(data['debug'], f, indent=2, ensure_ascii=False)

            resp = json.dumps({'saved': saved}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(resp)
            print(f'  [save] {", ".join(saved)}')
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _proxy(self, method):
        gh_path = self.path[len('/ghproxy/'):]
        url = 'https://api.github.com/' + gh_path

        body = None
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length > 0:
            body = self.rfile.read(content_length)

        headers = {
            'Authorization': 'Bearer ' + GH_TOKEN,
            'Accept': 'application/vnd.github+json',
        }
        if 'Content-Type' in self.headers:
            headers['Content-Type'] = self.headers['Content-Type']

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
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        path = args[0] if args else ''
        if '/ghproxy/' in path:
            print(f'  [proxy] {path}')
        elif '/api/save-test' in path:
            pass  # handled in _handle_save_test
        elif path.startswith(('GET ', 'HEAD ')):
            pass  # suppress static file noise


if __name__ == '__main__':
    os.chdir(STATIC_DIR)
    server = http.server.HTTPServer(('', PORT), AdminHandler)
    print(f'Hallandsek admin: http://localhost:{PORT}/admin/')
    print(f'DXF-verktyg:      http://localhost:{PORT}/dxf/')
    print(f'Testbilder:       {TEST_IMG_DIR}/')
    print('Ctrl+C för att stänga')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStänger.')
