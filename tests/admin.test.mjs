// 管理后台接口测试：登录、白名单、越权、伪造令牌、跨站请求、搜索注入、图片权限。全部使用假服务器和虚构数据。
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { startFakeSupabase, SERVICE_KEY, ANON_KEY, FAKE_USERS } from "./helpers/fake-supabase.mjs";

const ADMIN = FAKE_USERS.admin;
const OTHER = FAKE_USERS.other;
let fake, admin, submit;

before(async () => {
  fake = await startFakeSupabase();
  process.env.SUPABASE_URL = `http://127.0.0.1:${fake.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
  process.env.ADMIN_EMAILS = "Boss@Example.com"; // 故意大小写混合，验证不区分大小写
  admin = (await import("../netlify/functions/admin.mjs")).default;
  submit = (await import("../netlify/functions/submit-order.mjs")).default;
});
after(() => fake.close());
beforeEach(() => {
  const s = fake.state;
  s.orders.length = 0; s.images.length = 0; s.events.length = 0; s.files.clear();
  s.tokens.clear(); s.refreshTokens.clear(); s.authLog.length = 0; s.authRateLimit = false;
  process.env.ADMIN_EMAILS = "Boss@Example.com";
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
});

// ---------- 辅助 ----------
const ORIGIN = "http://localhost:8888";
async function call(path, { method = "GET", body, cookie, origin, headers = {}, rawBody, contentType = "application/json", https = false } = {}) {
  const h = { ...headers };
  if (method === "POST") h["Content-Type"] = contentType;
  if (cookie) h.Cookie = cookie;
  if (origin !== null && method === "POST") h.Origin = origin ?? ORIGIN;
  const base = https ? "https://shop.example.com" : ORIGIN;
  const res = await admin(new Request(base + path, { method, headers: h, body: method === "POST" ? (rawBody ?? JSON.stringify(body ?? {})) : undefined }));
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json = null; try { json = JSON.parse(text); } catch {}
  const setCookies = res.headers.getSetCookie();
  const jar = Object.fromEntries(setCookies.map((c) => [c.split("=")[0], c.split(";")[0].split("=").slice(1).join("=")]));
  return { status: res.status, headers: res.headers, text, json, buf, setCookies, jar };
}
const cookieOf = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function loginAsAdmin() {
  const r = await call("/api/admin/login", { method: "POST", body: ADMIN });
  assert.equal(r.status, 200);
  return cookieOf(r.jar);
}
let n = 0;
function seed(over = {}) {
  const o = {
    id: randomUUID(), order_no: `JX261121-${String(++n).padStart(4, "0")}`, status: "pending",
    student_name: "测试同学", phone: `1380000${String(1000 + n)}`, building: "西1", room: "114",
    service_mode: "lobby_handoff", preferred_time: "今晚 7 点以后", description: "开机黑屏（虚构测试数据）",
    quoted_price: null, final_price: null, reject_reason: null, admin_note: null,
    cancel_token_hash: createHash("sha256").update("tok" + n).digest("hex"),
    created_at: new Date(Date.UTC(2026, 10, 21, 10, 0, n)).toISOString(), updated_at: new Date().toISOString(), cancelled_at: null,
    ...over,
  };
  fake.state.orders.push(o);
  return o;
}

// ===== 登录 =====
test("管理员登录成功：只返回邮箱，令牌只放在 HttpOnly Cookie 里", async () => {
  const r = await call("/api/admin/login", { method: "POST", body: ADMIN });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { email: "boss@example.com" });
  assert.equal(r.setCookies.length, 2);
  for (const c of r.setCookies) {
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Path=\/api\/admin/);
    assert.doesNotMatch(c, /Secure/, "本机 http 环境不加 Secure，否则浏览器不保存");
  }
  assert.ok(!r.text.includes(r.jar.jx_at) && !r.text.includes(r.jar.jx_rt), "令牌不能出现在响应正文里");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("线上 https 环境：Cookie 带 Secure", async () => {
  const r = await call("/api/admin/login", { method: "POST", body: ADMIN, https: true, origin: "https://shop.example.com" });
  assert.equal(r.status, 200);
  for (const c of r.setCookies) assert.match(c, /; Secure/);
});

test("邮箱不区分大小写，前后空格会被忽略", async () => {
  const r = await call("/api/admin/login", { method: "POST", body: { email: "  BOSS@example.COM ", password: ADMIN.password } });
  assert.equal(r.status, 200);
});

test("密码错误、邮箱不存在、非管理员账号：返回完全相同的 401，且不发 Cookie", async () => {
  const wrong = await call("/api/admin/login", { method: "POST", body: { email: ADMIN.email, password: "wrong-password" } });
  const nobody = await call("/api/admin/login", { method: "POST", body: { email: "nobody@example.com", password: "whatever-123" } });
  const notAdmin = await call("/api/admin/login", { method: "POST", body: OTHER }); // 密码是对的，但不在白名单
  for (const r of [wrong, nobody, notAdmin]) {
    assert.equal(r.status, 401);
    assert.equal(r.setCookies.length, 0);
  }
  assert.equal(wrong.text, nobody.text);
  assert.equal(wrong.text, notAdmin.text);
  assert.ok(fake.state.authLog.includes("logout"), "非管理员登录成功的那次会话会被立即作废");
});

test("非管理员即使拿到了合法登录令牌，也进不了后台（403）", async () => {
  const s = fake.state.issueSession(OTHER.email);
  const r = await call("/api/admin/orders", { cookie: `jx_at=${s.access_token}` });
  assert.equal(r.status, 403);
  assert.ok(!r.text.includes("测试"), "不泄露任何订单内容");
});

test("登录请求格式：缺字段 400；超长输入 400；非 JSON 415；GET 405", async () => {
  assert.equal((await call("/api/admin/login", { method: "POST", body: { email: ADMIN.email } })).status, 400);
  assert.equal((await call("/api/admin/login", { method: "POST", body: { email: "a".repeat(300), password: "x" } })).status, 400);
  assert.equal((await call("/api/admin/login", { method: "POST", body: { email: ADMIN.email, password: "x".repeat(201) } })).status, 400);
  assert.equal((await call("/api/admin/login", { method: "POST", rawBody: "email=a", contentType: "text/plain" })).status, 415);
  assert.equal((await call("/api/admin/login", { method: "POST", rawBody: "not json" })).status, 400);
  assert.equal((await call("/api/admin/login")).status, 405);
});

test("Supabase 限制了登录次数时，提示稍后再试（429）", async () => {
  fake.state.authRateLimit = true;
  const r = await call("/api/admin/login", { method: "POST", body: ADMIN });
  assert.equal(r.status, 429);
  assert.equal(r.setCookies.length, 0);
});

// ===== 跨站请求 =====
test("来自其他网站的登录/退出/续期请求被拒绝（403）", async () => {
  for (const p of ["/api/admin/login", "/api/admin/logout", "/api/admin/refresh"]) {
    const r = await call(p, { method: "POST", body: ADMIN, origin: "https://evil.example" });
    assert.equal(r.status, 403, p);
    assert.equal(r.setCookies.length, 0);
  }
  assert.equal(fake.state.authLog.length, 0, "跨站请求根本不会走到登录服务");
});

test("Origin 缺失但浏览器标明是跨站（Sec-Fetch-Site）：拒绝", async () => {
  const r = await call("/api/admin/login", { method: "POST", body: ADMIN, origin: null, headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(r.status, 403);
});

// ===== 身份验证 =====
test("所有后台接口在未登录时都返回 401，不泄露数据", async () => {
  const o = seed();
  for (const p of ["/api/admin/me", "/api/admin/orders", `/api/admin/order?id=${o.id}`, `/api/admin/image?id=${randomUUID()}`]) {
    const r = await call(p);
    assert.equal(r.status, 401, p);
    assert.ok(!r.text.includes("测试同学") && !r.text.includes(o.order_no));
  }
});

test("伪造/乱写的 Cookie 一律 401", async () => {
  for (const c of ["jx_at=abc", "jx_at=" + "x".repeat(40), "jx_at=Bearer evil", "jx_at=" + "a".repeat(5000), "jx_at=", "other=1"]) {
    assert.equal((await call("/api/admin/orders", { cookie: c })).status, 401, c.slice(0, 20));
  }
});

test("访问令牌过期后：401，但【不能】清除刷新令牌 Cookie（否则无法无感续期）", async () => {
  const cookie = await loginAsAdmin();
  assert.equal((await call("/api/admin/me", { cookie })).status, 200);
  for (const t of fake.state.tokens.values()) t.expired = true;
  const r = await call("/api/admin/me", { cookie });
  assert.equal(r.status, 401);
  assert.equal(r.setCookies.length, 0, "401 响应不能动浏览器里的 Cookie");
});

test("访问令牌过期 → 用刷新令牌续期 → 继续访问（用户全程无感）", async () => {
  const login = await call("/api/admin/login", { method: "POST", body: ADMIN });
  let cookie = cookieOf(login.jar);
  for (const t of fake.state.tokens.values()) t.expired = true;
  assert.equal((await call("/api/admin/orders", { cookie })).status, 401);
  const renewed = await call("/api/admin/refresh", { method: "POST", cookie });
  assert.equal(renewed.status, 200);
  cookie = cookieOf(renewed.jar);
  assert.equal((await call("/api/admin/orders", { cookie })).status, 200);
});

test("访问令牌的 Cookie 因超过有效期被浏览器丢弃（只剩刷新令牌）：仍可续期", async () => {
  const login = await call("/api/admin/login", { method: "POST", body: ADMIN });
  assert.equal((await call("/api/admin/orders", { cookie: `jx_rt=${login.jar.jx_rt}` })).status, 401);
  const renewed = await call("/api/admin/refresh", { method: "POST", cookie: `jx_rt=${login.jar.jx_rt}` });
  assert.equal(renewed.status, 200);
  assert.equal((await call("/api/admin/orders", { cookie: cookieOf(renewed.jar) })).status, 200);
});

test("管理员白名单被移除后，已登录的会话立刻失效", async () => {
  const cookie = await loginAsAdmin();
  process.env.ADMIN_EMAILS = "someone-else@example.com";
  assert.equal((await call("/api/admin/orders", { cookie })).status, 403);
});

test("已登录：/me 返回邮箱", async () => {
  const cookie = await loginAsAdmin();
  const r = await call("/api/admin/me", { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { email: "boss@example.com" });
});

test("退出登录：清除 Cookie，并让 Supabase 作废该令牌", async () => {
  const cookie = await loginAsAdmin();
  const r = await call("/api/admin/logout", { method: "POST", cookie });
  assert.equal(r.status, 200);
  assert.equal(r.setCookies.filter((c) => /Max-Age=0/.test(c)).length, 2);
  assert.equal((await call("/api/admin/me", { cookie })).status, 401, "旧令牌不能再用");
});

test("续期：换发新 Cookie；旧刷新令牌不能重复使用", async () => {
  const login = await call("/api/admin/login", { method: "POST", body: ADMIN });
  const cookie = cookieOf(login.jar);
  const r1 = await call("/api/admin/refresh", { method: "POST", cookie });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.jar.jx_at, login.jar.jx_at);
  assert.equal((await call("/api/admin/me", { cookie: cookieOf(r1.jar) })).status, 200);
  const replay = await call("/api/admin/refresh", { method: "POST", cookie });
  assert.equal(replay.status, 401);
});

test("续期：非管理员的刷新令牌被拒绝", async () => {
  const s = fake.state.issueSession(OTHER.email);
  const r = await call("/api/admin/refresh", { method: "POST", cookie: `jx_rt=${s.refresh_token}` });
  assert.equal(r.status, 401);
  assert.equal(r.setCookies.filter((c) => /Max-Age=0/.test(c)).length, 2);
});

test("续期：没有或乱写的刷新令牌 401", async () => {
  assert.equal((await call("/api/admin/refresh", { method: "POST" })).status, 401);
  assert.equal((await call("/api/admin/refresh", { method: "POST", cookie: "jx_rt=garbage" })).status, 401);
});

// ===== 配置缺失时一律拒绝 =====
test("没配置管理员邮箱白名单：所有后台接口都不可用（503）", async () => {
  process.env.ADMIN_EMAILS = "";
  assert.equal((await call("/api/admin/login", { method: "POST", body: ADMIN })).status, 503);
  assert.equal((await call("/api/admin/orders")).status, 503);
});

test("没配置公开密钥：后台不可用", async () => {
  delete process.env.SUPABASE_ANON_KEY;
  assert.equal((await call("/api/admin/login", { method: "POST", body: ADMIN })).status, 503);
});

test("公开密钥位置误填了管理员密钥：后台拒绝启动", async () => {
  process.env.SUPABASE_ANON_KEY = "sb_secret_oops";
  assert.equal((await call("/api/admin/login", { method: "POST", body: ADMIN })).status, 503);
  const jwt = "x." + Buffer.from('{"role":"service_role"}').toString("base64url") + ".y";
  process.env.SUPABASE_ANON_KEY = jwt;
  assert.equal((await call("/api/admin/login", { method: "POST", body: ADMIN })).status, 503);
});

// ===== 订单列表 =====
test("订单列表：按提交时间从新到旧；包含处理订单需要的信息", async () => {
  const a = seed({ student_name: "甲", status: "pending" });
  const b = seed({ student_name: "乙", status: "accepted", service_mode: "visit_room" });
  const c = seed({ student_name: "丙", status: "completed" });
  const cookie = await loginAsAdmin();
  const r = await call("/api/admin/orders", { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.orders.map((o) => o.student_name), ["丙", "乙", "甲"]);
  assert.equal(r.json.total, 3);
  assert.equal(r.json.page, 1);
  const o = r.json.orders[1];
  for (const k of ["order_no", "status", "phone", "building", "room", "service_mode", "preferred_time", "created_at"]) assert.ok(k in o, k);
  assert.equal(o.service_mode, "visit_room");
  void a; void b; void c;
});

test("订单列表：永远不包含取消 Token 哈希，也没有密钥", async () => {
  const o = seed();
  const cookie = await loginAsAdmin();
  for (const p of ["/api/admin/orders", `/api/admin/order?id=${o.id}`]) {
    const r = await call(p, { cookie });
    assert.ok(!r.text.includes("cancel_token_hash"), p);
    assert.ok(!r.text.includes(o.cancel_token_hash), p);
    assert.ok(!r.text.includes(SERVICE_KEY) && !r.text.includes(ANON_KEY), p);
  }
});

test("订单列表：按状态筛选", async () => {
  seed({ status: "pending" }); seed({ status: "pending" }); seed({ status: "repairing" });
  const cookie = await loginAsAdmin();
  const r = await call("/api/admin/orders?status=pending", { cookie });
  assert.equal(r.json.total, 2);
  assert.ok(r.json.orders.every((o) => o.status === "pending"));
  assert.equal((await call("/api/admin/orders?status=hacked", { cookie })).status, 400);
});

test("订单列表：搜索（订单号、姓名、手机号、楼栋、房间），不区分大小写，支持中文", async () => {
  seed({ student_name: "张三", building: "西1", room: "114", phone: "13811112222" });
  seed({ student_name: "李四", building: "东3", room: "502", phone: "13933334444" });
  const cookie = await loginAsAdmin();
  const names = async (q) => (await call("/api/admin/orders?q=" + encodeURIComponent(q), { cookie })).json.orders.map((o) => o.student_name);
  assert.deepEqual(await names("张"), ["张三"]);
  assert.deepEqual(await names("13933"), ["李四"]);
  assert.deepEqual(await names("东3"), ["李四"]);
  assert.deepEqual(await names("114"), ["张三"]);
  assert.deepEqual(await names("jx261121"), ["李四", "张三"]);
  assert.deepEqual(await names("没有这个人"), []);
});

test("搜索词中的特殊符号（逗号、括号、星号、百分号等）一律拒绝，防止注入筛选条件", async () => {
  seed();
  const cookie = await loginAsAdmin();
  for (const q of ["a,b", "a)", "(a", "*", "a%", "a_b", "x.or.y", "a;b", "a'b", "a\"b", "<script>", "a\\b", "a".repeat(31)]) {
    const r = await call("/api/admin/orders?q=" + encodeURIComponent(q), { cookie });
    assert.equal(r.status, 400, JSON.stringify(q));
  }
});

test("订单列表：分页，每页 20 条", async () => {
  for (let i = 0; i < 45; i++) seed();
  const cookie = await loginAsAdmin();
  const p1 = (await call("/api/admin/orders?page=1", { cookie })).json;
  const p3 = (await call("/api/admin/orders?page=3", { cookie })).json;
  const p4 = (await call("/api/admin/orders?page=4", { cookie })).json;
  assert.equal(p1.orders.length, 20); assert.equal(p1.total, 45);
  assert.equal(p3.orders.length, 5);
  assert.equal(p4.orders.length, 0);
  assert.equal(new Set([...p1.orders, ...p3.orders].map((o) => o.id)).size, 25, "不同页之间没有重复");
  assert.equal((await call("/api/admin/orders?page=abc", { cookie })).json.page, 1);
  assert.equal((await call("/api/admin/orders?page=-5", { cookie })).json.page, 1);
});

// ===== 订单详情与图片 =====
test("订单详情：完整信息 + 图片链接 + 状态日志", async () => {
  const o = seed({ description: "详细故障描述", quoted_price: 50, admin_note: "备注" });
  const imgId = randomUUID();
  fake.state.images.push({ id: imgId, order_id: o.id, storage_path: `${o.id}/a.png`, content_type: "image/png", size_bytes: 3, created_at: new Date().toISOString() });
  fake.state.events.push({ order_id: o.id, from_status: null, to_status: "pending", actor: "student", created_at: new Date().toISOString() });
  const cookie = await loginAsAdmin();
  const r = await call(`/api/admin/order?id=${o.id}`, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.order.description, "详细故障描述");
  assert.equal(r.json.order.quoted_price, 50);
  assert.deepEqual(r.json.images, [{ id: imgId, contentType: "image/png", size: 3, url: `/api/admin/image?id=${imgId}` }]);
  assert.equal(r.json.events[0].to_status, "pending");
  assert.ok(!r.text.includes(o.id + "/a.png"), "不暴露存储路径");
});

test("订单详情：只返回该订单自己的图片和日志", async () => {
  const a = seed(); const b = seed();
  fake.state.images.push({ id: randomUUID(), order_id: b.id, storage_path: "x/b.png", content_type: "image/png", size_bytes: 1, created_at: "" });
  const cookie = await loginAsAdmin();
  assert.equal((await call(`/api/admin/order?id=${a.id}`, { cookie })).json.images.length, 0);
  assert.equal((await call(`/api/admin/order?id=${b.id}`, { cookie })).json.images.length, 1);
});

test("订单详情：编号格式错误 400，不存在 404", async () => {
  const cookie = await loginAsAdmin();
  for (const id of ["", "abc", "1; drop table orders", "../etc/passwd", randomUUID() + "x"]) {
    assert.equal((await call("/api/admin/order?id=" + encodeURIComponent(id), { cookie })).status, 400, id);
  }
  assert.equal((await call(`/api/admin/order?id=${randomUUID()}`, { cookie })).status, 404);
});

test("端到端：学生提交的订单和图片，管理员能看到并下载原图", async () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  Object.entries({ name: "端到端同学", phone: "13800009999", building: "西1", room: "114", service_mode: "visit_room", preferred_time: "周日", description: "端到端测试订单（虚构）" }).forEach(([k, v]) => fd.append(k, v));
  fd.append("images", new File([PNG], "a.png", { type: "image/png" }));
  assert.equal((await submit(new Request("http://localhost:8888/api/submit-order", { method: "POST", body: fd }))).status, 201);

  const cookie = await loginAsAdmin();
  const list = (await call("/api/admin/orders", { cookie })).json;
  assert.equal(list.orders[0].student_name, "端到端同学");
  const detail = (await call(`/api/admin/order?id=${list.orders[0].id}`, { cookie })).json;
  assert.equal(detail.images.length, 1);
  const img = await call(detail.images[0].url, { cookie });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.deepEqual(img.buf, PNG);
});

test("图片接口：需要登录；带安全响应头；不缓存", async () => {
  const o = seed();
  const id = randomUUID();
  fake.state.images.push({ id, order_id: o.id, storage_path: `${o.id}/p.png`, content_type: "image/png", size_bytes: 4, created_at: "" });
  fake.state.files.set(`${o.id}/p.png`, { bytes: Buffer.from([1, 2, 3, 4]), contentType: "image/png" });
  assert.equal((await call(`/api/admin/image?id=${id}`)).status, 401);
  const cookie = await loginAsAdmin();
  const r = await call(`/api/admin/image?id=${id}`, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("cache-control"), /no-store/);
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
});

test("图片接口：编号错误 400、不存在 404、数据库里类型异常的记录拒绝输出", async () => {
  const o = seed();
  const cookie = await loginAsAdmin();
  assert.equal((await call("/api/admin/image?id=../../x", { cookie })).status, 400);
  assert.equal((await call(`/api/admin/image?id=${randomUUID()}`, { cookie })).status, 404);
  const id = randomUUID();
  fake.state.images.push({ id, order_id: o.id, storage_path: "a/evil.html", content_type: "text/html", size_bytes: 1, created_at: "" });
  fake.state.files.set("a/evil.html", { bytes: Buffer.from("<script>alert(1)</script>"), contentType: "text/html" });
  assert.equal((await call(`/api/admin/image?id=${id}`, { cookie })).status, 404);
});

// ===== 其他 =====
test("未知路径 404；后台接口不接受 POST 修改（本阶段只读）", async () => {
  const cookie = await loginAsAdmin();
  assert.equal((await call("/api/admin/nothing", { cookie })).status, 404);
  assert.equal((await call("/api/admin/orders", { method: "POST", cookie, body: {} })).status, 405);
  assert.equal((await call("/api/admin/order", { method: "POST", cookie, body: {} })).status, 405);
});

test("数据库出错时返回通用提示，不泄露内部信息", async () => {
  const cookie = await loginAsAdmin();
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_WRONG";
  try {
    const r = await call("/api/admin/orders", { cookie });
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes("sb_secret") && !r.text.includes("127.0.0.1"));
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

// ===== 处理订单（阶段 8）=====
async function upd(cookie, body, opts = {}) {
  return call("/api/admin/update-order", { method: "POST", cookie, body, ...opts });
}
const find = (id) => fake.state.orders.find((o) => o.id === id);

test("处理订单：未登录 / 非管理员 / 伪造令牌 一律 401 或 403，订单不变", async () => {
  const o = seed();
  assert.equal((await upd(undefined, { id: o.id, action: "accept" })).status, 401);
  assert.equal((await upd("jx_at=forged.token.value", { id: o.id, action: "accept" })).status, 401);
  const s = fake.state.issueSession(OTHER.email);
  assert.equal((await upd(`jx_at=${s.access_token}`, { id: o.id, action: "accept" })).status, 403);
  assert.equal(find(o.id).status, "pending");
  assert.equal(fake.state.events.length, 0);
});

test("处理订单：必须同源 + JSON，GET 不允许", async () => {
  const cookie = await loginAsAdmin();
  const o = seed();
  assert.equal((await upd(cookie, { id: o.id, action: "accept" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/api/admin/update-order", { method: "POST", cookie, rawBody: "id=1", contentType: "text/plain" })).status, 415);
  assert.equal((await call(`/api/admin/update-order?id=${o.id}&action=accept`, { cookie })).status, 405);
  assert.equal(find(o.id).status, "pending");
});

test("完整流程：接单 → 报价 → 开始维修 → 填实收 → 完成，每步写状态日志", async () => {
  const cookie = await loginAsAdmin();
  const o = seed();
  let r = await upd(cookie, { id: o.id, action: "accept" });
  assert.equal(r.status, 200); assert.equal(r.json.order.status, "accepted");
  r = await upd(cookie, { id: o.id, action: "save", quoted_price: "80", admin_note: "  需要重装系统  " });
  assert.equal(r.status, 200);
  assert.equal(find(o.id).quoted_price, 80); assert.equal(find(o.id).admin_note, "需要重装系统");
  r = await upd(cookie, { id: o.id, action: "start" });
  assert.equal(r.json.order.status, "repairing");
  r = await upd(cookie, { id: o.id, action: "complete", final_price: 60.5 });
  assert.equal(r.status, 200); assert.equal(r.json.order.status, "completed"); assert.equal(find(o.id).final_price, 60.5);
  const ev = fake.state.events.filter((e) => e.order_id === o.id).map((e) => `${e.from_status}>${e.to_status}:${e.actor}`);
  assert.deepEqual(ev, ["pending>accepted:admin", "accepted>repairing:admin", "repairing>completed:admin"]);
  assert.ok(!JSON.stringify(r.json).includes("cancel_token_hash"));
});

test("拒单：必须填原因，原因写入订单和日志", async () => {
  const cookie = await loginAsAdmin();
  const o = seed();
  assert.equal((await upd(cookie, { id: o.id, action: "reject" })).status, 400);
  assert.equal((await upd(cookie, { id: o.id, action: "reject", reason: "   " })).status, 400);
  assert.equal((await upd(cookie, { id: o.id, action: "reject", reason: "x".repeat(501) })).status, 400);
  assert.equal(find(o.id).status, "pending");
  const r = await upd(cookie, { id: o.id, action: "reject", reason: "不在服务范围" });
  assert.equal(r.status, 200);
  assert.equal(find(o.id).reject_reason, "不在服务范围");
  assert.equal(fake.state.events[0].note, "不在服务范围");
});

test("非法状态流转全部被拒绝（409），订单不变", async () => {
  const cookie = await loginAsAdmin();
  const cases = [
    ["completed", "accept"], ["completed", "start"], ["completed", "cancel"], ["cancelled", "accept"], ["rejected", "accept"],
    ["pending", "start"], ["pending", "complete"], ["accepted", "complete"], ["accepted", "accept"], ["repairing", "reject"],
  ];
  for (const [from, action] of cases) {
    const o = seed({ status: from, final_price: 10, quoted_price: 10 });
    const r = await upd(cookie, { id: o.id, action, reason: "x", final_price: 10 });
    assert.equal(r.status, 409, `${from} → ${action} 应被拒绝`);
    assert.equal(find(o.id).status, from);
  }
  assert.equal(fake.state.events.length, 0);
});

test("完成订单必须有实收金额；免费填 0 可以", async () => {
  const cookie = await loginAsAdmin();
  const o = seed({ status: "repairing" });
  assert.equal((await upd(cookie, { id: o.id, action: "complete" })).status, 400);
  assert.equal(find(o.id).status, "repairing");
  assert.equal((await upd(cookie, { id: o.id, action: "complete", final_price: 0 })).status, 200);
  assert.equal(find(o.id).final_price, 0);
});

test("价格校验：非法值全部拒绝；待处理订单不能填价格", async () => {
  const cookie = await loginAsAdmin();
  const o = seed({ status: "accepted" });
  for (const bad of [-1, "-5", "abc", "1e3", 100000, "99999.999", "1.234", {}, [], true, "NaN", "Infinity", "0x10"]) {
    assert.equal((await upd(cookie, { id: o.id, action: "save", quoted_price: bad })).status, 400, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.equal(find(o.id).quoted_price, null);
  assert.equal((await upd(cookie, { id: o.id, action: "save", quoted_price: "99999.99" })).status, 200);
  assert.equal((await upd(cookie, { id: o.id, action: "save", quoted_price: "" })).status, 200);
  assert.equal(find(o.id).quoted_price, null);
  const p = seed();
  assert.equal((await upd(cookie, { id: p.id, action: "save", quoted_price: 50 })).status, 400);
});

test("备注：超长拒绝；只允许白名单字段，status/token 等字段被忽略", async () => {
  const cookie = await loginAsAdmin();
  const o = seed({ status: "accepted" });
  assert.equal((await upd(cookie, { id: o.id, action: "save", admin_note: "好".repeat(1001) })).status, 400);
  const before = o.cancel_token_hash;
  const r = await upd(cookie, { id: o.id, action: "save", admin_note: "ok", status: "completed", cancel_token_hash: "0".repeat(64), phone: "13900000000", student_name: "改名" });
  assert.equal(r.status, 200);
  const now = find(o.id);
  assert.equal(now.status, "accepted"); assert.equal(now.cancel_token_hash, before);
  assert.equal(now.phone, o.phone); assert.equal(now.student_name, "测试同学");
  assert.equal((await upd(cookie, { id: o.id, action: "save" })).status, 400, "没有任何内容可保存");
});

test("参数错误：编号格式、不存在的订单、未知动作、坏 JSON", async () => {
  const cookie = await loginAsAdmin();
  assert.equal((await upd(cookie, { id: "1' or '1'='1", action: "accept" })).status, 400);
  assert.equal((await upd(cookie, { id: randomUUID(), action: "accept" })).status, 404);
  const o = seed();
  assert.equal((await upd(cookie, { id: o.id, action: "delete" })).status, 400);
  assert.equal((await upd(cookie, { id: o.id, action: "__proto__" })).status, 400);
  assert.equal((await call("/api/admin/update-order", { method: "POST", cookie, rawBody: "{bad" })).status, 400);
  assert.equal((await call("/api/admin/update-order", { method: "POST", cookie, rawBody: "[]" })).status, 400);
});

test("学生在管理员操作的瞬间取消：管理员的接单失败（409），不会把已取消订单改回已接单", async () => {
  const cookie = await loginAsAdmin();
  const o = seed();
  fake.state.hooks.beforePatch = (st) => { st.orders.find((x) => x.id === o.id).status = "cancelled"; };
  const r = await upd(cookie, { id: o.id, action: "accept" });
  fake.state.hooks.beforePatch = null;
  assert.equal(r.status, 409);
  assert.equal(find(o.id).status, "cancelled");
  assert.equal(fake.state.events.length, 0, "失败的操作不能留下日志");
});

test("管理员取消：待处理/已接单/维修中可取消，原因写日志", async () => {
  const cookie = await loginAsAdmin();
  for (const st of ["pending", "accepted", "repairing"]) {
    const o = seed({ status: st });
    const r = await upd(cookie, { id: o.id, action: "cancel", reason: "学生没来取" });
    assert.equal(r.status, 200); assert.equal(find(o.id).status, "cancelled");
  }
  assert.ok(fake.state.events.every((e) => e.note === "学生没来取" && e.actor === "admin"));
});

test("访问令牌过期时处理订单返回 401（页面会自动续期后重试）", async () => {
  const cookie = await loginAsAdmin();
  const o = seed();
  for (const t of fake.state.tokens.values()) t.expired = true;
  assert.equal((await upd(cookie, { id: o.id, action: "accept" })).status, 401);
  assert.equal(find(o.id).status, "pending");
});
