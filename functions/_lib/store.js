// store.js — KV 数据层 + 全量探活落库 + 公开数据组装
// KV 键一览（详见 MAINTENANCE.md）：
//   sites          站点数组 [{id,name,url,note,createdAt}]
//   hist:<siteId>  最近 96 条检测 [{t,up,status,ms,err}]，新在前
//   state:<siteId> 当前状态 {up, since}，用于算掉线时长与生成事件
//   events         最近 100 条事件 [{t,siteId,name,type:'down'|'up',detail}]，新在前
//   meta           {lastCheckAt}
//   settings       {title}
//   admin / session:<token> / login_guard  见 auth.js

import { probeUrl } from './probe.js';

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
export const getHist = (env, id) => kvGetJSON(env, `hist:${id}`, []);
export const getEvents = (env) => kvGetJSON(env, 'events', []);
export const getSettings = async (env) => Object.assign({ title: '站点总览' }, await kvGetJSON(env, 'settings', {}));

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
export async function checkSite(env, site) {
  const r = await probeUrl(site.url);
  const rec = { t: Date.now(), up: r.up, status: r.status, ms: r.ms, err: r.err || '' };

  const hist = await getHist(env, site.id);
  hist.unshift(rec);
  if (hist.length > HIST_CAP) hist.length = HIST_CAP;
  await kvPutJSON(env, `hist:${site.id}`, hist);

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

// 全量探活一遍（顺序执行，站点量级小；避免并发把 KV 写爆）
export async function runCheckAll(env) {
  const sites = await getSites(env);
  const results = [];
  for (const site of sites) results.push({ id: site.id, ...(await checkSite(env, site)) });
  await kvPutJSON(env, 'meta', { lastCheckAt: Date.now() });
  return results;
}

// 组装公开只读数据：未登录可读，不含任何敏感字段
export async function publicData(env) {
  const [sites, events, meta, settings] = await Promise.all([
    getSites(env), getEvents(env), kvGetJSON(env, 'meta', {}), getSettings(env),
  ]);
  const now = Date.now();
  const out = [];
  let upCount = 0, downCount = 0;
  for (const s of sites) {
    const hist = await getHist(env, s.id);
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

// 删除站点时连带清掉它的历史与状态
export async function deleteSiteData(env, id) {
  await env.DASH_KV.delete(`hist:${id}`);
  await env.DASH_KV.delete(`state:${id}`);
}
