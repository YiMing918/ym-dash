// ym-dash-check — 定时探活 Worker（Cron 每 30 分钟）
// 与 Pages 站共用同一个 KV（绑定名同为 DASH_KV），只负责定时全量探活落库，不提供管理功能。
//
// 下面 validateUrl / probeUrl / checkSite 的逻辑与站点侧
// functions/_lib/probe.js、functions/_lib/store.js 是同一套，故意各存一份：
// Worker 独立部署、不能跨目录 import。改任何一处（超时、状态判定、数据结构、
// SSRF 规则），必须同步改另一处。数据键：sites / histall / state:<id> / events / meta
// （hist:<id> 为旧版式历史键，只读回退，不再写入）。

const HIST_CAP = 96;
const EVENTS_CAP = 100;

async function kvGetJSON(env, key, fallback) {
try {
const raw = await env.DASH_KV.get(key);
if (raw == null) return fallback;
return JSON.parse(raw);
} catch { return fallback;}
}
// 严格版（与 store.js 的 kvGetJSONStrict 同步）：只有键不存在才给
// fallback，读出错/JSON 损坏直接抛——决定写入的路径绝不能把读失败当空数据
async function kvGetJSONStrict(env, key, fallback) {
const raw = await env.DASH_KV.get(key);
if (raw == null) return fallback;
return JSON.parse(raw);
}
async function kvPutJSON(env, key, value) {
await env.DASH_KV.put(key, JSON.stringify(value));
}

// === 历史合并存储（与 functions/_lib/store.js 的 loadHistBatch 同步）===
// 全部站点历史合并存一个 histall 键，一轮全量探活只在收尾写 1 次（旧版式
// 每站一个 hist:<id>、一轮写 N 次 ≈ 480 次/天，是写额度的主要消耗）。
// 结构 { v: 1, sites: { <siteId>: [rec] } }，新在前、每站截断 HIST_CAP。
// 合并键里没有的站点回退读旧 hist:<id> 键，存量历史无缝衔接。
const HISTALL_KEY = 'histall';
async function loadHistBatch(env) {
const all = await kvGetJSONStrict(env, HISTALL_KEY, null);
const batch = {
sites: (all && typeof all === 'object' && all.sites) || {},
legacy: {},
dirty: false,
touched: new Set(),
removed: new Set(),
pendingEvents: [],
async get(id) {
if (batch.sites[id]) return batch.sites[id];
if (!(id in batch.legacy)) batch.legacy[id] = await kvGetJSON(env, 'hist:' + id, []);
return batch.legacy[id];
},
async push(id, rec) {
const cur = await batch.get(id);
batch.sites[id] = [rec].concat(cur).slice(0, HIST_CAP);
batch.touched.add(id);
batch.dirty = true;
},
async flush() {
if (batch.dirty) {
// 合并落盘（与 store.js 同步）：只覆盖本轮动过的站，并发轮次互不抹除；
// 轮次中被删的站不复活（按 sites 现读过滤）
const latest = await kvGetJSONStrict(env, HISTALL_KEY, null);
const merged = { v: 1, sites: Object.assign({}, (latest && latest.sites) || {}) };
let validIds = null;
try { validIds = new Set((await kvGetJSON(env, 'sites', [])).map(s => s.id)); } catch { /* 读不到不做删除过滤 */ }
for (const id of batch.touched) {
if (validIds && !validIds.has(id)) continue;
merged.sites[id] = batch.sites[id];
}
for (const id of batch.removed) delete merged.sites[id];
await kvPutJSON(env, HISTALL_KEY, merged);
batch.dirty = false;
}
if (batch.pendingEvents.length) {
// 事件整轮合并写 1 次（旧版每个翻转站各写一次，同键写太密会被 KV 限流打回、整轮陪葬）
const events = await kvGetJSON(env, 'events', []);
await kvPutJSON(env, 'events', batch.pendingEvents.concat(events).slice(0, EVENTS_CAP));
batch.pendingEvents = [];
}
},
};
return batch;
}

// === 与 functions/_lib/probe.js 同步 ===
function validateUrl(raw) {
let u;
try { u = new URL(String(raw || '').trim());}
catch { return { ok: false, error: '网址格式不对'};}
if (u.protocol!== 'http:' && u.protocol!== 'https:') {
return { ok: false, error: '只允许 http/https 网址'};
}
if (u.username || u.password) {
return { ok: false, error: '网址不能带用户名 / 密码'};
}
let host = u.hostname.toLowerCase();
if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 字面量去方括号
host = host.replace(/\.$/, ''); // 尾点规范化，防 localhost. 之类绕过
if (!host) return { ok: false, error: '网址缺少域名'};
if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
return { ok: false, error: '不允许本机 / 内网域名'};
}
const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
if (m) {
const [a, b] = [Number(m[1]), Number(m[2])];
if (a === 0 || a === 10 || a === 127) return { ok: false, error: '不允许内网 / 回环地址'};
if (a === 172 && b >= 16 && b <= 31) return { ok: false, error: '不允许内网地址'};
if (a === 192 && b === 168) return { ok: false, error: '不允许内网地址'};
if (a === 169 && b === 254) return { ok: false, error: '不允许链路本地地址'};
if (a === 100 && b >= 64 && b <= 127) return { ok: false, error: '不允许运营商级 NAT 地址（100.64/10）'};
if (a === 198 && (b === 18 || b === 19)) return { ok: false, error: '不允许基准测试保留地址（198.18/15）'};
if (a >= 224) return { ok: false, error: '不允许保留地址'};
}
if (host.includes(':')) {
if (host === '::1' || host === '::') return { ok: false, error: '不允许回环地址'};
if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return { ok: false, error: '不允许内网 / 链路本地地址'};
if (host.startsWith('::ffff:')) return { ok: false, error: '不允许 IPv4 映射地址'};
}
return { ok: true, url: u.toString()};
}

// 手动跟随重定向（最多 5 跳），每跳重新过 validateUrl，整链共用一个超时
//（与 probe.js 同步：自动 follow 的第二跳起没人校验，能 302 绕进内网）
async function probeUrl(url, timeoutMs = 10000) {
const started = Date.now();
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), timeoutMs);
const done = (up, status, err) => ({ up, status, ms: Date.now() - started, err: err || '' });
try {
let current = url;
for (let hop = 0; hop <= 5; hop++) {
const v = validateUrl(current);
if (!v.ok) return done(false, 0, hop === 0? '地址不安全，已跳过探活': '重定向到不安全地址，已拦截');
const res = await fetch(v.url, {
method: 'GET',
redirect: 'manual',
signal: ctl.signal,
headers: { 'user-agent': 'ym-dash-probe/1.0 (+status check)'},
});
const status = res.status || 0;
try { if (res.body && res.body.cancel) await res.body.cancel();} catch { /* 忽略 */}
if (status >= 300 && status < 400) {
const loc = res.headers.get('location');
if (!loc) return done(true, status);
if (hop === 5) return done(false, status, '重定向次数过多');
try { current = new URL(loc, v.url).toString(); } catch { return done(false, status, '重定向地址无效'); }
continue;
}
return done(status >= 200 && status < 400, status, status >= 400? `HTTP ${status}`: '');
}
return done(false, 0, '重定向次数过多');
} catch (e) {
const err = (e && e.name === 'AbortError')? `超时 ${timeoutMs / 1000}s`: String((e && e.message) || e || '网络错误').slice(0, 120);
return done(false, 0, err);
} finally {
clearTimeout(timer);
}
}

// === 与 functions/_lib/store.js 的 checkSite / runCheckAll 同步 ===
async function checkSite(env, site, batch) {
if (!validateUrl(site.url).ok) {
// 存量站点地址若后来被判定不安全，记一条 down 而不是真去探
var rec = { t: Date.now(), up: false, status: 0, ms: 0, err: '地址不安全，已跳过探活'};
} else {
var rec = await probeUrl(site.url).then(r => ({ t: Date.now(), up: r.up, status: r.status, ms: r.ms, err: r.err || ''}));
}
const own = !batch;
if (own) batch = await loadHistBatch(env);
await batch.push(site.id, rec);

const prev = await kvGetJSONStrict(env, `state:${site.id}`, null);
if (!prev || prev.up!== rec.up) {
await kvPutJSON(env, `state:${site.id}`, { up: rec.up, since: rec.t});
batch.pendingEvents.push({
t: rec.t, siteId: site.id, name: site.name,
type: rec.up? 'up': 'down',
detail: rec.up? (prev? '已恢复正常': '首次检测正常'): (rec.err || `HTTP ${rec.status}`),
});
}
if (own) await batch.flush();
return rec;
}

async function runCheckAll(env) {
let sites, batch;
try {
sites = await kvGetJSONStrict(env, 'sites', []);
batch = await loadHistBatch(env);
} catch (e) {
console.error('runCheckAll 启动失败（读 KV 出错，本轮跳过）', e);
return;
}
for (const site of sites) {
try { await checkSite(env, site, batch); }
catch (e) { console.error('单站检测异常', site && site.id, e); }
}
try { await batch.flush(); } catch (e) { console.error('runCheckAll 落盘失败', e); }
await kvPutJSON(env, 'meta', { lastCheckAt: Date.now()});
}

export default {
// 定时触发：全量探活落库
async scheduled(event, env, ctx) {
const p = runCheckAll(env);
if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
await p;
},
// 直接访问 Worker 地址时给一句人话，方便确认它活着
async fetch() {
return new Response('ym-dash-check 探活 Worker 在岗：每 30 分钟自动检测一遍全部站点。状态请看主站页面。', {
headers: { 'content-type': 'text/plain; charset=utf-8'},
});
},
};

