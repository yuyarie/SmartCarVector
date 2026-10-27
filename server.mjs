import http from 'node:http';
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './core/config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(root, 'config.json');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
let saving = false;
export function createServer(base = root) {
  const configFile = path.join(base, 'config.json');
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/api/config' && req.method === 'GET') return json(res, 200, JSON.parse(await readFile(configFile, 'utf8')));
      if (pathname === '/api/tracks' && req.method === 'GET') return json(res, 200, (await readdir(base)).filter(f => /\.(png|jpe?g|webp|svg)$/i.test(f)));
      if (pathname === '/api/config' && req.method === 'PUT') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: '仅允许当前站点保存配置' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '请使用 application/json' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 65536) return json(res, 413, { error: '配置不能超过 64 KB' });
        }
        const c = validateConfig(JSON.parse(body));
        const imagePath = resolveInside(base, c.track.image);
        if (!(await stat(imagePath)).isFile()) throw new Error('赛道图片不存在');
        if (saving) return json(res, 409, { error: '配置正在保存，请稍后重试' });
        saving = true;
        try {
          await writeFile(`${configFile}.tmp`, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
          await rename(`${configFile}.tmp`, configFile);
        } finally { saving = false; }
        return json(res, 200, { ok: true });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的请求方法' });
      let file;
      if (pathname.startsWith('/tracks/')) {
        if (!/\.(png|jpe?g|webp|svg)$/i.test(pathname)) return json(res, 404, { error: '图片格式不支持' });
        file = resolveInside(base, pathname.slice(8));
      } else if (pathname.startsWith('/core/')) file = resolveInside(path.join(root, 'core'), pathname.slice(6));
      else file = resolveInside(path.join(root, 'public'), pathname === '/' ? 'index.html' : pathname.slice(1));
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? '文件不存在，请检查赛道路径' : error.message });
    }
  });
}
function resolveInside(base, relative) {
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(`${path.resolve(base)}${path.sep}`)) throw new Error('路径超出项目目录');
  return resolved;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const server = createServer();
  server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
  server.listen(config.server.port, config.server.host, () => console.log(`SmartCar Lab 已启动：http://${config.server.host}:${config.server.port}\n配置文件：${configPath}\n按 Ctrl+C 停止服务。`));
}
