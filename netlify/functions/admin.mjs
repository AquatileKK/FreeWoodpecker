// 管理后台接口：/api/admin/*
//   POST /api/admin/login     登录
//   POST /api/admin/logout    退出
//   POST /api/admin/refresh   续期
//   GET  /api/admin/me        当前是否已登录
//   GET  /api/admin/orders    订单列表（支持状态筛选、搜索、分页）
//   GET  /api/admin/order     订单详情（含图片、状态日志）
//   GET  /api/admin/image     订单图片（需要登录，图片所在存储桶不公开）
//   POST /api/admin/update-order  处理订单：接单/拒单/开始维修/完成/取消，以及保存报价、实收、备注
//
// 绝不返回：取消链接 Token 的哈希、任何密钥、登录令牌。

import { createClient } from "../lib/supabase.mjs";
import {
  AT_COOKIE, RT_COOKIE,
  getAdminConfig, isAllowedAdmin, createAuthClient, parseCookies,
  isSecureRequest, sessionCookies, clearedCookies, sameOriginOk, authenticate,
} from "../lib/admin-auth.mjs";

const STATUSES = ["pending", "accepted", "repairing", "completed", "cancelled", "rejected"];
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;
const LOGIN_FAILED = "邮箱或密码不正确";

// 状态流转表：动作 → 允许的当前状态 → 新状态。不在表里的流转一律拒绝（例如不能把“已完成”改回“待处理”）。
const TRANSITIONS = {
  accept:   { from: ["pending"], to: "accepted" },
  reject:   { from: ["pending"], to: "rejected" },
  start:    { from: ["accepted"], to: "repairing" },
  complete: { from: ["repairing"], to: "completed" },
  cancel:   { from: ["pending", "accepted", "repairing"], to: "cancelled" },
};
const PRICE_EDITABLE = new Set(["accepted", "repairing", "completed"]); // 待处理/已拒绝/已取消的订单不填价格
const MAX_PRICE = 99999.99;

// 价格：数字或数字字符串，最多两位小数，0 ~ 99999.99。空字符串/null 表示清空。非法返回 undefined。
function parsePrice(v) {
  if (v === null || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") return undefined;
  const str = String(v).trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(str)) return undefined;
  const n = Number(str);
  return n >= 0 && n <= MAX_PRICE ? n : undefined;
}
// 文字：去首尾空格，按字符数限制长度。空 → null。超长/类型不对返回 undefined。
function parseText(v, max) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t === "") return null;
  return [...t].length <= max ? t : undefined;
}

function json(status, body, cookies = []) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

const unauthorized = (secure) => json(401, { error: "请先登录" }, clearedCookies(secure));

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  const secure = isSecureRequest(req);

  const cfg = getAdminConfig();
  if (!cfg) {
    console.error("admin: 后台未配置完整（需要 SUPABASE_ANON_KEY、ADMIN_EMAILS，且 ANON 不能是管理员密钥）");
    return json(503, { error: "后台尚未配置完成" });
  }
  const auth = createAuthClient(cfg);

  // 所有会修改状态的请求（POST）：必须同源 + JSON，防止被别的网站诱导操作
  if (method === "POST") {
    if (!sameOriginOk(req)) return json(403, { error: "请求来源不被允许" });
    if (!(req.headers.get("content-type") || "").startsWith("application/json")) {
      return json(415, { error: "请求格式不正确" });
    }
  }

  try {
    // ---------- 登录 ----------
    if (route === "/api/admin/login") {
      if (method !== "POST") return json(405, { error: "请求方式不允许" });
      let body;
      try { body = await req.json(); } catch { return json(400, { error: "请求格式不正确" }); }
      const email = typeof body?.email === "string" ? body.email.trim() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!email || email.length > 254 || !password || password.length > 200) {
        return json(400, { error: "请输入邮箱和密码" });
      }

      const r = await auth.signIn(email, password);
      if (r.status === 429) return json(429, { error: "尝试次数过多，请稍后再试" });
      if (r.status !== 200 || !r.json?.access_token || !r.json?.refresh_token) {
        return json(401, { error: LOGIN_FAILED });
      }
      // 密码对了但不在管理员白名单：返回与“密码错误”完全相同的提示，不让人探测哪些邮箱存在
      if (!isAllowedAdmin(cfg, r.json.user?.email)) {
        console.warn("admin: 非管理员账号尝试登录");
        await auth.signOut(r.json.access_token).catch(() => {});
        return json(401, { error: LOGIN_FAILED });
      }
      return json(200, { email: String(r.json.user.email).toLowerCase() }, sessionCookies(r.json, secure));
    }

    // ---------- 退出 ----------
    if (route === "/api/admin/logout") {
      if (method !== "POST") return json(405, { error: "请求方式不允许" });
      const at = parseCookies(req.headers.get("cookie"))[AT_COOKIE];
      if (at) await auth.signOut(at).catch(() => {}); // 让 Supabase 作废这次登录
      return json(200, { ok: true }, clearedCookies(secure));
    }

    // ---------- 续期 ----------
    if (route === "/api/admin/refresh") {
      if (method !== "POST") return json(405, { error: "请求方式不允许" });
      const rt = parseCookies(req.headers.get("cookie"))[RT_COOKIE];
      if (!rt || rt.length > 4096) return unauthorized(secure);
      const r = await auth.refresh(rt);
      if (r.status !== 200 || !r.json?.access_token || !r.json?.refresh_token) return unauthorized(secure);
      if (!isAllowedAdmin(cfg, r.json.user?.email)) {
        await auth.signOut(r.json.access_token).catch(() => {});
        return unauthorized(secure);
      }
      return json(200, { ok: true }, sessionCookies(r.json, secure));
    }

    // ---------- 以下接口都必须是已登录的管理员 ----------
    if (!["/api/admin/me", "/api/admin/orders", "/api/admin/order", "/api/admin/image", "/api/admin/update-order"].includes(route)) {
      return json(404, { error: "不存在" });
    }
    const isWrite = route === "/api/admin/update-order";
    if (isWrite ? method !== "POST" : method !== "GET") return json(405, { error: "请求方式不允许" });

    const who = await authenticate(req, cfg, auth);
    if (!who.ok) {
      if (who.status === 503) return json(503, { error: "服务暂时不可用，请稍后再试" });
      if (who.status === 403) return json(403, { error: "该账号没有管理员权限" }, clearedCookies(secure));
      // 访问令牌过期/缺失时【不要】清除 Cookie：浏览器里的刷新令牌还要用来无感续期。
      // 只有退出登录、续期失败、非管理员这几种情况才清除。
      return json(401, { error: "请先登录" });
    }

    if (route === "/api/admin/me") return json(200, { email: who.email });

    const db = createClient(cfg);

    // ---------- 处理订单 ----------
    if (route === "/api/admin/update-order") {
      let body;
      try { body = await req.json(); } catch { return json(400, { error: "请求格式不正确" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "请求格式不正确" });
      const id = typeof body.id === "string" ? body.id : "";
      if (!UUID_RE.test(id)) return json(400, { error: "订单编号格式不正确" });
      const action = typeof body.action === "string" ? body.action : "";
      if (action !== "save" && !Object.hasOwn(TRANSITIONS, action)) return json(400, { error: "操作不正确" });

      const current = await db.getOrderById(id);
      if (!current) return json(404, { error: "订单不存在" });

      // 只接收白名单字段，其他字段（比如 status、cancel_token_hash）一律忽略
      const patch = {};
      if ("quoted_price" in body) {
        const v = parsePrice(body.quoted_price);
        if (v === undefined) return json(400, { error: "报价格式不正确（0 ~ 99999.99，最多两位小数）" });
        patch.quoted_price = v;
      }
      if ("final_price" in body) {
        const v = parsePrice(body.final_price);
        if (v === undefined) return json(400, { error: "实收金额格式不正确（0 ~ 99999.99，最多两位小数）" });
        patch.final_price = v;
      }
      if ("admin_note" in body) {
        const v = parseText(body.admin_note, 1000);
        if (v === undefined) return json(400, { error: "备注最多 1000 个字" });
        patch.admin_note = v;
      }

      let fromStatuses = null;
      let eventNote = null;
      let newStatus = current.status;
      if (action !== "save") {
        const t = TRANSITIONS[action];
        if (!t.from.includes(current.status)) {
          return json(409, { error: "订单当前状态不允许这个操作，请刷新后再看", order: current });
        }
        fromStatuses = t.from;
        newStatus = t.to;
        patch.status = t.to;
        if (action === "reject") {
          const reason = parseText(body.reason, 500);
          if (reason === undefined || reason === null) return json(400, { error: "请填写拒单原因（最多 500 个字）" });
          patch.reject_reason = reason;
          eventNote = reason;
        }
        if (action === "cancel") {
          const reason = parseText(body.reason, 500);
          if (reason === undefined) return json(400, { error: "取消原因最多 500 个字" });
          eventNote = reason;
        }
        if (action === "complete") {
          const fin = "final_price" in patch ? patch.final_price : current.final_price;
          if (fin === null || fin === undefined) return json(400, { error: "完成订单前请先填写实收金额（免费请填 0）" });
        }
      }

      if (("quoted_price" in patch || "final_price" in patch) && !PRICE_EDITABLE.has(newStatus)) {
        return json(400, { error: "接单之后才能填写报价和实收金额" });
      }
      if (Object.keys(patch).length === 0) return json(400, { error: "没有要保存的内容" });

      const updated = await db.updateOrder(id, fromStatuses, patch);
      if (!updated) return json(409, { error: "订单状态刚刚发生了变化（可能学生已取消），请刷新后再看" });

      if (action !== "save") {
        // 状态变更写入日志；日志写失败不回滚订单（订单状态已经改了），只记录服务器错误
        try {
          await db.insertEvent({ order_id: id, from_status: current.status, to_status: newStatus, actor: "admin", note: eventNote });
        } catch (e) {
          console.error("admin: 状态日志写入失败", e.message);
        }
      }
      return json(200, { order: updated });
    }

    // ---------- 订单列表 ----------
    if (route === "/api/admin/orders") {
      const status = url.searchParams.get("status") || "";
      if (status && !STATUSES.includes(status)) return json(400, { error: "状态不正确" });
      const q = (url.searchParams.get("q") || "").trim().replace(/ +/g, " ");
      if (q && !/^[\p{L}\p{N} -]{1,30}$/u.test(q)) return json(400, { error: "搜索词只能包含文字、数字、空格和短横线（最多 30 个字）" });
      const page = Math.min(Math.max(parseInt(url.searchParams.get("page"), 10) || 1, 1), 1000);

      const { rows, total } = await db.listOrders({ status, q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      return json(200, { orders: rows, total, page, pageSize: PAGE_SIZE });
    }

    // ---------- 订单详情 ----------
    if (route === "/api/admin/order") {
      const id = url.searchParams.get("id") || "";
      if (!UUID_RE.test(id)) return json(400, { error: "订单编号格式不正确" });
      const order = await db.getOrderById(id);
      if (!order) return json(404, { error: "订单不存在" });
      const [images, events] = await Promise.all([db.listOrderImages(id), db.listOrderEvents(id)]);
      return json(200, {
        order,
        images: images.map((i) => ({
          id: i.id,
          contentType: i.content_type,
          size: i.size_bytes,
          url: `/api/admin/image?id=${i.id}`,
        })),
        events,
      });
    }

    // ---------- 订单图片 ----------
    if (route === "/api/admin/image") {
      const id = url.searchParams.get("id") || "";
      if (!UUID_RE.test(id)) return json(400, { error: "图片编号格式不正确" });
      const row = await db.getImageById(id);
      if (!row || !IMAGE_TYPES.has(row.content_type)) return json(404, { error: "图片不存在" });
      const bytes = await db.downloadImage(row.storage_path);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": row.content_type, // 来自上传时按真实内容判定的类型，不是浏览器自称的类型
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Disposition": "inline",
        },
      });
    }

    return json(404, { error: "不存在" });
  } catch (err) {
    console.error("admin:", err.message);
    return json(500, { error: "服务暂时不可用，请稍后再试" });
  }
};

export const config = { path: "/api/admin/*" };
