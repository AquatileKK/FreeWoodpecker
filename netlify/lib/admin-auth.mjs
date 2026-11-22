// 管理员身份验证。
//
// 设计：
//   1. 登录交给 Supabase Auth（密码由 Supabase 安全保管，我们的代码和数据库里都没有密码）。
//   2. 登录成功后，令牌放进 HttpOnly Cookie：网页里的 JavaScript 读不到它，即使页面被注入恶意代码也偷不走。
//   3. 每次访问后台接口，都要向 Supabase 确认令牌有效，并且邮箱必须在 ADMIN_EMAILS 白名单里。
//   4. 任何一项没配置好，一律拒绝（宁可用不了，也不放行）。

import { getConfig } from "./supabase.mjs";

export const AT_COOKIE = "jx_at"; // 访问令牌，约 1 小时有效
export const RT_COOKIE = "jx_rt"; // 刷新令牌，用来无感续期

// ---------- 配置 ----------
function looksLikeSecretKey(k) {
  if (k.startsWith("sb_secret_")) return true;
  const parts = k.split(".");
  if (parts.length === 3) {
    try {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role === "service_role";
    } catch {
      return false;
    }
  }
  return false;
}

export function parseAdminEmails(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// 返回 null 表示后台没配置好（调用方必须拒绝所有请求）
export function getAdminConfig(env = process.env) {
  const base = getConfig(env);
  const anon = env.SUPABASE_ANON_KEY || "";
  const emails = parseAdminEmails(env.ADMIN_EMAILS);
  if (!base || !anon || emails.length === 0) return null;
  // 防呆：这里只应该放“公开密钥”，如果误填成管理员密钥，宁可拒绝启动
  if (looksLikeSecretKey(anon)) return null;
  return { ...base, anon, emails };
}

export const isAllowedAdmin = (cfg, email) => cfg.emails.includes(String(email || "").toLowerCase());

// ---------- 调用 Supabase Auth ----------
export function createAuthClient(cfg) {
  async function call(path, init) {
    const res = await fetch(`${cfg.url}/auth/v1/${path}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  }
  const jsonHeaders = { apikey: cfg.anon, "Content-Type": "application/json" };
  const bearer = (token) => ({ apikey: cfg.anon, Authorization: `Bearer ${token}` });

  return {
    signIn: (email, password) =>
      call("token?grant_type=password", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ email, password }) }),
    refresh: (refreshToken) =>
      call("token?grant_type=refresh_token", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ refresh_token: refreshToken }) }),
    // 向 Supabase 确认令牌的真伪、是否过期、是否已被撤销
    getUser: (accessToken) => call("user", { headers: bearer(accessToken) }),
    signOut: (accessToken) => call("logout?scope=local", { method: "POST", headers: bearer(accessToken) }),
  };
}

// ---------- Cookie ----------
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function isSecureRequest(req) {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

function buildCookie(name, value, { maxAge, secure }) {
  return `${name}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function sessionCookies(session, secure) {
  const at = Math.min(Math.max(Number(session.expires_in) || 3600, 60), 24 * 3600);
  return [
    buildCookie(AT_COOKIE, session.access_token, { maxAge: at, secure }),
    buildCookie(RT_COOKIE, session.refresh_token, { maxAge: 7 * 24 * 3600, secure }),
  ];
}

export function clearedCookies(secure) {
  return [AT_COOKIE, RT_COOKIE].map((n) => buildCookie(n, "", { maxAge: 0, secure }));
}

// ---------- 防跨站请求 ----------
// 浏览器发起的 POST 一定带 Origin；来源必须是本站，否则拒绝。
export function sameOriginOk(req) {
  const origin = req.headers.get("origin");
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    const allowed = new Set(
      [new URL(req.url).host, req.headers.get("host"), req.headers.get("x-forwarded-host")].filter(Boolean)
    );
    return allowed.has(host);
  }
  return req.headers.get("sec-fetch-site") !== "cross-site";
}

// ---------- 校验当前请求是不是管理员 ----------
const TOKEN_RE = /^[A-Za-z0-9._-]{20,4096}$/;

export async function authenticate(req, cfg, auth) {
  const at = parseCookies(req.headers.get("cookie"))[AT_COOKIE];
  if (!at || !TOKEN_RE.test(at)) return { ok: false, status: 401 };
  let r;
  try {
    r = await auth.getUser(at);
  } catch {
    return { ok: false, status: 503 };
  }
  if (r.status !== 200 || !r.json?.email) return { ok: false, status: 401 };
  if (!isAllowedAdmin(cfg, r.json.email)) return { ok: false, status: 403 };
  return { ok: true, email: String(r.json.email).toLowerCase() };
}
