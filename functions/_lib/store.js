// store.js — KV 数据层 + 全量探活落库 + 公开数据组装
// KV 键一览（详见 MAINTENANCE.md）：
//   sites          站点数组 [{id,name,url,note,createdAt}]
//   histall        全部站点的最近 96 条检测（合并存储，见 loadHistBatch）
//   hist:<siteId>  旧版式历史键，只读回退（存量衔接，不再写入）
//   state:<siteId> 当前状态 {up, since}，用于算掉线时长与生成事件
//   events         最近 100 条事件 [{t,siteId,name,type:'down'|'up',detail}]，新在前
//   meta           {lastCheckAt}
//   settings       {title}
//   admin / session:<sha256(token)>  见 auth.js（登录失败计数已改内存，不占 KV）

import { probeUrl, validateUrl, estimateProbeCost, SUBREQUEST_BUDGET } from './probe.js';

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

// ---- sites 整表读改写的指纹复核 + 冲突重试（C-30，照 ym-cf-panel
// mutateAccounts 的模式）----
// 站点增删改旧流程是「严格读 → 改 → 整表写回」：两个写操作并发时，
// 后写者拿着旧列表整表覆盖，先写者的改动就丢了。KV 没有 CAS，这里
// 用内容指纹做写前复核：读时记指纹，写前重读比对，变了就重读、把
// 修改重新应用到新列表上再写（最多 3 轮）。fn(list) 返回 { list, ... }
// 表示新列表，或 { error, status, message } 表示业务错误（不重试）。
// 读失败/JSON 损坏直接抛（与 getSitesStrict 同口径，绝不拿空表覆盖）。
// M7：指纹由 32 位 FNV-1a 换 SHA-256（+长度后缀），消除碰撞一说；
// 本函数改异步后 mutateSites 内的两处调用都已 await。KV 无 CAS 的
// 复核窗口本身堵不住，这里只解决指纹强度。
async function hashOf(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex + ':' + str.length;
}
export async function mutateSites(env, fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const raw = await env.DASH_KV.get('sites');
    const list = raw == null ? [] : JSON.parse(raw);
    const ver = await hashOf(raw || '');
    const r = fn(list);
    if (r && r.error) return r;
    const next = r && r.list ? r.list : list;
    const nowRaw = await env.DASH_KV.get('sites');
    if ((await hashOf(nowRaw || '')) !== ver) continue; // 已被别人改过：重读重试
    await kvPutJSON(env, 'sites', next);
    return { ok: true, ...r, list: next };
  }
  return { error: 'conflict', status: 409, message: '站点列表刚被其他操作修改，请重试' };
}
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
    pendingStates: new Map(), // 本轮状态翻转的新状态：同样先攒着，flush 里与历史/事件一起落盘
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
      // H5：validIds 改严格读并提到最前——旧版用宽松读 getSites，
      // 读失败时返回空数组、validIds 成空 Set（truthy），try/catch
      // 根本不触发，本轮 touched 全被当「已删站」跳过、整轮历史
      // 静默丢失，与注释意图正好相反。现读失败就整轮放弃落盘：
      // 记日志 + 抛错给调用方（runCheckAll 会连带跳过 meta 更新），
      // 旧历史原样留在 KV 里，下一轮重探即可，绝不静默丢。
      let validIds = null;
      if (batch.dirty || batch.pendingEvents.length || batch.pendingStates.size) {
        try {
          validIds = new Set((await getSitesStrict(env)).map(s => s.id));
        } catch (e) {
          console.error('flush 放弃落盘：读取 sites 失败，本轮历史与事件均不写入', e);
          throw e;
        }
      }
      if (batch.dirty) {
        // 合并落盘：先读最新 histall，只覆盖本批次动过的站。这样两轮
        // 检测（定时 + 手动）并发时，后落盘的一轮不会抹掉先落盘那轮
        // 其他站的记录；轮次进行中被删的站也不复活（按 validIds 过滤）。
        const latest = await readJSON(env, HISTALL_KEY, null);
        const merged = { v: 1, sites: { ...((latest && latest.sites) || {}) } };
        for (const id of batch.touched) {
          if (validIds && !validIds.has(id)) continue;
          merged.sites[id] = batch.sites[id];
        }
        for (const id of batch.removed) delete merged.sites[id];
        await kvPutJSON(env, HISTALL_KEY, merged);
        batch.dirty = false;
      }
      if (batch.pendingEvents.length) {
        // L5：待落盘事件同样过 validIds——已删站的翻转事件别写回
        // events（旧版只过滤历史、事件照写，删掉的站还能冒出来）。
        if (validIds) batch.pendingEvents = batch.pendingEvents.filter(e => validIds.has(e.siteId));
      }
      if (batch.pendingEvents.length) {
        // 事件整轮只写这 1 次：旧实现每个翻转站各写一次 events，
        // KV 对同一键约 1 次/秒的写限制一撞上就抛错、整轮历史陪葬。
        // 【C-31 修复】再补写后复核 + 重试合并（照 histall 的写前重读
        // 口径往前一步）：两轮探活（定时 + 手动）并发落盘时，后写的一
        // 轮若拿着旧 events 覆盖，就会把先写那轮的事件整批吞掉。写完
        // 回读核对本轮事件是否都在，不在就重读最新值、把本轮事件重新
        // 合并写回（最多 3 轮，照 ym-cf-panel addAudit 的复核模式）。
        // 合并前的读 events 改严格版（v1.1.7，与 hist 落盘同款）：宽松读
        // 失败会返回空数组，随后的写回就把已有事件整表冲掉；严格读失败
        // 直接抛错、整轮放弃落盘（runCheckAll 不更新 meta），旧事件原样
        // 留在 KV 里，下一轮重探时再合并。
        const pending = batch.pendingEvents;
        // M4：去重不再比时间戳——并发两轮的同一翻转 t 各不相同，比了等于没去重
        const sameEv = (a, b) => a.siteId === b.siteId && a.type === b.type && a.detail === b.detail;
        for (let i = 0; i < 3; i++) {
          const events = await kvGetJSONStrict(env, 'events', []);
          // 防自重：上一轮其实已写进 KV、只是回读拿到旧值时，循环会把
          // pending 再拼一遍（同一事件可重复 2-3 份）。拼前先按
          // (站点,类型,详情,时间) 全同剔掉已在表里的本轮事件——同 t 必是
          // 同一事件的副本；跨轮独立翻转 t 不同，不会误删真实历史
          const fresh = events.filter(e => !pending.some(p => p.siteId === e.siteId && p.type === e.type && p.detail === e.detail && p.t === e.t));
          await kvPutJSON(env, 'events', [...pending, ...fresh].slice(0, EVENTS_CAP));
          const back = await kvGetJSON(env, 'events', []);
          if (pending.every(e => back.some(x => sameEv(x, e)))) break;
        }
        batch.pendingEvents = [];
      }
      if (batch.pendingStates.size) {
        // 状态与历史/事件同生共死：走到这里说明历史与事件都已落盘，
        // 才写 state:<id>（同样过 validIds，轮次中被删的站不写）。旧版
        // 在 checkSite 里当场写 state，flush 中途放弃落盘时就会出现
        // 「状态已翻转、历史与事件却没落盘」的自相矛盾——downSince
        // 显示已掉线，可用率曲线里却没有这条记录。若这里写失败抛错，
        // 调用方按整轮落盘失败处理：prev 仍是旧值，下一轮会重新检出
        // 翻转并重发事件（事件有去重兜底），是自愈方向。
        for (const [id, st] of batch.pendingStates) {
          if (validIds && !validIds.has(id)) continue;
          await kvPutJSON(env, `state:${id}`, st);
        }
        batch.pendingStates.clear();
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
  // M6：未来时间戳记录（时钟漂移/脏数据）差为负、旧写法也被计入
  // 窗口，现明确只算 [now-24h, now] 内的记录
  const win = hist.filter(h => h.t <= now && now - h.t < 24 * 3600 * 1000);
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
    // 状态不当场写 KV：攒进批次，flush 里在历史与事件落盘之后才写，
    // 保证三者同生共死（见 flush 的 pendingStates 段）。
    batch.pendingStates.set(site.id, { up: rec.up, since: rec.t });
    // 事件不再当场写 KV：攒进批次，flush 时整轮合并写 1 次。
    // L4：首次检测且正常不发事件——那不是「恢复」，发了会把事件流
    // 刷满无意义的「首次正常」；首次就是异常照常发 down 事件。
    if (prev || !rec.up) {
      batch.pendingEvents.push({
        t: rec.t, siteId: site.id, name: site.name,
        type: rec.up ? 'up' : 'down',
        detail: rec.up ? '已恢复正常' : (rec.err || `HTTP ${rec.status}`),
      });
    }
  }
  if (own) await batch.flush();
  return rec;
}

// 全量探活一遍（顺序执行，站点量级小）。整轮共用一个历史批次：
// 无论多少站，历史与事件都只在收尾各写 1 次（外加 meta 1 次、每站
// 状态翻转时 state:<id> 1 次）。单站检测出错只记一条异常记录，
// 不拖垮整轮；落盘失败只打日志且不更新 meta（M2）。
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
  let used = 0, skipped = 0;
  for (const site of sites) {
    // H4 轮内兜底（v1.1.7）：加站/改址已按 SUBREQUEST_BUDGET 卡过，
    // 但站表可能在预算口径落地前就已超（或日后口径收紧）——整轮照单
    // 全探会撞平台约 50 次子请求上限，尾部站被掐断、误报异常。按同一
    // 预估在轮内累计：本站装不下就跳过本轮（不查、不写任何记录，状态
    // 与历史保持上次结果），还装得下的后续站照常查，下一轮再继续。
    const cost = estimateProbeCost(site.url);
    if (used + cost > SUBREQUEST_BUDGET) { skipped++; continue; }
    used += cost;
    try {
      results.push({ id: site.id, ...(await checkSite(env, site, batch)) });
    } catch (e) {
      results.push({ id: site.id, t: Date.now(), up: false, status: 0, ms: 0, err: `检测异常：${String((e && e.message) || e).slice(0, 80)}` });
    }
  }
  if (skipped) console.log(`runCheckAll 子请求预算兜底：本轮跳过 ${skipped} 个站（整轮预算 ${SUBREQUEST_BUDGET} 次，已用约 ${used} 次）`);
  // M2：落盘失败就不写 meta.lastCheckAt——旧版无条件写，页面会显示
  // 「刚检测过」但历史其实没落库，误导排查。失败只记日志。
  try {
    await batch.flush();
    await kvPutJSON(env, 'meta', { lastCheckAt: Date.now() });
  } catch (e) { console.error('runCheckAll 落盘失败（本轮不更新 lastCheckAt）', e); }
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
// 删站专用：清历史/状态之外，再把事件流里该站的事件一并清掉——
// 否则删掉的站会继续挂在首页时间线上，直到被 100 条上限自然挤出
// （v1.1.1 及以前的漏清）。改网址走 clearSiteHistory、不清事件：
// 站还在，事件仍是它的历史。事件有变化才写回，删站是低频操作，
// 最多多一次 KV 写，不引入任何定时/高频写。
export async function deleteSiteData(env, id) {
  await clearSiteHistory(env, id);
  const events = await getEvents(env);
  const kept = events.filter(e => e.siteId !== id);
  if (kept.length !== events.length) await kvPutJSON(env, 'events', kept);
}
