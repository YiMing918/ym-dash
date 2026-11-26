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
pendingStates: new Map(),
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
// H5（与 store.js 同步）：validIds 改严格读，读失败整轮放弃落盘并抛错，绝不静默丢历史
let validIds = null;
if (batch.dirty || batch.pendingEvents.length || batch.pendingStates.size) {
try { validIds = new Set((await kvGetJSONStrict(env, 'sites', [])).map(s => s.id)); }
catch (e) { console.error('flush 放弃落盘：读取 sites 失败，本轮历史与事件均不写入', e); throw e; }
}
if (batch.dirty) {
// 合并落盘（与 store.js 同步）：只覆盖本轮动过的站，并发轮次互不抹除；
// 轮次中被删的站不复活（按 validIds 过滤）
const latest = await kvGetJSONStrict(env, HISTALL_KEY, null);
const merged = { v: 1, sites: Object.assign({}, (latest && latest.sites) || {}) };
for (const id of batch.touched) {
if (validIds && !validIds.has(id)) continue;
merged.sites[id] = batch.sites[id];
}
for (const id of batch.removed) delete merged.sites[id];
await kvPutJSON(env, HISTALL_KEY, merged);
batch.dirty = false;
}
if (batch.pendingEvents.length && validIds) {
// L5（与 store.js 同步）：待落盘事件同样过 validIds，已删站事件不写回
batch.pendingEvents = batch.pendingEvents.filter(e => validIds.has(e.siteId));
}
if (batch.pendingEvents.length) {
// 事件整轮合并写 1 次（旧版每个翻转站各写一次，同键写太密会被 KV 限流打回、整轮陪葬）
// C-31（与 store.js 同步）：写后复核 + 重试合并——并发的另一轮若拿旧
// events 覆盖，本轮事件会被整批吞掉；回读核对不在就重读重合并（≤3 轮）
// v1.1.7（与 store.js 同步）：合并前的读 events 用严格版——宽松读失败
// 返回空数组、写回会把已有事件整表冲掉；严格读失败抛错、整轮放弃落盘
const pending = batch.pendingEvents;
const sameEv = (a, b) => a.siteId === b.siteId && a.type === b.type && a.detail === b.detail; // M4：去重不比时间戳（与 store.js 同步）
for (let i = 0; i < 3; i++) {
const events = await kvGetJSONStrict(env, 'events', []);
const fresh = events.filter(e => !pending.some(p => p.siteId === e.siteId && p.type === e.type && p.detail === e.detail && p.t === e.t)); // 防自重（与 store.js 同步）：回读旧值触发重拼时，剔掉已在表里的本轮事件副本
await kvPutJSON(env, 'events', pending.concat(fresh).slice(0, EVENTS_CAP));
const back = await kvGetJSON(env, 'events', []);
if (pending.every(e => back.some(x => sameEv(x, e)))) break;
}
batch.pendingEvents = [];
}
if (batch.pendingStates.size) {
// 状态与历史/事件同生共死（与 store.js 同步）：历史与事件落盘后才写 state:<id>，
// 同样过 validIds；写失败抛错按整轮落盘失败处理，下一轮重检翻转、自愈
for (const [id, st] of batch.pendingStates) {
if (validIds && !validIds.has(id)) continue;
await kvPutJSON(env, 'state:' + id, st);
}
batch.pendingStates.clear();
}
},
};
return batch;
}

// === 与 functions/_lib/probe.js 同步 ===
// IPv6 完整解析（C-20，自 ym-nav _ssrf.js 搬入，两份副本同步）：
// 补 ::a.b.c.d 兼容形式、文档段、NAT64 / 6to4 内嵌 IPv4 的判断。
function ipv4Blocked(a, b, c, d) {
if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
if (a === 0) return true;
if (a === 10) return true;
if (a === 127) return true;
if (a === 100 && b >= 64 && b <= 127) return true;
if (a === 169 && b === 254) return true;
if (a === 172 && b >= 16 && b <= 31) return true;
if (a === 192 && b === 168) return true;
if (a === 192 && b === 0 && c === 0) return true;
if (a === 192 && b === 0 && c === 2) return true;
if (a === 192 && b === 88 && c === 99) return true;
if (a === 198 && (b === 18 || b === 19)) return true;
if (a === 198 && b === 51 && c === 100) return true;
if (a === 203 && b === 0 && c === 113) return true;
if (a >= 224 && a < 240) return true;
if (a >= 240) return true;
return false;
}
function ipv6Blocked(host) {
let h = String(host || '').toLowerCase();
if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
const zone = h.indexOf('%');
if (zone >= 0) h = h.slice(0, zone);
const lastColon = h.lastIndexOf(':');
if (lastColon >= 0 && h.slice(lastColon + 1).includes('.')) {
const p = h.slice(lastColon + 1).split('.').map(Number);
if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
h = h.slice(0, lastColon + 1) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
}
const halves = h.split('::');
if (halves.length > 2) return true;
const parseSide = (s) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
const left = parseSide(halves[0]);
const right = halves.length === 2 ? parseSide(halves[1]) : [];
if (left.some(Number.isNaN) || right.some(Number.isNaN)) return true;
let g;
if (halves.length === 2) {
const missing = 8 - left.length - right.length;
if (missing < 0) return true;
g = [...left, ...Array(missing).fill(0), ...right];
} else {
if (left.length !== 8) return true;
g = left;
}
const embeddedV4 = (hi, lo) => ipv4Blocked((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255);
if (g.every((x) => x === 0)) return true;
if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embeddedV4(g[6], g[7]);
if (g.slice(0, 6).every((x) => x === 0) && !(g[6] === 0 && g[7] <= 1)) return embeddedV4(g[6], g[7]);
if ((g[0] & 0xffc0) === 0xfe80) return true;
if ((g[0] & 0xfe00) === 0xfc00) return true;
if ((g[0] & 0xff00) === 0xff00) return true;
if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
if (g[0] === 0x0064 && g[1] === 0xff9b) return embeddedV4(g[6], g[7]);
if (g[0] === 0x2002) return embeddedV4(g[1], g[2]);
return false;
}
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
// 与 probe.js 同步：IPv4 字面量直接复用 ipv4Blocked（含文档/保留段）
if (ipv4Blocked(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]))) return { ok: false, error: '不允许内网 / 回环 / 保留地址'};
}
if (host.includes(':')) {
if (ipv6Blocked(host)) return { ok: false, error: '不允许内网 / 回环 / 保留地址'};
}
return { ok: true, url: u.toString()};
}

// 解析后校验（与 probe.js 同步，2026-11-17 审计核验 #11）：域名可解析到
// 内网地址绕过字符串校验；每跳请求前经 DoH 解析 A/AAAA，命中内网/保留/
// 文档示例段即拒绝。DoH 故障 fail-closed：不发请求、记「解析不确定」（与 probe.js 同步）。
function ipBlocked(ip) {
const s = String(ip || '').toLowerCase();
const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
if (m) return ipv4Blocked(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
if (s.includes(':')) return ipv6Blocked(s);
return false;
}
// 与 probe.js 同步：A/AAAA 并行、跟 CNAME、DoH 失败 fail-closed 返回 {blocked,uncertain}
async function dnsBlocked(host, signal) {
try {
const q = async (name, type) => {
const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=' + type, { headers: { accept: 'application/dns-json' }, signal });
if (!r.ok) throw new Error('doh http ' + r.status);
const j = await r.json();
return j.Answer || [];
};
let name = String(host || '').toLowerCase();
const seen = new Set();
for (let depth = 0; depth < 4; depth++) {
if (seen.has(name)) throw new Error('cname loop');
seen.add(name);
const pair = await Promise.all([q(name, 'A'), q(name, 'AAAA')]);
const answers = pair[0].concat(pair[1]);
const ips = answers.filter(a => a.type === 1 || a.type === 28).map(a => a.data);
if (ips.length) return { blocked: ips.some(ip => ipBlocked(ip)), uncertain: false };
const cname = answers.find(a => a.type === 5 && a.data);
if (!cname) return { blocked: false, uncertain: false };
name = String(cname.data).replace(/\.$/, '').toLowerCase();
}
throw new Error('cname too deep');
} catch { return { blocked: true, uncertain: true }; }
}

// 子请求预算估算（与 probe.js 同步，H4）：一轮探活里单个站大约烧多少
// 次子请求——域名站 = DoH A + AAAA 两次解析 + 目标请求 1 次 = 3，
// IP 字面量站不查 DoH = 1。整轮预算卡 45（平台免费上限约 50，留余量）。
const SUBREQUEST_BUDGET = 45;
function estimateProbeCost(url) {
try {
const h = new URL(String(url || '')).hostname.replace(/^\[|\]$/g, '').toLowerCase();
if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return 1;
return 3;
} catch { return 3; }
}

// 手动跟随重定向（最多 5 跳），每跳重新过 validateUrl，整链共用一个超时
//（与 probe.js 同步：自动 follow 的第二跳起没人校验，能 302 绕进内网）
// 死活口径与 probe.js 同步（2026-11-19 拍板）：收到任何 HTTP 响应都算活着
//（4xx 含 401/403/429 记 up、状态码照实记），只有连不上/超时与 5xx 记 down。
async function probeUrl(url, timeoutMs = 10000) {
const started = Date.now();
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), timeoutMs);
const done = (up, status, err) => ({ up, status, ms: Date.now() - started, err: err || '' });
try {
let current = url;
const visited = new Set();
for (let hop = 0; hop < 5; hop++) {
if (visited.has(current)) return done(false, 0, '重定向成环，已拦截');
visited.add(current);
const v = validateUrl(current);
if (!v.ok) return done(false, 0, hop === 0? '地址不安全，已跳过探活': '重定向到不安全地址，已拦截');
const hopHost = new URL(v.url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hopHost) && !hopHost.includes(':')) {
const dns = await dnsBlocked(hopHost, ctl.signal);
if (dns.uncertain) return done(false, 0, '域名解析不确定（解析服务查询失败），本轮已跳过探活');
if (dns.blocked) return done(false, 0, '域名解析到内网 / 保留地址，已拦截');
}
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
if (hop === 4) return done(false, status, '重定向次数过多');
try { current = new URL(loc, v.url).toString(); } catch { return done(false, status, '重定向地址无效'); }
continue;
}
if (status >= 500) return done(false, status, `HTTP ${status}`);
return done(true, status);
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
batch.pendingStates.set(site.id, { up: rec.up, since: rec.t }); // 状态攒进批次，flush 时与历史/事件一起落盘（与 store.js 同步）
// L4（与 store.js 同步）：首次检测且正常不发事件；首次异常照常发 down
if (prev || !rec.up) {
batch.pendingEvents.push({
t: rec.t, siteId: site.id, name: site.name,
type: rec.up? 'up': 'down',
detail: rec.up? '已恢复正常': (rec.err || `HTTP ${rec.status}`),
});
}
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
let used = 0, skipped = 0;
for (const site of sites) {
// H4 轮内兜底（与 store.js 同步，v1.1.7）：站表若在预算口径落地前就
// 已超预算，整轮全探会撞平台约 50 次子请求上限、尾部站被掐断误报。
// 按预估累计，本站装不下就跳过本轮（不查、不写记录，状态与历史保持
// 上次结果），还装得下的后续站照常查，下一轮再继续。
const cost = estimateProbeCost(site.url);
if (used + cost > SUBREQUEST_BUDGET) { skipped++; continue; }
used += cost;
try { await checkSite(env, site, batch); }
catch (e) { console.error('单站检测异常', site && site.id, e); }
}
if (skipped) console.log('runCheckAll 子请求预算兜底：本轮跳过 ' + skipped + ' 个站（整轮预算 ' + SUBREQUEST_BUDGET + ' 次，已用约 ' + used + ' 次）');
// M2（与 store.js 同步）：落盘失败不写 meta.lastCheckAt
try { await batch.flush(); await kvPutJSON(env, 'meta', { lastCheckAt: Date.now()}); } catch (e) { console.error('runCheckAll 落盘失败（本轮不更新 lastCheckAt）', e); }
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

