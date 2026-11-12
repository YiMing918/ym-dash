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
const all = await kvGetJSON(env, HISTALL_KEY, null);
const batch = {
sites: (all && typeof all === 'object' && all.sites) || {},
legacy: {},
dirty: false,
async get(id) {
if (batch.sites[id]) return batch.sites[id];
if (!(id in batch.legacy)) batch.legacy[id] = await kvGetJSON(env, 'hist:' + id, []);
return batch.legacy[id];
},
async push(id, rec) {
const cur = await batch.get(id);
batch.sites[id] = [rec].concat(cur).slice(0, HIST_CAP);
batch.dirty = true;
},
async flush() {
if (!batch.dirty) return;
await kvPutJSON(env, HISTALL_KEY, { v: 1, sites: batch.sites });
batch.dirty = false;
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
let host = u.hostname.toLowerCase();
if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 字面量去方括号
if (!host) return { ok: false, error: '网址缺少域名'};
if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
return { ok: false, error: '不允许本机 / 内网域名'};
}
const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
if (m) {
const [a, b] = [Number(m[1]), Number(m[2])];
if (a === 0 || a === 10 || a === 127) return { ok: false, error: '不允许内网 / 回环地址'};
if (a === 172 && b >= 16 && b <= 31) return { ok: false, error: '不允许内网地址'};
if (a === 192 && b === 168) return { ok: false, error: '不允许内网地址'};
if (a === 169 && b === 254) return { ok: false, error: '不允许链路本地地址'};
if (a >= 224) return { ok: false, error: '不允许保留地址'};
}
if (host.includes(':')) {
if (host === '::1' || host === '::') return { ok: false, error: '不允许回环地址'};
if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return { ok: false, error: '不允许内网 / 链路本地地址'};
if (host.startsWith('::ffff:')) return { ok: false, error: '不允许 IPv4 映射地址'};
}
return { ok: true, url: u.toString()};
}

async function probeUrl(url, timeoutMs = 10000) {
const started = Date.now();
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), timeoutMs);
try {
const res = await fetch(url, {
method: 'GET',
redirect: 'follow',
signal: ctl.signal,
headers: { 'user-agent': 'ym-dash-probe/1.0 (+status check)'},
});
const ms = Date.now() - started;
try { if (res.body && res.body.cancel) await res.body.cancel();} catch { /* 忽略 */}
const status = res.status || 0;
return { up: status >= 200 && status < 400, status, ms, err: status >= 400? `HTTP ${status}`: ''};
} catch (e) {
const ms = Date.now() - started;
const err = (e && e.name === 'AbortError')? `超时 ${timeoutMs / 1000}s`: String((e && e.message) || e || '网络错误').slice(0, 120);
return { up: false, status: 0, ms, err};
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
if (own) await batch.flush();

const prev = await kvGetJSON(env, `state:${site.id}`, null);
if (!prev || prev.up!== rec.up) {
await kvPutJSON(env, `state:${site.id}`, { up: rec.up, since: rec.t});
const events = await kvGetJSON(env, 'events', []);
events.unshift({
t: rec.t, siteId: site.id, name: site.name,
type: rec.up? 'up': 'down',
detail: rec.up? (prev? '已恢复正常': '首次检测正常'): (rec.err || `HTTP ${rec.status}`),
});
if (events.length > EVENTS_CAP) events.length = EVENTS_CAP;
await kvPutJSON(env, 'events', events);
}
return rec;
}

async function runCheckAll(env) {
const sites = await kvGetJSON(env, 'sites', []);
const batch = await loadHistBatch(env);
for (const site of sites) await checkSite(env, site, batch);
await batch.flush();
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

