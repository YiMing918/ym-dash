// smoke.mjs — ym-dash 本地冒烟测试（不依赖外网、不进生产）
// 用法：node scripts/smoke.mjs（Node ≥ 18）
// 做法：内存 KV shim 替 DASH_KV；globalThis.fetch 打桩模拟被探站点（200 / 抛错 / 500）；
// 直调 functions 的 handle 与 Worker 的 scheduled，覆盖初始化→登录→加站→探活落库→
// 可用率→事件→权限→SSRF→删除→锁定→Worker 定时探活全链路。账号密码均为本地虚构值。

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { handle } = await import(pathToFileURL(join(root, 'functions/_lib/router.js')).href);
const worker = (await import(pathToFileURL(join(root, 'worker/worker.js')).href)).default;

// ---------- KV shim（值只存字符串，对齐真实 KV） ----------
class KVShim {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
}
const makeEnv = () => ({ DASH_KV: new KVShim() });

// ---------- fetch 打桩：模拟被探站点 ----------
const net = new Map(); // url -> 'up' | 'down' | '500'
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  const mode = net.get(u) || 'up';
  if (mode === 'down') throw new Error('fetch failed (stub)');
  return { status: mode === '500' ? 500 : 200, body: null };
};

// ---------- 小工具 ----------
let pass = 0, total = 0;
function check(name, cond, extra = '') {
  total++;
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`);
}
async function req(env, method, path, { body, cookie } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const request = new Request('https://dash.test' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handle({ request, env });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function setupAndLogin(env) {
  const r = await req(env, 'POST', '/api/setup', { body: { username: 'admin', password: 'pass1234' } });
  return r.cookie;
}

// ================= 场景 A：主流程 =================
{
  const env = makeEnv();
  net.set('https://down.example.com/', 'down');

  let r = await req(env, 'GET', '/api/public');
  check('A1 未初始化时 public.initialized=false', r.j.data.initialized === false && r.j.data.sites.length === 0);

  r = await req(env, 'POST', '/api/setup', { body: { username: 'admin', password: '123' } });
  check('A2 初始化密码太短被拒', r.status === 400);
  const cookie = await setupAndLogin(env);
  check('A3 初始化成功并下发会话 Cookie', !!cookie && cookie.startsWith('dash_session='));

  r = await req(env, 'POST', '/api/setup', { body: { username: 'x', password: 'pass1234' } });
  check('A4 初始化后 setup 敞口关闭', r.status === 403);

  r = await req(env, 'POST', '/api/sites', { body: { name: '未登录', url: 'https://up.example.com/' } });
  check('A5 未登录加站被拒 401', r.status === 401);

  r = await req(env, 'POST', '/api/sites', { cookie, body: { name: '正常站', url: 'https://up.example.com/', note: 'stub 200' } });
  check('A6 登录后加站成功', r.status === 200 && !!r.j.data.site.id);
  const upId = r.j.data.site.id;
  r = await req(env, 'POST', '/api/sites', { cookie, body: { name: '故障站', url: 'https://down.example.com/' } });
  const downId = r.j.data.site.id;
  check('A7 第二个站添加成功', r.status === 200 && !!downId);

  // SSRF 一组
  for (const [u, label] of [
    ['http://127.0.0.1/admin', '回环 127.0.0.1'],
    ['https://192.168.1.1/x', '内网 192.168'],
    ['https://10.0.0.5/', '内网 10.x'],
    ['http://[::1]/', 'IPv6 回环'],
    ['ftp://example.com/', '非 http 协议'],
    ['https://localhost:8080/', 'localhost'],
  ]) {
    r = await req(env, 'POST', '/api/sites', { cookie, body: { name: '坏地址', url: u } });
    check(`A8 SSRF 被拒：${label}`, r.status === 400, `status=${r.status}`);
  }

  r = await req(env, 'POST', '/api/check', { cookie });
  const resMap = Object.fromEntries((r.j.data.results || []).map(x => [x.id, x]));
  check('A9 全量探活：正常站 up + HTTP 200', resMap[upId]?.up === true && resMap[upId]?.status === 200);
  check('A10 全量探活：故障站 down', resMap[downId]?.up === false);

  r = await req(env, 'GET', '/api/public');
  const d = r.j.data;
  const upSite = d.sites.find(s => s.id === upId);
  const downSite = d.sites.find(s => s.id === downId);
  check('A11 公开汇总计数 total=2 up=1 down=1', d.counts.total === 2 && d.counts.up === 1 && d.counts.down === 1, JSON.stringify(d.counts));
  check('A12 可用率：正常站 100 / 故障站 0', upSite.uptime24h === 100 && downSite.uptime24h === 0);
  check('A13 故障站生成 down 事件 + downSince 落库', d.events.some(e => e.siteId === downId && e.type === 'down') && !!downSite.downSince);
  check('A14 历史落库：故障站 hist 有记录', JSON.parse(await env.DASH_KV.get(`hist:${downId}`)).length >= 1);

  // 故障站恢复 → 应生成 up 事件
  net.set('https://down.example.com/', 'up');
  r = await req(env, 'POST', '/api/check', { cookie });
  r = await req(env, 'GET', '/api/public');
  const evTypes = r.j.data.events.filter(e => e.siteId === downId).map(e => e.type);
  check('A15 恢复后生成 up 事件（down→up 两条都在）', evTypes.includes('up') && evTypes.includes('down'), evTypes.join(','));
  check('A16 恢复后 downSince 清空', r.j.data.sites.find(s => s.id === downId).downSince === null);

  r = await req(env, 'GET', `/api/detail/${downId}`);
  check('A17 详情接口返回历史 ≥2 条', (r.j.data.hist || []).length >= 2);

  r = await req(env, 'PUT', `/api/sites/${upId}`, { cookie, body: { name: '正常站·改名', url: 'https://up.example.com/', note: '' } });
  check('A18 编辑站点成功', r.status === 200 && r.j.data.site.name === '正常站·改名');

  r = await req(env, 'DELETE', `/api/sites/${upId}`, { cookie });
  check('A19 删除站点成功', r.status === 200);
  check('A20 删除连带清掉 hist/state', (await env.DASH_KV.get(`hist:${upId}`)) === null && (await env.DASH_KV.get(`state:${upId}`)) === null);
  r = await req(env, 'GET', '/api/public');
  check('A21 删除后公开列表只剩 1 站', r.j.data.sites.length === 1);

  await req(env, 'POST', '/api/logout', { cookie });
  r = await req(env, 'POST', '/api/sites', { cookie, body: { name: 'x', url: 'https://up.example.com/' } });
  check('A22 退出后会话失效、加站被拒', r.status === 401);
}

// ================= 场景 B：登录限流 =================
{
  const env = makeEnv();
  await setupAndLogin(env);
  let last;
  for (let i = 0; i < 5; i++) {
    last = await req(env, 'POST', '/api/login', { body: { username: 'admin', password: 'wrong-pass' } });
  }
  check('B1 连错 5 次均为 401', last.status === 401, `status=${last.status}`);
  const r = await req(env, 'POST', '/api/login', { body: { username: 'admin', password: 'pass1234' } });
  check('B2 锁定后连正确密码也被拒 429', r.status === 429, `status=${r.status}`);
}

// ================= 场景 C：可用率计算 =================
{
  const env = makeEnv();
  const cookie = await setupAndLogin(env);
  const r0 = await req(env, 'POST', '/api/sites', { cookie, body: { name: '算率站', url: 'https://up.example.com/' } });
  const id = r0.j.data.site.id;
  const now = Date.now();
  const rec = (agoMin, up) => ({ t: now - agoMin * 60000, up, status: up ? 200 : 0, ms: 100, err: up ? '' : 'x' });
  // 24h 内 3 up + 1 down（应 75%），另有 1 条 25 小时前的 up（不应计入）
  await env.DASH_KV.put(`hist:${id}`, JSON.stringify([rec(10, true), rec(40, true), rec(70, false), rec(100, true), rec(25 * 60, true)]));
  const r = await req(env, 'GET', '/api/public');
  check('C1 24h 可用率现算 = 75（窗口外不计）', r.j.data.sites[0].uptime24h === 75, `got=${r.j.data.sites[0].uptime24h}`);
}

// ================= 场景 D：Worker 定时探活 =================
{
  const env = makeEnv();
  const cookie = await setupAndLogin(env);
  net.set('https://down.example.com/', 'down');
  await req(env, 'POST', '/api/sites', { cookie, body: { name: 'W正常', url: 'https://up.example.com/' } });
  const rd = await req(env, 'POST', '/api/sites', { cookie, body: { name: 'W故障', url: 'https://down.example.com/' } });
  const downId = rd.j.data.site.id;

  await worker.scheduled({}, env, { waitUntil() {} });
  const hist = JSON.parse(await env.DASH_KV.get(`hist:${downId}`) || '[]');
  check('D1 Worker scheduled 真落库：故障站 hist 有 down 记录', hist.length >= 1 && hist[0].up === false);
  const meta = JSON.parse(await env.DASH_KV.get('meta') || '{}');
  check('D2 Worker 写回 meta.lastCheckAt', !!meta.lastCheckAt);
  const fr = await worker.fetch(new Request('https://worker.test/'), env, {});
  check('D3 Worker fetch 返回在岗说明', fr.status === 200);
  net.set('https://down.example.com/', 'up');
}

// ================= 场景 E：Worker 侧 SSRF 守卫（存量脏数据直塞 KV） =================
{
  const env = makeEnv();
  await env.DASH_KV.put('sites', JSON.stringify([
    { id: 'evil1', name: '内网地址', url: 'http://[::1]/admin', note: '', createdAt: Date.now() },
    { id: 'evil2', name: '内网IP', url: 'http://192.168.0.1/', note: '', createdAt: Date.now() },
  ]));
  await worker.scheduled({}, env, { waitUntil() {} });
  const h1 = JSON.parse(await env.DASH_KV.get('hist:evil1') || '[]');
  const h2 = JSON.parse(await env.DASH_KV.get('hist:evil2') || '[]');
  check('E1 Worker 对 IPv6 回环只记跳过、不真探', h1.length === 1 && h1[0].up === false && h1[0].err.includes('不安全'), JSON.stringify(h1[0] || {}));
  check('E2 Worker 对内网 IPv4 只记跳过、不真探', h2.length === 1 && h2[0].up === false && h2[0].err.includes('不安全'), JSON.stringify(h2[0] || {}));
}

globalThis.fetch = realFetch;
console.log(`\n冒烟汇总：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
