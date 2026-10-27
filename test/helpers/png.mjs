// 测试直接采样真实赛道 PNG，不用理想化线段替代图片。
import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
export async function readPng(file) {
  const buffer = await readFile(file), chunks = [];
  let width, height, channels;
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8), data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[12] !== 0) throw new Error('测试读取器仅支持非交错 8 位 RGB/RGBA PNG');
      channels = data[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, decoded = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= channels ? decoded[i - channels] : 0, b = y ? decoded[i - stride] : 0, c = y && x >= channels ? decoded[i - stride - channels] : 0;
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      if (prediction === undefined) throw new Error('未知 PNG 过滤器');
      decoded[i] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) { data[i * 4] = decoded[i * channels]; data[i * 4 + 1] = decoded[i * channels + 1]; data[i * 4 + 2] = decoded[i * channels + 2]; data[i * 4 + 3] = channels === 4 ? decoded[i * channels + 3] : 255; }
  return { width, height, data };
}
