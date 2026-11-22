// 测试用“假 Supabase”：在本机起一个小服务器，模拟订单/图片/日志/存储/登录服务。全部是虚构数据。
import http from "node:http";
import { randomUUID } from "node:crypto";

export const SERVICE_KEY = "sb_secret_FAKE_KEY_FOR_TESTS_ONLY";
export const ANON_KEY = "sb_publishable_FAKE_PUBLIC_KEY_FOR_TESTS";
export const FAKE_USERS = {
  admin: { email: "boss@example.com", password: "correct-horse-battery-1" },
  other: { email: "other@example.com", password: "other-password-123" }, // 真实存在的 Supabase 账号，但不是管理员
};

export function startFakeSupabase() {
  const state = {
    orders: [], images: [], events: [], files: new Map(),
    seq: 0, hooks: { beforePatch: null },
    users: new Map(Object.values(FAKE_USERS).map((u) => [u.email, { id: randomUUID(), password: u.password }])),
    tokens: new Map(), refreshTokens: new Map(),
    authRateLimit: false, authLog: [],
  };

  // 给测试直接发一个登录会话（相当于该用户已登录）
  state.issueSession = (email) => {
    const at = `at${randomUUID().replace(/-/g, "")}.fake.jwt`;
    const rt = `rt${randomUUID().replace(/-/g, "")}`;
    state.tokens.set(at, { email, expired: false });
    state.refreshTokens.set(rt, email);
    return { access_token: at, refresh_token: rt, expires_in: 3600, user: { id: state.users.get(email)?.id, email } };
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, "http://fake");
    const sp = u.searchParams;
    const p = u.pathname;
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };

    // ===== 登录服务（Auth）：使用公开密钥 =====
    if (p.startsWith("/auth/v1/")) {
      if (req.headers.apikey !== ANON_KEY) return send(401, { message: "bad anon key" });
      const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
      const grant = sp.get("grant_type");
      if (p === "/auth/v1/token" && grant === "password") {
        state.authLog.push("password");
        if (state.authRateLimit) return send(429, { error_code: "over_request_rate_limit" });
        const { email, password } = JSON.parse(body.toString());
        const user = state.users.get(String(email).toLowerCase());
        if (!user || user.password !== password) return send(400, { error_code: "invalid_credentials" });
        return send(200, { token_type: "bearer", ...state.issueSession(String(email).toLowerCase()) });
      }
      if (p === "/auth/v1/token" && grant === "refresh_token") {
        state.authLog.push("refresh");
        const { refresh_token } = JSON.parse(body.toString());
        const email = state.refreshTokens.get(refresh_token);
        if (!email) return send(400, { error_code: "refresh_token_not_found" });
        state.refreshTokens.delete(refresh_token); // 刷新令牌用一次就作废
        return send(200, { token_type: "bearer", ...state.issueSession(email) });
      }
      if (p === "/auth/v1/user") {
        const t = state.tokens.get(bearer);
        if (!t || t.expired) return send(401, { error_code: "bad_jwt" });
        return send(200, { id: state.users.get(t.email)?.id, email: t.email, role: "authenticated" });
      }
      if (p === "/auth/v1/logout") {
        state.authLog.push("logout");
        state.tokens.delete(bearer);
        return send(204);
      }
      return send(404, { message: "not found" });
    }

    // ===== 数据库与存储：使用管理员密钥 =====
    if (req.headers.apikey !== SERVICE_KEY) return send(401, { message: "bad key" });

    const eq = (k) => ((sp.get(k) || "").startsWith("eq.") ? sp.get(k).slice(3) : null);
    const pick = (row, select) =>
      select ? Object.fromEntries(select.split(",").map((k) => [k, row[k]])) : row;

    if (p === "/rest/v1/orders" && req.method === "GET") {
      let rows = [...state.orders];
      for (const k of ["cancel_token_hash", "id", "status", "phone"]) if (eq(k) !== null) rows = rows.filter((o) => o[k] === eq(k));
      if ((sp.get("created_at") || "").startsWith("gte.")) rows = rows.filter((o) => o.created_at >= sp.get("created_at").slice(4));
      if (sp.get("or")) {
        const m = sp.get("or").match(/order_no\.ilike\.\*(.*?)\*,student_name/);
        const needle = (m ? m[1] : "").toLowerCase();
        rows = rows.filter((o) => ["order_no", "student_name", "phone", "building", "room"].some((f) => String(o[f] ?? "").toLowerCase().includes(needle)));
      }
      if (sp.get("order") === "created_at.desc") {
        rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : state.orders.indexOf(b) - state.orders.indexOf(a)));
      }
      const total = rows.length;
      const offset = Number(sp.get("offset") || 0);
      rows = rows.slice(offset, offset + Number(sp.get("limit") || 100));
      const headers = {};
      if ((req.headers.prefer || "").includes("count=exact")) {
        headers["Content-Range"] = rows.length ? `${offset}-${offset + rows.length - 1}/${total}` : `*/${total}`;
      }
      return send(200, rows.map((o) => pick(o, sp.get("select"))), headers);
    }
    if (p === "/rest/v1/orders" && req.method === "POST") {
      const row = JSON.parse(body.toString());
      if (!/^[0-9a-f]{64}$/.test(row.cancel_token_hash || "")) return send(400, { code: "23514" });
      const saved = {
        ...row, id: randomUUID(),
        order_no: `JX261121-${String(++state.seq).padStart(4, "0")}`,
        status: "pending", cancelled_at: null, quoted_price: null, final_price: null,
        reject_reason: null, admin_note: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      state.orders.push(saved);
      return send(201, [pick(saved, sp.get("select"))]);
    }
    if (p === "/rest/v1/orders" && req.method === "PATCH") {
      if (state.hooks.beforePatch) state.hooks.beforePatch(state);
      const patch = JSON.parse(body.toString());
      const inList = (sp.get("status") || "").match(/^in\.\((.*)\)$/);
      const allowed = inList ? inList[1].split(",") : null;
      const rows = state.orders.filter((o) => (eq("id") === null || o.id === eq("id")) && (eq("status") === null || o.status === eq("status")) && (!allowed || allowed.includes(o.status)));
      state.patchLog = (state.patchLog || []).concat([patch]);
      rows.forEach((o) => Object.assign(o, patch, { updated_at: new Date().toISOString() }));
      return send(200, rows.map((o) => pick(o, sp.get("select"))));
    }
    if (p === "/rest/v1/orders" && req.method === "DELETE") {
      const id = eq("id");
      state.orders = state.orders.filter((o) => o.id !== id);
      state.images = state.images.filter((i) => i.order_id !== id);
      return send(204);
    }
    if (p === "/rest/v1/order_images" && req.method === "GET") {
      let rows = state.images;
      for (const k of ["order_id", "id"]) if (eq(k) !== null) rows = rows.filter((i) => i[k] === eq(k));
      return send(200, rows.slice(0, Number(sp.get("limit") || 100)).map((i) => pick(i, sp.get("select"))));
    }
    if (p === "/rest/v1/order_images" && req.method === "POST") {
      const now = new Date().toISOString();
      state.images.push(...JSON.parse(body.toString()).map((r) => ({ id: randomUUID(), created_at: now, ...r })));
      return send(201);
    }
    if (p === "/rest/v1/order_events" && req.method === "GET") {
      let rows = state.events;
      if (eq("order_id") !== null) rows = rows.filter((e) => e.order_id === eq("order_id"));
      return send(200, rows.map((e) => pick(e, sp.get("select"))));
    }
    if (p === "/rest/v1/order_events" && req.method === "POST") {
      state.events.push({ created_at: new Date().toISOString(), ...JSON.parse(body.toString()) });
      return send(201);
    }
    if (p.startsWith("/storage/v1/object/authenticated/repair-images/") && req.method === "GET") {
      const f = state.files.get(decodeURIComponent(p.replace("/storage/v1/object/authenticated/repair-images/", "")));
      if (!f) return send(404, { error: "not_found" });
      res.writeHead(200, { "Content-Type": f.contentType || "application/octet-stream" });
      return res.end(f.bytes);
    }
    if (p.startsWith("/storage/v1/object/repair-images/") && req.method === "POST") {
      state.files.set(decodeURIComponent(p.replace("/storage/v1/object/repair-images/", "")), {
        size: body.length, bytes: body, contentType: req.headers["content-type"],
      });
      return send(200, { Key: "ok" });
    }
    if (p === "/storage/v1/object/repair-images" && req.method === "DELETE") {
      for (const f of JSON.parse(body.toString()).prefixes) state.files.delete(f);
      return send(200, []);
    }
    return send(404, { message: "not found" });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, state, close: () => server.close() })
    )
  );
}
