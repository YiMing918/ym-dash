// ym-dash 对抗复读 C 部分定向测试（node tests/c-fixes.mjs）
//   C-20 探活 IPv6 校验：[::127.0.0.1] / [::ffff:127.0.0.1] / [::1] /
//        文档段 2001:db8:: 必须拦，正常公网 IPv6 放行；functions 与
//        worker 两份副本都验（worker 经 scheduled 行为验）。
//   C-21 登录失败改内存计数：200 次不同 IP 失败，login_guard 的 KV
//        put = 0（改前每失败 1 笔）；同 IP 第 5 次后锁定语义不变。
//   C-31 events 落盘写后复核合并：flush 写完后被并发写覆盖时能把本轮
//        事件补回去（functions 与 worker 两份副本都验）。
//   C-30 站点增删改指纹复核：写前被并发改过 sites 时不丢对方数据。
//   C-28 首次设置写后回读比对：admin 被并发覆盖时 setup 报错、不发会话。
//   v1.1.7 轮内预算兜底：站表超预算时装不下的站本轮跳过（状态/历史
//        不变、不写记录），装得下的后续站照常查（functions 与 worker 两份副本）。
//   v1.1.7 events 严格读：合并写回时读 events 失败 → 整轮放弃落盘、
//        旧事件原样保留（functions 与 worker 两份副本）。
import { validateUrl, ipBlocked } from '../functions/_lib/probe.js';
import { hashPassword, verifyLogin } from '../functions/_lib/auth.js';
import { loadHistBatch, runCheckAll } from '../functions/_lib/store.js';
import { handle } from '../functions/_lib/router.js';
import worker from '../worker/worker.js';

class KVShim {
  constructor() { this.map = new Map(); this.puts = 0; this.putKeys = []; this.onPut = null; this.onGet = null; }
  async get(k) {
    const v = this.map.has(k) ? this.map.get(k) : null;
    if (this.onGet) { const f = this.onGet; if (f(k)) this.onGet = null; }
    return v;
  }
  async put(k, v) {
    this.puts++; this.putKeys.push(k); this.map.set(k, String(v));
    if (this.onPut) { const f = this.onPut; if (f(k)) this.onPut = null; }
  }
  async delete(k) { this.map.delete(k); }
}
const makeEnv = () => ({ DASH_KV: new KVShim() });
let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

// ---------- C-20 functions 副本 ----------
chk('C-20 [::127.0.0.1] 拦（v4 兼容形式）', validateUrl('http://[::127.0.0.1]/').ok === false);
chk('C-20 [::ffff:127.0.0.1] 拦（v4 映射）', validateUrl('http://[::ffff:127.0.0.1]/').ok === false);
chk('C-20 [::1] 拦（回环）', validateUrl('http://[::1]/').ok === false);
chk('C-20 [2001:db8::1] 拦（文档段）', validateUrl('http://[2001:db8::1]/').ok === false);
chk('C-20 公网 IPv6 放行', validateUrl('http://[2606:4700:4700::1111]/').ok === true);
chk('C-20 ipBlocked ::127.0.0.1', ipBlocked('::127.0.0.1') === true);
chk('C-20 ipBlocked ::ffff:127.0.0.1', ipBlocked('::ffff:127.0.0.1') === true);
chk('C-20 ipBlocked NAT64 内嵌元数据地址', ipBlocked('64:ff9b::a9fe:a9fe') === true);
chk('C-20 ipBlocked 公网 v6 放行', ipBlocked('2606:4700::1') === false);

// ---------- C-20 worker 副本（行为验：scheduled 记「不安全」且不真探） ----------
{
  const env = makeEnv();
  await env.DASH_KV.put('sites', JSON.stringify([{ id: 'w1', name: 'W', url: 'http://[::127.0.0.1]/', note: '', createdAt: 1 }]));
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  try { await worker.scheduled({}, env, {}); } finally { globalThis.fetch = realFetch; }
  const hist = JSON.parse(await env.DASH_KV.get('histall'));
  chk('C-20 worker 副本 [::127.0.0.1] 只记不安全、不真探',
    !fetched && hist.sites.w1 && hist.sites.w1[0].err.includes('不安全'), JSON.stringify(hist));
}

// ---------- C-21 登录失败内存计数 ----------
{
  const env = makeEnv();
  const salt = 'saltX';
  await env.DASH_KV.put('admin', JSON.stringify({ username: 'boss', salt, hash: await hashPassword('right-pw', salt), ver: 'v1' }));
  env.DASH_KV.puts = 0; env.DASH_KV.putKeys = [];
  // 同 IP 锁定语义先验（全局顺序：先做同 IP，再做多 IP 写量）
  let r;
  for (let i = 0; i < 5; i++) r = await verifyLogin(env, 'boss', 'wrong', '9.9.9.9');
  chk('C-21 同 IP 第 5 次失败当次仍普通失败', r.ok === false && !r.locked, JSON.stringify(r));
  r = await verifyLogin(env, 'boss', 'wrong', '9.9.9.9');
  chk('C-21 同 IP 第 6 次起锁定', r.ok === false && !!r.locked, JSON.stringify(r));
  env.DASH_KV.puts = 0; env.DASH_KV.putKeys = [];
  const jobs = [];
  for (let i = 0; i < 200; i++) jobs.push(verifyLogin(env, 'boss', 'wrong', `30.${(i >> 8) & 255}.${i & 255}.3`));
  const all = await Promise.all(jobs);
  const guardPuts = env.DASH_KV.putKeys.filter(k => k.startsWith('login_guard:')).length;
  chk('C-21 200 次不同 IP 失败全失败', all.every(x => x.ok === false));
  chk('C-21 login_guard KV put = 0', guardPuts === 0, `guardPuts=${guardPuts} totalPuts=${env.DASH_KV.puts}`);
}

// ---------- C-31 functions 副本：flush 写后被覆盖能补回 ----------
{
  const env = makeEnv();
  // v1.1.5：flush 落盘事件要过 validIds（L5），先把 sX 建成真实站点，
  // 否则它的事件会被当已删站事件过滤掉（那正是 L5 要的行为）
  await env.DASH_KV.put('sites', JSON.stringify([{ id: 'sX', name: 'X', url: 'https://x.example.com/', note: '', createdAt: 1 }]));
  const ev = { t: 12345, siteId: 'sX', name: 'X', type: 'down', detail: 'boom' };
  // 对手：我们 flush 写 events 后，立刻用「不含本轮事件」的旧值覆盖回去
  env.DASH_KV.onPut = (k) => {
    if (k !== 'events') return false;
    env.DASH_KV.map.set('events', JSON.stringify([{ t: 1, siteId: 'old', name: 'O', type: 'up', detail: '' }]));
    return true;
  };
  const batch = await loadHistBatch(env);
  batch.pendingEvents.push(ev);
  await batch.flush();
  const events = JSON.parse(await env.DASH_KV.get('events'));
  chk('C-31 functions flush 被并发覆盖后事件补回', events.some(e => e.t === 12345 && e.siteId === 'sX'), JSON.stringify(events));
  chk('C-31 functions 对方事件不丢', events.some(e => e.siteId === 'old'), JSON.stringify(events));
}

// ---------- C-31 worker 副本：scheduled 落盘同样补回 ----------
{
  const env = makeEnv();
  await env.DASH_KV.put('sites', JSON.stringify([{ id: 'w2', name: 'W2', url: 'http://93.184.216.34/', note: '', createdAt: 1 }]));
  await env.DASH_KV.put('state:w2', JSON.stringify({ up: false, since: 1 })); // 预置 down，本轮探到 up → 翻转事件
  env.DASH_KV.onPut = (k) => {
    if (k !== 'events') return false;
    env.DASH_KV.map.set('events', JSON.stringify([{ t: 2, siteId: 'old', name: 'O', type: 'up', detail: '' }]));
    return true;
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, body: null });
  try { await worker.scheduled({}, env, {}); } finally { globalThis.fetch = realFetch; }
  const events = JSON.parse(await env.DASH_KV.get('events'));
  chk('C-31 worker flush 被并发覆盖后事件补回', events.some(e => e.siteId === 'w2' && e.type === 'up'), JSON.stringify(events));
}

// ---------- C-30 站点新增指纹复核：并发写不丢 ----------
// ---------- C-28 首次设置写后回读：被覆盖即报错 ----------
{
  // C-28 先验（要未初始化环境）
  const env = makeEnv();
  env.DASH_KV.onPut = (k) => {
    if (k !== 'admin') return false;
    const rival = { username: 'evil', salt: 'x', hash: 'y', pwv: 2, iter: 100000, ver: 'evil-ver', createdAt: 0 };
    env.DASH_KV.map.set('admin', JSON.stringify(rival));
    return true;
  };
  const req = new Request('https://dash.test/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'pw-123456' }),
  });
  const res = await handle({ request: req, env });
  const j = await res.json();
  chk('C-28 admin 被并发覆盖时 setup 报错', res.status === 409 && j.ok === false, `status=${res.status} ${JSON.stringify(j)}`);
  chk('C-28 冲突时不发会话 Cookie', !res.headers.get('set-cookie'));
}
{
  const env = makeEnv();
  // 先正常初始化 + 登录拿 Cookie
  const setupReq = new Request('https://dash.test/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'pw-123456' }),
  });
  const setupRes = await handle({ request: setupReq, env });
  const cookie = setupRes.headers.get('set-cookie');
  chk('C-30 前置：正常初始化成功', setupRes.status === 200 && !!cookie, 'status=' + setupRes.status);
  await env.DASH_KV.put('sites', JSON.stringify([]));
  // 对手：POST /api/sites 第一次读 sites 后，往库里塞一个并发新增的站
  env.DASH_KV.onGet = (k) => {
    if (k !== 'sites') return false;
    const cur = JSON.parse(env.DASH_KV.map.get('sites') || '[]');
    cur.push({ id: 'rival1', name: '并发站', url: 'https://rival.example.com/', note: '', createdAt: 9 });
    env.DASH_KV.map.set('sites', JSON.stringify(cur));
    return true;
  };
  const addReq = new Request('https://dash.test/api/sites', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '我的站', url: 'https://mine.example.com' }),
  });
  const addRes = await handle({ request: addReq, env });
  const sites = JSON.parse(await env.DASH_KV.get('sites'));
  chk('C-30 新增成功且并发站不丢', addRes.status === 200 && sites.some(s => s.id === 'rival1') && sites.some(s => s.name === '我的站'),
    `status=${addRes.status} sites=${JSON.stringify(sites)}`);
}

// ---------- v1.1.7 轮内预算兜底（functions 副本） ----------
{
  const env = makeEnv();
  // 14 个域名站（14×3=42）+ IP 站（43）+ 域名站（43+3=46 超，本轮跳过）
  // + IP 站（43+1=44 装得下，照常查）：验「按预估累计、逐站判断」
  const sites = [];
  for (let i = 0; i < 14; i++) sites.push({ id: 'd' + i, name: 'D' + i, url: `https://d${i}.example.com/`, note: '', createdAt: i });
  sites.push({ id: 'ip1', name: 'IP1', url: 'http://93.184.216.34/', note: '', createdAt: 20 });
  sites.push({ id: 'over', name: 'OVER', url: 'https://over.example.com/', note: '', createdAt: 21 });
  sites.push({ id: 'ip2', name: 'IP2', url: 'http://93.184.216.35/', note: '', createdAt: 22 });
  await env.DASH_KV.put('sites', JSON.stringify(sites));
  // 被跳过站预置旧状态与旧历史：整轮跑完必须原样、不添新记录
  await env.DASH_KV.put('state:over', JSON.stringify({ up: true, since: 111 }));
  await env.DASH_KV.put('histall', JSON.stringify({ v: 1, sites: { over: [{ t: 111, up: true, status: 200, ms: 5, err: '' }] } }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.startsWith('https://cloudflare-dns.com/')) {
      const type = new URL(s).searchParams.get('type');
      const ans = type === 'AAAA' ? [] : [{ type: 1, data: '93.184.216.34' }];
      return { ok: true, status: 200, json: async () => ({ Answer: ans }) };
    }
    return { status: 200, body: null };
  };
  let results;
  try { results = await runCheckAll(env); } finally { globalThis.fetch = realFetch; }
  const hist = JSON.parse(await env.DASH_KV.get('histall'));
  chk('v1.1.7 functions 预算内 16 站都查（14 域名 + 2 IP）', results.length === 16 && !results.some(r => r.id === 'over'), 'results=' + results.length);
  chk('v1.1.7 functions 超预算站无新记录、旧历史原样', (hist.sites.over || []).length === 1 && hist.sites.over[0].t === 111, JSON.stringify(hist.sites.over));
  chk('v1.1.7 functions 超预算站状态保持不变', JSON.parse(await env.DASH_KV.get('state:over')).since === 111);
  chk('v1.1.7 functions 跳过站之后装得下的 IP 站照常查', (hist.sites.ip2 || []).length === 1 && results.some(r => r.id === 'ip2'), JSON.stringify(hist.sites.ip2));
}

// ---------- v1.1.7 轮内预算兜底（worker 副本） ----------
{
  const env = makeEnv();
  const sites = [];
  for (let i = 0; i < 16; i++) sites.push({ id: 'wd' + i, name: 'WD' + i, url: `https://wd${i}.example.com/`, note: '', createdAt: i });
  await env.DASH_KV.put('sites', JSON.stringify(sites));
  await env.DASH_KV.put('state:wd15', JSON.stringify({ up: true, since: 222 }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.startsWith('https://cloudflare-dns.com/')) {
      const type = new URL(s).searchParams.get('type');
      const ans = type === 'AAAA' ? [] : [{ type: 1, data: '93.184.216.34' }];
      return { ok: true, status: 200, json: async () => ({ Answer: ans }) };
    }
    return { status: 200, body: null };
  };
  try { await worker.scheduled({}, env, {}); } finally { globalThis.fetch = realFetch; }
  const hist = JSON.parse(await env.DASH_KV.get('histall'));
  chk('v1.1.7 worker 轮内预算：45 次内 15 个域名站查完', Object.keys(hist.sites).length === 15, 'checked=' + Object.keys(hist.sites).length);
  chk('v1.1.7 worker 第 16 站跳过、状态不变', !hist.sites.wd15 && JSON.parse(await env.DASH_KV.get('state:wd15')).since === 222, JSON.stringify(hist.sites.wd15));
}

// ---------- v1.1.7 events 严格读（functions 副本）：读失败不写回 ----------
{
  const base = makeEnv();
  await base.DASH_KV.put('sites', JSON.stringify([{ id: 'sE', name: 'E', url: 'https://e.example.com/', note: '', createdAt: 1 }]));
  const oldEvents = [{ t: 9, siteId: 'sE', name: 'E', type: 'up', detail: 'old' }];
  await base.DASH_KV.put('events', JSON.stringify(oldEvents));
  // events 键读抛错的 env（模拟 KV 抖动/数据损坏），其余键照常
  const env = { DASH_KV: {
    get: async (k) => { if (k === 'events') throw new Error('kv boom'); return base.DASH_KV.get(k); },
    put: (k, v) => base.DASH_KV.put(k, v),
    delete: (k) => base.DASH_KV.delete(k),
  } };
  const batch = await loadHistBatch(env);
  batch.pendingEvents.push({ t: 100, siteId: 'sE', name: 'E', type: 'down', detail: 'boom' });
  let threw = false;
  try { await batch.flush(); } catch { threw = true; }
  chk('v1.1.7 functions events 读失败 flush 抛错放弃落盘', threw);
  chk('v1.1.7 functions events 读失败旧事件原样保留', JSON.stringify(JSON.parse(await base.DASH_KV.get('events'))) === JSON.stringify(oldEvents), await base.DASH_KV.get('events'));
}

// ---------- v1.1.7 events 严格读（worker 副本）：读失败不写回、不更新 meta ----------
{
  const base = makeEnv();
  await base.DASH_KV.put('sites', JSON.stringify([{ id: 'we', name: 'WE', url: 'http://93.184.216.34/', note: '', createdAt: 1 }]));
  await base.DASH_KV.put('state:we', JSON.stringify({ up: false, since: 1 })); // 本轮探到 up → 翻转事件待落盘
  const oldEvents = [{ t: 9, siteId: 'old', name: 'O', type: 'up', detail: '' }];
  await base.DASH_KV.put('events', JSON.stringify(oldEvents));
  const env = { DASH_KV: {
    get: async (k) => { if (k === 'events') throw new Error('kv boom'); return base.DASH_KV.get(k); },
    put: (k, v) => base.DASH_KV.put(k, v),
    delete: (k) => base.DASH_KV.delete(k),
  } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, body: null });
  try { await worker.scheduled({}, env, {}); } finally { globalThis.fetch = realFetch; }
  chk('v1.1.7 worker events 读失败旧事件保留', JSON.stringify(JSON.parse(await base.DASH_KV.get('events'))) === JSON.stringify(oldEvents), await base.DASH_KV.get('events'));
  chk('v1.1.7 worker 落盘失败不写 meta.lastCheckAt', (await base.DASH_KV.get('meta')) === null);
}

// ---------- v1.1.8 登录用户名 trim：与 setup 口径对齐 ----------
{
  const env = makeEnv();
  const setupRes = await handle({
    request: new Request('https://dash.test/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '7.7.7.7' },
      body: JSON.stringify({ username: '  boss  ', password: 'secret-1' }),
    }), env,
  });
  chk('v1.1.8 前置：带空格用户名初始化成功（存 trim 后）', setupRes.status === 200, 'status=' + setupRes.status);
  const loginRes = await handle({
    request: new Request('https://dash.test/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '7.7.7.8' },
      body: JSON.stringify({ username: 'boss ', password: 'secret-1' }),
    }), env,
  });
  const lj = await loginRes.json();
  chk('v1.1.8 登录用户名带尾随空格也能登入', loginRes.status === 200 && lj.ok && lj.data.user === 'boss',
    `status=${loginRes.status} ${JSON.stringify(lj)}`);
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
