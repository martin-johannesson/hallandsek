#!/usr/bin/env node
// Minimal dev server for DXF tool — serves static files + receives test images
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const SAVE_DIR = '/tmp/dxf-tests';
const ROOT = path.join(__dirname, '..');

if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serve(req, res) {
  // POST /api/save-test — save test images
  if (req.method === 'POST' && req.url === '/api/save-test') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        if (data.original) {
          const b64 = data.original.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(path.join(SAVE_DIR, ts + '_original.png'), Buffer.from(b64, 'base64'));
        }
        if (data.snapshot) {
          const b64 = data.snapshot.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(path.join(SAVE_DIR, ts + '_snapshot.png'), Buffer.from(b64, 'base64'));
        }
        if (data.debug) {
          fs.writeFileSync(path.join(SAVE_DIR, ts + '_debug.json'), JSON.stringify(data.debug, null, 2));
        }

        console.log('Sparad: ' + ts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        console.error('Fel:', e.message);
        res.writeHead(400);
        res.end('{"error":"' + e.message + '"}');
      }
    });
    return;
  }

  // GET — serve static files
  let filePath = req.url.split('?')[0];
  if (filePath === '/' || filePath === '/dxf/' || filePath === '/dxf') filePath = '/dxf/index.html';

  const fullPath = path.join(ROOT, filePath);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404);
    res.end('404');
    return;
  }

  const ext = path.extname(fullPath);
  const mime = MIME[ext] || 'application/octet-stream';

  // No cache headers for dev
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(fullPath).pipe(res);
}

const server = http.createServer(serve);
server.listen(PORT, () => {
  console.log('DXF dev-server: http://localhost:' + PORT + '/dxf/');
  console.log('Testbilder sparas i: ' + SAVE_DIR);
});
