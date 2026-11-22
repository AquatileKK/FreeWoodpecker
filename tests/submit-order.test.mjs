// 提交报修接口测试：用本机“假 Supabase 服务器”代替真实数据库，所有数据都是虚构的。
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";

const SERVICE_KEY = "sb_secret_FAKE_KEY_FOR_TESTS_ONLY";

// ---------- 假 Supabase ----------
let server, state;

function resetState() {
  state = { orders: [], images: [], events: [], files: new Map(), uploads: 0, failUploadAt: null, seq: 0 };
}

function startFake() {
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, "http://fake");
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === undefined ? "" : JSON.stringify(obj));
      };
      if (req.headers.apikey !== SERVICE_KEY) return send(401, { message: "bad key" });

      const p = u.pathname;
      if (p === "/rest/v1/orders" && req.method === "GET") {
        const phone = (u.searchParams.get("phone") || "").replace(/^eq\./, "");
        const since = (u.searchParams.get("created_at") || "").replace(/^gte\./, "");
        const limit = Number(u.searchParams.get("limit") || 100);
        const rows = state.orders
          .filter((o) => o.phone === phone && o.created_at >= since)
          .slice(0, limit)
          .map((o) => ({ id: o.id }));
        return send(200, rows);
      }
      if (p === "/rest/v1/orders" && req.method === "POST") {
        const row = JSON.parse(body.toString());
        if (!/^[0-9a-f]{64}$/.test(row.cancel_token_hash || "")) return send(400, { code: "23514" });
        const saved = {
          ...row,
          id: randomUUID(),
          order_no: `JX261121-${String(++state.seq).padStart(4, "0")}`,
          status: "pending",
          created_at: new Date().toISOString(),
        };
        state.orders.push(saved);
        return send(201, [{ id: saved.id, order_no: saved.order_no }]);
      }
      if (p === "/rest/v1/orders" && req.method === "DELETE") {
        const id = (u.searchParams.get("id") || "").replace(/^eq\./, "");
        state.orders = state.orders.filter((o) => o.id !== id);
        state.images = state.images.filter((i) => i.order_id !== id);
        return send(204);
      }
      if (p === "/rest/v1/order_images" && req.method === "POST") {
        state.images.push(...JSON.parse(body.toString()));
        return send(201);
      }
      if (p === "/rest/v1/order_events" && req.method === "POST") {
        state.events.push(JSON.parse(body.toString()));
        return send(201);
      }
      if (p.startsWith("/storage/v1/object/repair-images/") && req.method === "POST") {
        state.uploads++;
        if (state.failUploadAt === state.uploads) return send(500, { error: "boom" });
        state.files.set(decodeURIComponent(p.replace("/storage/v1/object/repair-images/", "")), {
          contentType: req.headers["content-type"],
          size: body.length,
        });
        return send(200, { Key: "ok" });
      }
      if (p === "/storage/v1/object/repair-images" && req.method === "DELETE") {
        for (const f of JSON.parse(body.toString()).prefixes) state.files.delete(f);
        return send(200, []);
      }
      return send(404, { message: "not found" });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

let handler;
before(async () => {
  const port = await startFake();
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  ({ default: handler } = await import("../netlify/functions/submit-order.mjs"));
});
after(() => server.close());
beforeEach(() => resetState());

// ---------- 测试辅助 ----------
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(20)]);

const goodFields = () => ({
  name: "测试同学甲",
  phone: "13800000001",
  building: "测试楼1",
  room: "101",
  service_mode: "lobby_handoff",
  preferred_time: "今晚 7 点以后",
  description: "开机黑屏，风扇转（虚构测试数据）",
});

function makeRequest({ fields = goodFields(), images = [], method = "POST" } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const img of images) fd.append("images", new File([img.bytes], img.name ?? "a.jpg", { type: img.type || "image/jpeg" }));
  return new Request("http://localhost:8888/api/submit-order", {
    method,
    body: method === "POST" ? fd : undefined,
  });
}
const call = async (opts) => {
  const res = await handler(makeRequest(opts));
  return { status: res.status, text: await res.clone().text(), json: await res.json().catch(() => null) };
};
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ---------- 成功路径 ----------
test("成功提交：返回订单号和取消链接，图片落入私有桶", async () => {
  const r = await call({
    images: [
      { bytes: PNG, name: "x.png", type: "image/png" },
      { bytes: JPG, name: "y.jpg" },
      { bytes: WEBP, name: "z.webp", type: "image/webp" },
    ],
  });
  assert.equal(r.status, 201);
  assert.match(r.json.orderNo, /^JX\d{6}-\d{4}$/);
  assert.equal(r.json.imageCount, 3);
  assert.equal(state.orders.length, 1);
  assert.equal(state.images.length, 3);
  assert.equal(state.files.size, 3);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].to_status, "pending");
  assert.equal(state.events[0].actor, "student");
  // 文件路径以订单 id 开头，文件名是随机的，不含学生上传的文件名
  for (const path of state.files.keys()) {
    assert.ok(path.startsWith(state.orders[0].id + "/"));
    assert.ok(!path.includes("x.png") && !path.includes("y.jpg"));
  }
  assert.deepEqual([...state.files.values()].map((f) => f.contentType).sort(), ["image/jpeg", "image/png", "image/webp"]);
});

test("取消 Token：URL 安全、数据库只存哈希、原文不落库", async () => {
  const r = await call();
  assert.equal(r.status, 201);
  const url = new URL(r.json.cancelUrl);
  assert.equal(url.pathname, "/cancel.html");
  const token = new URLSearchParams(url.hash.slice(1)).get("t");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(state.orders[0].cancel_token_hash, sha256(token));
  // 把整个“数据库+存储”序列化后搜索，原文 Token 不应出现在任何地方
  assert.ok(!JSON.stringify([...state.orders, ...state.images, ...state.events, [...state.files.keys()]]).includes(token));
});

test("两次提交的 Token 互不相同", async () => {
  const a = await call({ fields: { ...goodFields(), phone: "13800000011" } });
  const b = await call({ fields: { ...goodFields(), phone: "13800000012" } });
  assert.notEqual(a.json.cancelUrl, b.json.cancelUrl);
  assert.notEqual(state.orders[0].cancel_token_hash, state.orders[1].cancel_token_hash);
});

test("不带图片也能提交", async () => {
  const r = await call();
  assert.equal(r.status, 201);
  assert.equal(r.json.imageCount, 0);
});

test("手机号中的空格和横线会被自动清理", async () => {
  const r = await call({ fields: { ...goodFields(), phone: "138-0000 0001" } });
  assert.equal(r.status, 201);
  assert.equal(state.orders[0].phone, "13800000001");
});

// ---------- 非法输入 ----------
for (const [label, patch, field] of [
  ["手机号位数不对", { phone: "12345" }, "phone"],
  ["手机号含字母", { phone: "1380000000a" }, "phone"],
  ["姓名为空", { name: "   " }, "name"],
  ["姓名超过 30 字", { name: "长".repeat(31) }, "name"],
  ["楼栋为空", { building: "" }, "building"],
  ["房间号超长", { room: "1".repeat(21) }, "room"],
  ["描述太短", { description: "坏了" }, "description"],
  ["描述超过 1000 字", { description: "坏".repeat(1001) }, "description"],
  ["描述含控制字符", { description: "abc\u0000def" }, "description"],
  ["没有选维修方式", { service_mode: "" }, "service_mode"],
  ["维修方式不是合法取值", { service_mode: "hack" }, "service_mode"],
  ["预约时间为空", { preferred_time: "   " }, "preferred_time"],
  ["预约时间超过 50 字", { preferred_time: "长".repeat(51) }, "preferred_time"],
  ["预约时间含控制字符", { preferred_time: "今晚\u0000" }, "preferred_time"],
]) {
  test(`拒绝：${label}`, async () => {
    const r = await call({ fields: { ...goodFields(), ...patch } });
    assert.equal(r.status, 400);
    assert.equal(r.json.field, field);
    assert.equal(state.orders.length, 0);
  });
}

test("字符按“个”计数：3 个 emoji 太短，5 个可以", async () => {
  assert.equal((await call({ fields: { ...goodFields(), description: "😀😀😀" } })).status, 400);
  assert.equal((await call({ fields: { ...goodFields(), description: "😀😀😀😀😀" } })).status, 201);
});

test("维修方式与预约时间会入库；楼栋可以是手动输入的任意文字", async () => {
  const r = await call({
    fields: { ...goodFields(), service_mode: "visit_room", preferred_time: "  周日   下午  ", building: "西1", room: "114" },
  });
  assert.equal(r.status, 201);
  assert.equal(state.orders[0].service_mode, "visit_room");
  assert.equal(state.orders[0].preferred_time, "周日 下午", "多余空格会被整理");
  assert.equal(state.orders[0].building, "西1");
  assert.equal(state.orders[0].room, "114");
});

// ---------- 图片安全 ----------
test("拒绝：伪装成 jpg 的文本文件（以真实内容判断）", async () => {
  const r = await call({ images: [{ bytes: Buffer.from("<script>alert(1)</script>"), name: "evil.jpg", type: "image/jpeg" }] });
  assert.equal(r.status, 400);
  assert.equal(state.orders.length, 0);
  assert.equal(state.files.size, 0);
});

test("拒绝：GIF 格式（即使文件头合法）", async () => {
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(50)]);
  const r = await call({ images: [{ bytes: gif, name: "a.gif", type: "image/gif" }] });
  assert.equal(r.status, 400);
  assert.equal(state.orders.length, 0);
});

test("拒绝：单张图片超过 1.5MB", async () => {
  const big = Buffer.concat([JPG, Buffer.alloc(1.5 * 1024 * 1024)]);
  const r = await call({ images: [{ bytes: big }] });
  assert.equal(r.status, 400);
  assert.equal(state.orders.length, 0);
});

test("拒绝：超过 3 张图片", async () => {
  const r = await call({ images: [1, 2, 3, 4].map(() => ({ bytes: JPG })) });
  assert.equal(r.status, 400);
  assert.equal(state.orders.length, 0);
});

test("拒绝：图片文件为空但有文件名", async () => {
  const r = await call({ images: [{ bytes: Buffer.alloc(0), name: "empty.jpg" }] });
  assert.equal(r.status, 400);
});

test("浏览器没选图片时发来的空文件会被忽略", async () => {
  const r = await call({ images: [{ bytes: Buffer.alloc(0), name: "" }] });
  assert.equal(r.status, 201);
  assert.equal(r.json.imageCount, 0);
});

// ---------- 请求层面 ----------
test("只允许 POST", async () => {
  const res = await handler(new Request("http://localhost:8888/api/submit-order", { method: "GET" }));
  assert.equal(res.status, 405);
});

test("非 multipart 请求被拒绝", async () => {
  const res = await handler(
    new Request("http://localhost:8888/api/submit-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  );
  assert.equal(res.status, 400);
});

test("声明的请求体过大返回 413", async () => {
  const res = await handler(
    new Request("http://localhost:8888/api/submit-order", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(6 * 1024 * 1024) },
      body: "--x--",
    })
  );
  assert.equal(res.status, 413);
});

test("蜜罐：机器人填了隐藏字段，假装成功但不创建订单", async () => {
  const r = await call({ fields: { ...goodFields(), website: "http://spam.example" } });
  assert.equal(r.status, 201);
  assert.equal(state.orders.length, 0);
});

// ---------- 限频 ----------
test("同一手机号 1 小时内第 4 单被限频（429），其他手机号不受影响", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call()).status, 201);
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(state.orders.length, 3);
  assert.equal((await call({ fields: { ...goodFields(), phone: "13800000002" } })).status, 201);
});

// ---------- 失败回滚 ----------
test("第 2 张图片上传失败：订单和已传的图片全部回滚", async () => {
  state.failUploadAt = 2;
  const r = await call({ images: [{ bytes: PNG, name: "a.png" }, { bytes: JPG }, { bytes: WEBP }] });
  assert.equal(r.status, 500);
  assert.equal(state.orders.length, 0);
  assert.equal(state.images.length, 0);
  assert.equal(state.files.size, 0);
});

// ---------- 密钥与配置 ----------
test("响应里不包含管理员密钥", async () => {
  const ok = await call({ images: [{ bytes: PNG, name: "a.png" }] });
  assert.ok(!ok.text.includes(SERVICE_KEY));
  const bad = await call({ fields: { ...goodFields(), phone: "1" } });
  assert.ok(!bad.text.includes(SERVICE_KEY));
});

test("每个发往 Supabase 的请求都带了管理员密钥（失败会被假服务器 401 拦下）", async () => {
  const r = await call({ images: [{ bytes: PNG, name: "a.png" }] });
  assert.equal(r.status, 201);
});

test("环境变量缺失：返回通用错误，不泄露细节", async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await call();
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes("SUPABASE"));
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

test("SUPABASE_URL 使用 http（非本机）会被视为配置错误", async () => {
  const saved = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "http://evil.example.com";
  try {
    assert.equal((await call()).status, 500);
  } finally {
    process.env.SUPABASE_URL = saved;
  }
});
