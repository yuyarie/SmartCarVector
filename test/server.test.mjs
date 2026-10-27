import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

test('HTTP：页面/模块/中文赛道、合法持久化与非法配置保护', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'smartcar-test-'));
  await copyFile(new URL('../config.json', import.meta.url), path.join(base, 'config.json'));
  await copyFile(new URL('../简单赛道.png', import.meta.url), path.join(base, '简单赛道.png'));
  const server = createServer(base);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(base, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${url}/api/config`)).json();
  config.algorithm.inputProfile = 'full'; // HTTP 持久化测试使用通用配置，不受演示的 5 路限制。
  const originalDiameter = config.wheels.diameterMm;
  assert.ok((await (await fetch(url)).text()).includes('智能车实验室'));
  assert.match((await fetch(`${url}/core/simulator.mjs`)).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${url}/tracks/${encodeURIComponent('简单赛道.png')}`)).status, 200);
  assert.equal((await fetch(`${url}/tracks/config.json`)).status, 404);
  assert.equal((await fetch(`${url}/config.json`)).status, 404);
  assert.deepEqual(await (await fetch(`${url}/api/tracks`)).json(), ['简单赛道.png']);
  const put = c => fetch(`${url}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
  config.infrared.count = 12;
  assert.equal((await put(config)).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(base, 'config.json'), 'utf8')).infrared.count, 12);
  config.wheels.diameterMm = 0;
  assert.equal((await put(config)).status, 400);
  assert.equal((await (await fetch(`${url}/api/config`)).json()).wheels.diameterMm, originalDiameter);
  config.wheels.diameterMm = originalDiameter; config.track.image = '不存在.png';
  assert.equal((await put(config)).status, 404);
  assert.equal((await fetch(`${url}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'http://unrelated.example' }, body: '{}' })).status, 403);
});
