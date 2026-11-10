// probe.js — 探活与 URL 安全校验（SSRF 防护）
// 同步点：worker/worker.js 里有一份同逻辑副本（Worker 独立部署、不能跨目录 import）。
// 修改本文件的 validateUrl / probeUrl 时，必须同步修改 worker/worker.js，反之亦然。

// 只允许 http/https；拒绝回环 / 内网 / 链路本地等地址，防止把本站当跳板扫内网（SSRF）。
export function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); }
  catch { return { ok: false, error: '网址格式不对' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '只允许 http/https 网址' };
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 字面量去方括号（不同运行时返回不一）
  if (!host) return { ok: false, error: '网址缺少域名' };
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: '不允许本机 / 内网域名' };
  }
  // IPv4 字面量：逐段判断私有 / 回环 / 链路本地 / 保留段
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return { ok: false, error: '不允许内网 / 回环地址' };
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, error: '不允许内网地址' };
    if (a === 192 && b === 168) return { ok: false, error: '不允许内网地址' };
    if (a === 169 && b === 254) return { ok: false, error: '不允许链路本地地址' };
    if (a >= 224) return { ok: false, error: '不允许保留地址' };
  }
  // IPv6 字面量（URL 解析后 hostname 不带方括号）：回环 / 唯一本地 / 链路本地一律拒绝
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return { ok: false, error: '不允许回环地址' };
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return { ok: false, error: '不允许内网 / 链路本地地址' };
    if (host.startsWith('::ffff:')) return { ok: false, error: '不允许 IPv4 映射地址' };
  }
  return { ok: true, url: u.toString() };
}

// 探活一次：跟随重定向取最终状态码；2xx/3xx 视为可用（up）。
// 返回 { up, status(0=没拿到响应), ms, err }
export async function probeUrl(url, timeoutMs = 10000) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'user-agent': 'ym-dash-probe/1.0 (+status check)' },
    });
    const ms = Date.now() - started;
    // 不读正文，及时释放连接
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* 忽略 */ }
    const status = res.status || 0;
    return { up: status >= 200 && status < 400, status, ms, err: status >= 400 ? `HTTP ${status}` : '' };
  } catch (e) {
    const ms = Date.now() - started;
    const err = (e && e.name === 'AbortError') ? `超时 ${timeoutMs / 1000}s` : String((e && e.message) || e || '网络错误').slice(0, 120);
    return { up: false, status: 0, ms, err };
  } finally {
    clearTimeout(timer);
  }
}
