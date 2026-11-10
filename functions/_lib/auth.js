// auth.js — 站长初始化 / 登录 / 会话 / 登录限流
// 模式照 ym 系列：未初始化时任何人可走 /api/setup 初始化（敞口只在未初始化时存在），
// 初始化后 setup 关闭；密码只存加盐哈希；会话 Cookie 7 天；登录连错 5 次锁 15 分钟。
// KV 键：admin {username,salt,hash,createdAt}、session:<token> {username,exp}、login_guard {fails,lockUntil}

import { kvGetJSON, kvPutJSON } from './store.js';

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return hex(a.buffer);
}
export async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  return hex(await crypto.subtle.digest('SHA-256', data));
}
// 定长比较，避免计时侧信道（长度不同直接 false）
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const getAdmin = (env) => kvGetJSON(env, 'admin', null);

export async function setupAdmin(env, username, password) {
  const salt = randHex(16);
  const admin = { username, salt, hash: await hashPassword(password, salt), createdAt: Date.now() };
  await kvPutJSON(env, 'admin', admin);
  return admin;
}

export async function isLocked(env) {
  const g = await kvGetJSON(env, 'login_guard', { fails: 0, lockUntil: 0 });
  return g.lockUntil && g.lockUntil > Date.now() ? g.lockUntil : 0;
}
async function noteFail(env) {
  const g = await kvGetJSON(env, 'login_guard', { fails: 0, lockUntil: 0 });
  g.fails = (g.fails || 0) + 1;
  if (g.fails >= MAX_FAILS) { g.lockUntil = Date.now() + LOCK_MS; g.fails = 0; }
  await kvPutJSON(env, 'login_guard', g);
}
async function clearFails(env) {
  await kvPutJSON(env, 'login_guard', { fails: 0, lockUntil: 0 });
}

// 校验账号密码。返回 {ok} 或 {ok:false, locked:<ms epoch>} 或 {ok:false}
export async function verifyLogin(env, username, password) {
  const lockUntil = await isLocked(env);
  if (lockUntil) return { ok: false, locked: lockUntil };
  const admin = await getAdmin(env);
  if (!admin) return { ok: false };
  const hash = await hashPassword(password, admin.salt);
  const ok = username === admin.username && safeEq(hash, admin.hash);
  if (ok) { await clearFails(env); return { ok: true }; }
  await noteFail(env); // 第 5 次失败当次仍按普通失败返回，锁定从下一次尝试起生效（入口处判定）
  return { ok: false };
}

export async function createSession(env, username) {
  const token = randHex(32);
  await env.DASH_KV.put(`session:${token}`, JSON.stringify({ username, exp: Date.now() + SESSION_TTL_MS }));
  return token;
}
export function sessionCookie(token) {
  return `dash_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}
export function clearCookie() {
  return 'dash_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
function tokenFromRequest(request) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)dash_session=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
export async function getSessionUser(env, request) {
  const token = tokenFromRequest(request);
  if (!token) return null;
  const raw = await env.DASH_KV.get(`session:${token}`);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s.exp || s.exp < Date.now()) { await env.DASH_KV.delete(`session:${token}`); return null; }
    return s.username;
  } catch { return null; }
}
export async function destroySession(env, request) {
  const token = tokenFromRequest(request);
  if (token) await env.DASH_KV.delete(`session:${token}`);
}
