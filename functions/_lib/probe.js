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
  // 带用户名/密码的网址一律拒绝：会被原样存进 KV 并经公开接口返回，
  // 而且不少探针/客户端会把这段当凭证处理，风险大于用途
  if (u.username || u.password) {
    return { ok: false, error: '网址不能带用户名 / 密码' };
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 字面量去方括号（不同运行时返回不一）
  host = host.replace(/\.$/, ''); // 尾点规范化：localhost. / 192.168.1.1. 不能绕过下面的判断
  if (!host) return { ok: false, error: '网址缺少域名' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
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
    if (a === 100 && b >= 64 && b <= 127) return { ok: false, error: '不允许运营商级 NAT 地址（100.64/10）' };
    if (a === 198 && (b === 18 || b === 19)) return { ok: false, error: '不允许基准测试保留地址（198.18/15）' };
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

// 探活一次：手动跟随重定向（最多 5 跳），每一跳都重新过 validateUrl——
// 自动 follow 时第二跳起就没人校验，一个公网网址 302 到内网地址
// 就能绕过 SSRF 防护。整条链共用一个超时预算。2xx/3xx 视为可用（up）。
// 返回 { up, status(0=没拿到响应), ms, err }
const MAX_HOPS = 5;
export async function probeUrl(url, timeoutMs = 10000) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const done = (up, status, err = '') => ({ up, status, ms: Date.now() - started, err });
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const v = validateUrl(current);
      if (!v.ok) return done(false, 0, hop === 0 ? '地址不安全，已跳过探活' : '重定向到不安全地址，已拦截');
      const res = await fetch(v.url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'user-agent': 'ym-dash-probe/1.0 (+status check)' },
      });
      const status = res.status || 0;
      // 不读正文，及时释放连接
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* 忽略 */ }
      if (status >= 300 && status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return done(true, status); // 无 Location 的 3xx，按可用计（与旧行为一致）
        if (hop === MAX_HOPS) return done(false, status, '重定向次数过多');
        try { current = new URL(loc, v.url).toString(); }
        catch { return done(false, status, '重定向地址无效'); }
        continue;
      }
      return done(status >= 200 && status < 400, status, status >= 400 ? `HTTP ${status}` : '');
    }
    return done(false, 0, '重定向次数过多');
  } catch (e) {
    const err = (e && e.name === 'AbortError') ? `超时 ${timeoutMs / 1000}s` : String((e && e.message) || e || '网络错误').slice(0, 120);
    return done(false, 0, err);
  } finally {
    clearTimeout(timer);
  }
}
