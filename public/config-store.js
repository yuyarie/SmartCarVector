// 浏览器与 Node 测试共用，不在模块加载时访问 localStorage。
export function createConfigStore({ staticMode, baseUrl, validate, request = fetch, storage = () => globalThis.localStorage }) {
  const assetUrl = relative => new URL(relative.replace(/^\/+/, ''), baseUrl).href;
  const key = `smartcar:config:${new URL(baseUrl).pathname}`;
  async function json(relative, options) {
    const response = await request(assetUrl(relative), options);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败 ${response.status}`);
    }
    return response.json();
  }
  return {
    assetUrl,
    defaults: async () => validate(await json(staticMode ? 'config.json' : 'api/config')),
    tracks: () => json(staticMode ? 'tracks.json' : 'api/tracks'),
    async load() {
      const defaults = await this.defaults();
      if (!staticMode) return { config: defaults };
      try {
        const saved = storage().getItem(key);
        return saved ? { config: validate(JSON.parse(saved)), defaults, saved: true } : { config: defaults };
      } catch {
        return { config: defaults, warning: '无法读取浏览器中的配置，已载入站点默认配置' };
      }
    },
    async save(config) {
      validate(config);
      if (!staticMode) return json('api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      try { storage().setItem(key, JSON.stringify(config)); }
      catch { throw new Error('无法保存到浏览器，请允许网站存储，或导出 JSON 配置备份'); }
    },
    clear() {
      try { storage().removeItem(key); }
      catch { throw new Error('无法清除浏览器配置，请检查网站存储权限'); }
    }
  };
}
