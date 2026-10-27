import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const prefix = '/SmartCarVector/';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
export function createPreviewServer() {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/' || pathname === prefix.slice(0, -1)) { res.writeHead(302, { Location: prefix }); res.end(); return; }
    try {
      if (!pathname.startsWith(prefix)) throw new Error('Not found');
      const relative = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
      const file = path.resolve(dist, relative);
      if (!file.startsWith(`${path.resolve(dist)}${path.sep}`)) throw new Error('Not found');
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(4173, '127.0.0.1', () => console.log(`Pages 预览：http://127.0.0.1:4173${prefix}（请先 npm run build）`));
}
