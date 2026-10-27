import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../core/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const imagePattern = /\.(png|jpe?g|webp|svg)$/i;
export async function buildPages(output = path.join(root, 'dist')) {
  // 仅清理工作目录中的固定 dist，或测试提供的空目录，不接受任意清理路径。
  output = path.resolve(output);
  if (output === path.resolve(root, 'dist')) await rm(output, { recursive: true, force: true });
  else if ((await readdir(output)).length) throw new Error('自定义输出目录必须为空');
  const config = validateConfig(JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')));
  await mkdir(output, { recursive: true });
  await cp(path.join(root, 'public'), output, { recursive: true });
  await cp(path.join(root, 'core'), path.join(output, 'core'), { recursive: true });
  const tracks = new Set((await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && imagePattern.test(entry.name)).map(entry => entry.name));
  async function scanTracks(relative) {
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await scanTracks(name);
      else if (entry.isFile() && imagePattern.test(entry.name)) tracks.add(name);
    }
  }
  await scanTracks('tracks');
  tracks.add(config.track.image.replaceAll('\\', '/'));
  for (const track of tracks) {
    const target = path.join(output, 'tracks', track);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, track), target);
  }
  if (!(await stat(path.join(output, config.algorithm.module.slice(1)))).isFile()) throw new Error('默认算法模块不存在');
  await writeFile(path.join(output, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(output, 'tracks.json'), `${JSON.stringify([...tracks].sort(), null, 2)}\n`);
  await writeFile(path.join(output, 'runtime-config.js'), 'export const staticMode = true;\n');
  await writeFile(path.join(output, '.nojekyll'), '');
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`静态网站已生成：${await buildPages()}`);
}
