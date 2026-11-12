// store.js — KV 数据层 + 全量探活落库 + 公开数据组装
// KV 键一览（详见 MAINTENANCE.md）：
//   sites          站点数组 [{id,name,url,note,createdAt}]
//   histall        全部站点的最近 96 条检测（合并存储，见 loadHistBatch）
//   hist:<siteId>  旧版式历史键，只读回退（存量衔接，不再写入）
//   state:<siteId> 当前状态 {up, since}，用于算掉线时长与生成事件
//   events         最近 100 条事件 [{t,siteId,name,type:'down'|'up',detail}]，新在前
//   meta           {lastCheckAt}
//   settings       {title}
//   admin / session:<token> / login_guard  见 auth.js

import { probeUrl, validateUrl } from './probe.js';

export const HIST_CAP = 96;
export const EVENTS_CAP = 100;

export async function kvGetJSON(env, key, fallback) {
  try {
    const raw = await env.DASH_KV.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
export async function kvPutJSON(env, key, value) {
  await env.DASH_KV.put(key, JSON.stringify(value));
}

export const getSites = (env) => kvGetJSON(env, 'sites', []);
export const saveSites = (env, sites) => kvPutJSON(env, 'sites', sites);
export const getEvents = (env) => kvGetJSON(env, 'events', []);
export const getSettings = async (env) => Object.assign({ title: '站点总览' }, await kvGetJSON(env, 'settings', {}));

// ---- 历史合并存储（histall）----
// 旧版式每站一个 hist:<id> 键：全量探活一轮要写 N 次（N = 站数），9 站 ×
// 每 30 分钟一轮 ≈ 480 次/天，是 KV 免费写额度（1,000/天）的主要消耗。
// 改后全部站点的历史合并存一个 histall 键：一轮探活先在内存里攒，收尾
// 只写 1 次。结构 { v: 1, sites: { <siteId>: [{t,up,status,ms,err}] } }，
// 新在前、每站截断 HIST_CAP，与旧版式逐条一致，页面与可用率算法无感。
// 读合并键里没有的站点时回退读旧 hist:<id> 键：存量历史无缝衔接；旧键
// 不再写入，某站一被探活，它的历史（含回退读到的旧记录）即并入 histall。
const HISTALL_KEY = 'histall';
export async function loadHistBatch(env) {
  const all = await kvGetJSON(env, HISTALL_KEY, null);
  const batch = {
    sites: (all && typeof all === 'object' && all.sites) || {},
    legacy: {},
    dirty: false,
    async get(id) {
      if (batch.sites[id]) return batch.sites[id];
      if (!(id in batch.legacy)) batch.legacy[id] = await kvGetJSON(env, `hist:${id}`, []);
      return batch.legacy[id];
    },
    async push(id, rec) {
      const cur = await batch.get(id);
      batch.sites[id] = [rec, ...cur].slice(0, HIST_CAP);
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
export async function getHist(env, id) {
  const batch = await loadHistBatch(env);
  return batch.get(id);
}

export function newId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 24 小时可用率：窗口内 up 条数 / 总条数 * 100；无记录返回 null
export function uptime24h(hist, now = Date.now()) {
  const win = hist.filter(h => now - h.t < 24 * 3600 * 1000);
  if (!win.length) return null;
  const up = win.filter(h => h.up).length;
  return Math.round((up / win.length) * 1000) / 10;
}

// 探活单个站点并落库（历史 + 状态 + 事件）。返回本次记录。
// batch 由 runCheckAll 传入时全轮共用、收尾统一写 histall；单站调用
// （管理页「检测」按钮）不传 batch，自己加载并立即落盘（仍是 1 次写）。
export async function checkSite(env, site, batch) {
  // 与 worker/worker.js 的 checkSite 同步：先过地址安全校验，不合规记 down、不真去探
  let rec;
  if (!validateUrl(site.url).ok) {
    rec = { t: Date.now(), up: false, status: 0, ms: 0, err: '地址不安全，已跳过探活' };
  } else {
    const r = await probeUrl(site.url);
    rec = { t: Date.now(), up: r.up, status: r.status, ms: r.ms, err: r.err || '' };
  }

  const own = !batch;
  if (own) batch = await loadHistBatch(env);
  await batch.push(site.id, rec);
  if (own) await batch.flush();

  const prev = await kvGetJSON(env, `state:${site.id}`, null);
  if (!prev || prev.up !== rec.up) {
    await kvPutJSON(env, `state:${site.id}`, { up: rec.up, since: rec.t });
    const events = await getEvents(env);
    events.unshift({
      t: rec.t, siteId: site.id, name: site.name,
      type: rec.up ? 'up' : 'down',
      detail: rec.up ? (prev ? '已恢复正常' : '首次检测正常') : (rec.err || `HTTP ${rec.status}`),
    });
    if (events.length > EVENTS_CAP) events.length = EVENTS_CAP;
    await kvPutJSON(env, 'events', events);
  }
  return rec;
}

// 全量探活一遍（顺序执行，站点量级小）。整轮共用一个历史批次：
// 无论多少站，历史只在收尾写 1 次（外加 meta 1 次，状态翻转另计）。
export async function runCheckAll(env) {
  const sites = await getSites(env);
  const batch = await loadHistBatch(env);
  const results = [];
  for (const site of sites) results.push({ id: site.id, ...(await checkSite(env, site, batch)) });
  await batch.flush();
  await kvPutJSON(env, 'meta', { lastCheckAt: Date.now() });
  return results;
}

// 组装公开只读数据：未登录可读，不含任何敏感字段
export async function publicData(env) {
  const [sites, events, meta, settings] = await Promise.all([
    getSites(env), getEvents(env), kvGetJSON(env, 'meta', {}), getSettings(env),
  ]);
  const batch = await loadHistBatch(env);
  const now = Date.now();
  const out = [];
  let upCount = 0, downCount = 0;
  for (const s of sites) {
    const hist = await batch.get(s.id);
    const state = await kvGetJSON(env, `state:${s.id}`, null);
    const last = hist[0] || null;
    if (last) { if (last.up) upCount++; else downCount++; }
    out.push({
      id: s.id, name: s.name, url: s.url, note: s.note || '',
      last, uptime24h: uptime24h(hist, now),
      trend: hist.slice(0, 12).map(h => ({ t: h.t, up: h.up, ms: h.ms })),
      downSince: state && !state.up ? state.since : null,
    });
  }
  const admin = await env.DASH_KV.get('admin');
  return {
    initialized: !!admin,
    title: settings.title || '站点总览',
    checkedAt: meta.lastCheckAt || null,
    counts: { total: sites.length, up: upCount, down: downCount },
    sites: out,
    events: events.slice(0, 30),
  };
}

// 单站详情：完整历史 + 该站事件
export async function siteDetail(env, id) {
  const sites = await getSites(env);
  const site = sites.find(s => s.id === id);
  if (!site) return null;
  const [hist, events] = await Promise.all([getHist(env, id), getEvents(env)]);
  return {
    site: { id: site.id, name: site.name, url: site.url, note: site.note || '' },
    uptime24h: uptime24h(hist),
    hist,
    events: events.filter(e => e.siteId === id).slice(0, 50),
  };
}

// 删除站点时连带清掉它的历史（合并键与旧版式键）与状态
export async function deleteSiteData(env, id) {
  await env.DASH_KV.delete(`hist:${id}`);
  await env.DASH_KV.delete(`state:${id}`);
  const batch = await loadHistBatch(env);
  if (batch.sites[id]) {
    delete batch.sites[id];
    batch.dirty = true;
    await batch.flush();
  }
}
