import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPages } from '../scripts/build-pages.mjs';
import { createConfigStore } from '../public/config-store.js';
import { validateConfig } from '../core/config.mjs';

const defaults = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const baseUrl = 'https://example.github.io/SmartCarVector/';
function setup({ staticMode = true, storage } = {}) {
  const calls = [], values = new Map();
  const store = createConfigStore({ staticMode, baseUrl, validate: validateConfig,
    storage: storage ?? (() => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) })),
    request: async (url, options) => {
      calls.push({ url, options });
      return Response.json(url.endsWith('tracks.json') || url.endsWith('api/tracks') ? ['简单赛道.png'] : defaults);
    }
  });
  return { store, calls, values };
}
test('Pages 配置在仓库子路径读取，浏览器保存互相隔离且不写 API', async () => {
  const { store, calls, values } = setup();
  assert.deepEqual((await store.load()).config, defaults);
  assert.deepEqual(await store.tracks(), ['简单赛道.png']);
  assert.equal(store.assetUrl('/algorithms/route-demo.js'), `${baseUrl}algorithms/route-demo.js`);
  const edited = structuredClone(defaults); edited.wheels.diameterMm = 100;
  await store.save(edited);
  assert.equal((await store.load()).config.wheels.diameterMm, 100);
  assert.ok([...values.keys()].every(key => key.endsWith('/SmartCarVector/')));
  assert.ok(calls.every(call => call.url.startsWith(baseUrl) && !call.url.includes('/api/') && !call.options));
  store.clear();
  assert.deepEqual((await store.load()).config, defaults);
});
test('损坏或不可用的浏览器存储不阻止启动，保存失败不会伪报成功', async () => {
  for (const raw of ['not json', '{}']) {
    const { store } = setup({ storage: () => ({ getItem: () => raw }) });
    const loaded = await store.load();
    assert.deepEqual(loaded.config, defaults); assert.ok(loaded.warning);
  }
  const { store } = setup({ storage: () => { throw new Error('Storage blocked'); } });
  assert.deepEqual((await store.load()).config, defaults);
  await assert.rejects(store.save(defaults), /无法保存到浏览器/);
});
test('本地配置仍通过 GET/PUT API 读写，不访问浏览器存储', async () => {
  const { store, calls } = setup({ staticMode: false, storage: () => { throw new Error('不应读取存储'); } });
  await store.load(); await store.tracks(); await store.save(defaults);
  assert.deepEqual(calls.map(call => [call.url, call.options?.method ?? 'GET']), [
    [`${baseUrl}api/config`, 'GET'], [`${baseUrl}api/tracks`, 'GET'], [`${baseUrl}api/config`, 'PUT']
  ]);
});
test('静态发布包含运行资源、中文赛道、算法与默认配置，排除服务器源码', async t => {
  const output = await mkdtemp(path.join(tmpdir(), 'smartcar-pages-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await buildPages(output);
  const files = await readdir(output);
  assert.ok(!files.includes('server.mjs') && !files.includes('test') && !files.includes('.git'));
  assert.match(await readFile(path.join(output, 'runtime-config.js'), 'utf8'), /staticMode = true/);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'config.json'))), defaults);
  const tracks = JSON.parse(await readFile(path.join(output, 'tracks.json')));
  assert.ok(tracks.includes('简单赛道.png') && tracks.includes('复杂赛道.png'));
  for (const track of tracks) assert.ok((await readFile(path.join(output, 'tracks', track))).length > 0);
  for (const file of ['index.html', 'app.js', 'renderer.js', 'config-store.js', 'core/config.mjs', 'core/simulator.mjs', 'algorithms/route-demo.js', '.nojekyll']) {
    await readFile(path.join(output, file));
  }
  assert.doesNotMatch(await readFile(path.join(output, 'index.html'), 'utf8'), /(?:src|href)="\/(?!\/)/);
  assert.match(await readFile(new URL('../public/runtime-config.js', import.meta.url), 'utf8'), /staticMode = false/);
});
