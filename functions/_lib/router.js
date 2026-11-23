// router.js — API 路由（functions/api/[[path]].js 只做一行转发到这里，方便本地冒烟直调）
import { getSites, getSitesStrict, mutateSites, newId, runCheckAll, checkSite, publicData, siteDetail, deleteSiteData, clearSiteHistory, kvPutJSON, getSettings } from './store.js';
import { validateUrl, estimateProbeCost, SUBREQUEST_BUDGET } from './probe.js';
import { getAdmin, setupAdmin, verifyLogin, createSession, destroySession, getSessionUser, sessionCookie, clearCookie, safeEq, isLocked, noteGuardFail } from './auth.js';

// M9：API 响应统一带基础安全头。CSP 只上 frame-ancestors 一类
// 不拦脚本的策略——前端大量内联 onclick，上 script-src 会弄坏页面。
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders },
  });
}
const ok = (data, headers) => json({ ok: true, data }, 200, headers);
const fail = (status, msg) => json({ ok: false, error: msg }, status);

const MAX_BODY_BYTES = 64 * 1024;
async function bodyJSON(request) {
  try {
    // L8：请求体大小上限——旧版裸 request.json()，超大 body 直进解析
    // 与后续 PBKDF2 等逻辑。先看 Content-Length，再按实际文本兜底。
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) return null;
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    return JSON.parse(text);
  } catch { return null; }
}

async function requireAuth(env, request) {
  return getSessionUser(env, request);
}

function cleanSiteInput(b) {
  const name = String(b?.name || '').trim().slice(0, 60);
  const urlRaw = String(b?.url || '').trim();
  // L7：超长网址直接报错——旧版 slice(0,500) 静默截断，会把一个
  // 网址悄悄改成另一个地址存下来，站长还以为监控的是原地址
  if (urlRaw.length > 500) return { error: '网址过长（上限 500 字）' };
  const note = String(b?.note || '').trim().slice(0, 200);
  if (!name) return { error: '站名不能为空' };
  const v = validateUrl(urlRaw);
  if (!v.ok) return { error: v.error };
  return { name, url: v.url, note };
}

export async function handle({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  try {
    if ((method === 'POST' || method === 'PUT') && Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
      return fail(413, '请求体过大');
    }
    // ---------- 公开只读 ----------
    if (method === 'GET' && path === '/api/public') {
      return ok(await publicData(env));
    }
    if (method === 'GET' && path.startsWith('/api/detail/')) {
      const d = await siteDetail(env, decodeURIComponent(path.slice('/api/detail/'.length)));
      return d ? ok(d) : fail(404, '站点不存在');
    }
    if (method === 'GET' && path === '/api/me') {
      const admin = await getAdmin(env);
      const user = await getSessionUser(env, request);
      return ok({ initialized: !!admin, user: user || null, title: (await getSettings(env)).title });
    }

    // ---------- 初始化（仅未初始化时开放） ----------
    if (method === 'POST' && path === '/api/setup') {
      const b = await bodyJSON(request);
      // L3：初始化入口也接登录同款内存限流（不写 KV）——旧版敞口期
      // 内 SETUP_TOKEN 可无限试错。锁定按来源 IP，与登录共用计数表。
      // 计数键加 setup: 前缀与登录分开：登录被锁不该连带锁死初始化，反之亦然
      const setupIp = 'setup:' + (request.headers.get('cf-connecting-ip') || 'unknown');
      const setupLock = await isLocked(env, setupIp);
      if (setupLock) return fail(429, `尝试次数过多，已锁定到 ${new Date(setupLock).toLocaleString('zh-CN')}`);
      // 部署时若设了环境变量 SETUP_TOKEN，初始化必须带对口令——
      // 防的是「未初始化窗口」被路过的人抢先认领站长
      if (env.SETUP_TOKEN && !safeEq(String(b?.setupToken || ''), String(env.SETUP_TOKEN))) {
        await noteGuardFail(env, setupIp);
        return fail(403, '初始化口令不正确（部署时设置的 SETUP_TOKEN）');
      }
      if (await getAdmin(env)) return fail(403, '已初始化，初始化入口已关闭');
      const username = String(b?.username || '').trim();
      const password = String(b?.password || '');
      if (!username || username.length > 32) return fail(400, '用户名不能为空（≤32 字）');
      if (password.length < 6) return fail(400, '密码至少 6 位');
      if (password.length > 200) return fail(400, '密码过长（上限 200 位）'); // L2：防超长密码拖慢 PBKDF2
      const created = await setupAdmin(env, username, password);
      // 【C-28 低风险版】写后回读比对：初始化是「先查后写」，两个并发
      // 初始化都查到未初始化时，后写会覆盖先写、而先写的人还拿着有效
      // 会话。回读发现 admin 不是自己刚写的那份（ver/用户名对不上）
      // 就报错、不发会话，让输的一方明确知道要重新登录确认。
      // SETUP_TOKEN 的既有校验逻辑不动。
      const checkAdmin = await getAdmin(env);
      if (!checkAdmin || checkAdmin.ver !== created.ver || checkAdmin.username !== created.username) {
        return fail(409, '初始化结果被并发操作覆盖，请刷新页面后按已设置的账号登录确认');
      }
      const token = await createSession(env, username);
      return ok({ user: username }, { 'set-cookie': sessionCookie(token) });
    }

    // ---------- 登录 / 退出 ----------
    if (method === 'POST' && path === '/api/login') {
      if (!(await getAdmin(env))) return fail(403, '尚未初始化，请先设置站长账号');
      const b = await bodyJSON(request);
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (String(b?.password || '').length > 200) return fail(401, '用户名或密码不对'); // L2
      // 用户名先 trim 再验：初始化（/api/setup）存的是 trim 后的用户名，
      // 登录这边旧版没 trim——手机输入法/粘贴带进的首尾空格会让正确
      // 账号也一直 401，看起来像密码错了。与 setup 口径对齐。
      const loginName = String(b?.username || '').trim();
      const r = await verifyLogin(env, loginName, String(b?.password || ''), ip);
      if (!r.ok) {
        if (r.locked) return fail(429, `登录失败次数过多，已锁定到 ${new Date(r.locked).toLocaleString('zh-CN')}`);
        return fail(401, '用户名或密码不对');
      }
      const token = await createSession(env, loginName);
      return ok({ user: loginName }, { 'set-cookie': sessionCookie(token) });
    }
    if (method === 'POST' && path === '/api/logout') {
      await destroySession(env, request);
      return ok({}, { 'set-cookie': clearCookie() });
    }

    // ---------- 以下必须登录 ----------
    const user = await requireAuth(env, request);
    const siteMatch = path.match(/^\/api\/sites\/([^/]+)$/);
    const siteCheckMatch = path.match(/^\/api\/sites\/([^/]+)\/check$/);

    if (path === '/api/sites' || siteMatch || siteCheckMatch || path === '/api/check' || path === '/api/settings') {
      if (!user) return fail(401, '请先登录');
    }

    if (method === 'GET' && path === '/api/sites') {
      return ok({ sites: await getSites(env) });
    }
    if (method === 'POST' && path === '/api/sites') {
      const b = await bodyJSON(request);
      const v = cleanSiteInput(b);
      if (v.error) return fail(400, v.error);
      // C-30：整表写走 mutateSites 指纹复核+重试（内部严格读：读失败
      // 就抛错收手，绝不拿空数组当现状去覆盖；并发改过就重读重应用）
      const site = { id: newId(), ...v, createdAt: Date.now() };
      const r = await mutateSites(env, (list) => {
        // L8：id 撞车就换一个（newId 含随机段，撞车极罕见，但不查
        // 就是把两站并成一站的历史/状态，没法事后分辨）
        while (list.some(x => x.id === site.id)) site.id = newId();
        // H4：子请求预算硬上限——整轮探活的子请求累计超了免费版
        // 约 50 次上限，后面的站会被平台掐断误报异常。按每站预估
        // （域名站 3、IP 站 1）累计卡在 45 留余量，超了明确拒绝。
        const used = list.reduce((sum, x) => sum + estimateProbeCost(x.url), 0);
        const cost = estimateProbeCost(site.url);
        if (used + cost > SUBREQUEST_BUDGET) {
          return { error: 'budget', status: 400, message: `站点太多：一轮探活的子请求预算已不够（已用约 ${used} 次、新站约需 ${cost} 次、上限 ${SUBREQUEST_BUDGET} 次，平台免费上限约 50 次）。请先删掉不用的站再加` };
        }
        return { list: [...list, site] };
      });
      if (r.error) return fail(r.status || 500, r.message || '保存失败，请重试');
      return ok({ site });
    }
    if (method === 'PUT' && siteMatch) {
      const id = decodeURIComponent(siteMatch[1]);
      const b = await bodyJSON(request);
      const v = cleanSiteInput(b);
      if (v.error) return fail(400, v.error);
      let updated = null, urlChanged = false;
      const r = await mutateSites(env, (list) => {
        const site = list.find(s => s.id === id);
        if (!site) return { error: 'notfound', status: 404, message: '站点不存在' };
        urlChanged = v.url !== site.url;
        if (urlChanged) {
          // H4：改址后整轮预算同样不能超（口径同加站）
          const used = list.reduce((sum, x) => sum + estimateProbeCost(x.id === id ? v.url : x.url), 0);
          if (used > SUBREQUEST_BUDGET) return { error: 'budget', status: 400, message: `改完后一轮探活的子请求约需 ${used} 次，超过预算上限 ${SUBREQUEST_BUDGET} 次（平台免费上限约 50 次），请先删掉不用的站` };
        }
        Object.assign(site, v);
        updated = site;
        return { list };
      });
      if (r.error) return fail(r.status || 500, r.message || '保存失败，请重试');
      // 网址变了等于换了一个监控目标：清掉旧网址的历史与状态重新算。
      // M5：清理是后步——它失败不许把已成功的改站打成 500（旧版一
      // 500，站已改、重试时 urlChanged 已为 false，孤儿历史再没入口
      // 清）。吞掉错误记日志，按主操作结果返回。
      if (urlChanged) {
        try { await clearSiteHistory(env, id); }
        catch (e) { console.error('改站后清理旧历史失败（站点已保存）', id, e); }
      }
      return ok({ site: updated });
    }
    if (method === 'DELETE' && siteMatch) {
      const id = decodeURIComponent(siteMatch[1]);
      const r = await mutateSites(env, (list) => {
        const next = list.filter(s => s.id !== id);
        if (next.length === list.length) return { error: 'notfound', status: 404, message: '站点不存在' };
        return { list: next };
      });
      if (r.error) return fail(r.status || 500, r.message || '保存失败，请重试');
      // M5：删站已落盘，后步清数据失败不许打成 500（旧版一 500，
      // 重试只会 404，孤儿历史再没清理入口）。吞掉记日志即可——
      // 残留历史有 flush 的 validIds 过滤兜底，不会复活到页面上。
      try { await deleteSiteData(env, id); }
      catch (e) { console.error('删站后清理数据失败（站点已删除）', id, e); }
      return ok({});
    }
    if (method === 'POST' && siteCheckMatch) {
      const id = decodeURIComponent(siteCheckMatch[1]);
      const site = (await getSitesStrict(env)).find(s => s.id === id);
      if (!site) return fail(404, '站点不存在');
      const rec = await checkSite(env, site);
      return ok({ record: rec });
    }
    if (method === 'POST' && path === '/api/check') {
      const results = await runCheckAll(env);
      return ok({ results, data: await publicData(env) });
    }
    if (method === 'PUT' && path === '/api/settings') {
      const b = await bodyJSON(request);
      const title = String(b?.title || '').trim().slice(0, 40);
      if (!title) return fail(400, '标题不能为空');
      await kvPutJSON(env, 'settings', { title });
      return ok({ title });
    }

    return fail(404, '接口不存在');
  } catch (e) {
    // 内部错误细节只进服务端日志，不回给访客（可能含 KV/运行时内部信息）
    console.error('ym-dash api error', e);
    return fail(500, '服务器内部错误，请稍后重试');
  }
}
