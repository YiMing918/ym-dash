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
// 严格版：只有「键不存在」才返回 fallback；KV 读取出错或存量 JSON 已损坏
// 时直接抛错。凡是「读完要决定写入」的路径都必须用它（站点增删改、
// 管理员/初始化判定、历史批次落盘）：把一次临时读取失败当成「空数据」，
// 随后的写入就会把整表覆盖掉。纯展示读取继续用上面的宽松版。
export async function kvGetJSONStrict(env, key, fallback) {
  const raw = await env.DASH_KV.get(key);
  if (raw == null) return fallback;
  return JSON.parse(raw);
}
export async function kvPutJSON(env, key, value) {
  await env.DASH_KV.put(key, JSON.stringify(value));
}

export const getSites = (env) => kvGetJSON(env, 'sites', []);
export const getSitesStrict = (env) => kvGetJSONStrict(env, 'sites', []);
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
export async function loadHistBatch(env, opts = {}) {
  // 默认严格读：读失败宁可整轮放弃，也不能拿一份「假空」批次去覆盖
  // 存量历史。纯展示路径（公开数据/详情）传 { safe: true } 降级读取，
  // 它们不写历史，最坏只是页面报错重试，不会丢数据。
  const readJSON = opts.safe ? kvGetJSON : kvGetJSONStrict;
  const all = await readJSON(env, HISTALL_KEY, null);
  const batch = {
    sites: (all && typeof all === 'object' && all.sites) || {},
    legacy: {},
    dirty: false,
    touched: new Set(), // 本批次真正 push 过的站：落盘时只合并这些站
    removed: new Set(), // 本批次删掉的站：落盘时从最新值里移除
    pendingEvents: [], // 本轮状态翻转事件：先攒着，落盘时合并写 1 次
    async get(id) {
      if (batch.sites[id]) return batch.sites[id];
      if (!(id in batch.legacy)) batch.legacy[id] = await kvGetJSON(env, `hist:${id}`, []);
      return batch.legacy[id];
    },
    async push(id, rec) {
      const cur = await batch.get(id);
      batch.sites[id] = [rec, ...cur].slice(0, HIST_CAP);
      batch.touched.add(id);
      batch.dirty = true;
    },
    async flush() {
      if (batch.dirty) {
        // 合并落盘：先读最新 histall，只覆盖本批次动过的站。这样两轮
        // 检测（定时 + 手动）并发时，后落盘的一轮不会抹掉先落盘那轮
        // 其他站的记录；轮次进行中被删的站也不复活（从 sites 现读校验）。
        const latest = await readJSON(env, HISTALL_KEY, null);
        const merged = { v: 1, sites: { ...((latest && latest.sites) || {}) } };
        let validIds = null;
        try { validIds = new Set((await getSites(env)).map(s => s.id)); } catch { /* 读不到就不做删除过滤 */ }
        for (const id of batch.touched) {
          if (validIds && !validIds.has(id)) continue;
          merged.sites[id] = batch.sites[id];
        }
        for (const id of batch.removed) delete merged.sites[id];
        await kvPutJSON(env, HISTALL_KEY, merged);
        batch.dirty = false;
      }
      if (batch.pendingEvents.length) {
        // 事件整轮只写这 1 次：旧实现每个翻转站各写一次 events，
        // KV 对同一键约 1 次/秒的写限制一撞上就抛错、整轮历史陪葬
        const events = await kvGetJSON(env, 'events', []);
        await kvPutJSON(env, 'events', [...batch.pendingEvents, ...events].slice(0, EVENTS_CAP));
        batch.pendingEvents = [];
      }
    },
  };
  return batch;
}
export async function getHist(env, id) {
  const batch = await loadHistBatch(env, { safe: true });
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

  // 状态读用严格版：读失败不能当成「没有旧状态」，否则会凭空造翻转事件
  const prev = await kvGetJSONStrict(env, `state:${site.id}`, null);
  if (!prev || prev.up !== rec.up) {
    await kvPutJSON(env, `state:${site.id}`, { up: rec.up, since: rec.t });
    // 事件不再当场写 KV：攒进批次，flush 时整轮合并写 1 次
    batch.pendingEvents.push({
      t: rec.t, siteId: site.id, name: site.name,
      type: rec.up ? 'up' : 'down',
      detail: rec.up ? (prev ? '已恢复正常' : '首次检测正常') : (rec.err || `HTTP ${rec.status}`),
    });
  }
  if (own) await batch.flush();
  return rec;
}

// 全量探活一遍（顺序执行，站点量级小）。整轮共用一个历史批次：
// 无论多少站，历史与事件都只在收尾各写 1 次（外加 meta 1 次、每站
// 状态翻转时 state:<id> 1 次）。单站检测出错只记一条异常记录，
// 不拖垮整轮；落盘失败也只打日志，meta 照常更新。
export async function runCheckAll(env) {
  let sites, batch;
  try {
    sites = await getSitesStrict(env);
    batch = await loadHistBatch(env);
  } catch (e) {
    console.error('runCheckAll 启动失败（读 KV 出错，本轮跳过）', e);
    return [];
  }
  const results = [];
  for (const site of sites) {
    try {
      results.push({ id: site.id, ...(await checkSite(env, site, batch)) });
    } catch (e) {
      results.push({ id: site.id, t: Date.now(), up: false, status: 0, ms: 0, err: `检测异常：${String((e && e.message) || e).slice(0, 80)}` });
    }
  }
  try { await batch.flush(); } catch (e) { console.error('runCheckAll 落盘失败', e); }
  await kvPutJSON(env, 'meta', { lastCheckAt: Date.now() });
  return results;
}

// 组装公开只读数据：未登录可读，不含任何敏感字段
export async function publicData(env) {
  const [sites, events, meta, settings] = await Promise.all([
    getSites(env), getEvents(env), kvGetJSON(env, 'meta', {}), getSettings(env),
  ]);
  const batch = await loadHistBatch(env, { safe: true });
  const now = Date.now();
  // 历史与状态并行读，别按站串行（站一多公开接口就线性变慢）
  const [hists, states] = await Promise.all([
    Promise.all(sites.map(s => batch.get(s.id))),
    Promise.all(sites.map(s => kvGetJSON(env, `state:${s.id}`, null))),
  ]);
  const out = [];
  let upCount = 0, downCount = 0;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const hist = hists[i];
    const state = states[i];
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

// 清掉一个站的历史（合并键与旧版式键）与状态：删站时调用；
// 站点改网址时也调用——旧网址的历史留给新网址只会算错可用率
export async function clearSiteHistory(env, id) {
  await env.DASH_KV.delete(`hist:${id}`);
  await env.DASH_KV.delete(`state:${id}`);
  const batch = await loadHistBatch(env);
  if (batch.sites[id]) {
    delete batch.sites[id];
    batch.removed.add(id);
    batch.dirty = true;
    await batch.flush();
  }
}
export const deleteSiteData = clearSiteHistory;
