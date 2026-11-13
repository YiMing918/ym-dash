// router.js — API 路由（functions/api/[[path]].js 只做一行转发到这里，方便本地冒烟直调）
import { getSites, getSitesStrict, saveSites, newId, runCheckAll, checkSite, publicData, siteDetail, deleteSiteData, clearSiteHistory, kvPutJSON, getSettings } from './store.js';
import { validateUrl } from './probe.js';
import { getAdmin, setupAdmin, verifyLogin, createSession, destroySession, getSessionUser, sessionCookie, clearCookie, safeEq } from './auth.js';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}
const ok = (data, headers) => json({ ok: true, data }, 200, headers);
const fail = (status, msg) => json({ ok: false, error: msg }, status);

async function bodyJSON(request) {
  try { return await request.json(); } catch { return null; }
}

async function requireAuth(env, request) {
  return getSessionUser(env, request);
}

function cleanSiteInput(b) {
  const name = String(b?.name || '').trim().slice(0, 60);
  const urlRaw = String(b?.url || '').trim().slice(0, 500);
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
      // 部署时若设了环境变量 SETUP_TOKEN，初始化必须带对口令——
      // 防的是「未初始化窗口」被路过的人抢先认领站长
      if (env.SETUP_TOKEN && !safeEq(String(b?.setupToken || ''), String(env.SETUP_TOKEN))) {
        return fail(403, '初始化口令不正确（部署时设置的 SETUP_TOKEN）');
      }
      if (await getAdmin(env)) return fail(403, '已初始化，初始化入口已关闭');
      const username = String(b?.username || '').trim();
      const password = String(b?.password || '');
      if (!username || username.length > 32) return fail(400, '用户名不能为空（≤32 字）');
      if (password.length < 6) return fail(400, '密码至少 6 位');
      await setupAdmin(env, username, password);
      const token = await createSession(env, username);
      return ok({ user: username }, { 'set-cookie': sessionCookie(token) });
    }

    // ---------- 登录 / 退出 ----------
    if (method === 'POST' && path === '/api/login') {
      if (!(await getAdmin(env))) return fail(403, '尚未初始化，请先设置站长账号');
      const b = await bodyJSON(request);
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const r = await verifyLogin(env, String(b?.username || ''), String(b?.password || ''), ip);
      if (!r.ok) {
        if (r.locked) return fail(429, `登录失败次数过多，已锁定到 ${new Date(r.locked).toLocaleString('zh-CN')}`);
        return fail(401, '用户名或密码不对');
      }
      const token = await createSession(env, String(b.username));
      return ok({ user: String(b.username) }, { 'set-cookie': sessionCookie(token) });
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
      // 写路径一律严格读：读失败就报错收手，绝不能拿空数组当现状去覆盖
      const sites = await getSitesStrict(env);
      const site = { id: newId(), ...v, createdAt: Date.now() };
      sites.push(site);
      await saveSites(env, sites);
      return ok({ site });
    }
    if (method === 'PUT' && siteMatch) {
      const id = decodeURIComponent(siteMatch[1]);
      const b = await bodyJSON(request);
      const v = cleanSiteInput(b);
      if (v.error) return fail(400, v.error);
      const sites = await getSitesStrict(env);
      const site = sites.find(s => s.id === id);
      if (!site) return fail(404, '站点不存在');
      const urlChanged = v.url !== site.url;
      Object.assign(site, v);
      await saveSites(env, sites);
      // 网址变了等于换了一个监控目标：清掉旧网址的历史与状态重新算
      if (urlChanged) await clearSiteHistory(env, id);
      return ok({ site });
    }
    if (method === 'DELETE' && siteMatch) {
      const id = decodeURIComponent(siteMatch[1]);
      const sites = await getSitesStrict(env);
      const next = sites.filter(s => s.id !== id);
      if (next.length === sites.length) return fail(404, '站点不存在');
      await saveSites(env, next);
      await deleteSiteData(env, id);
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
