// 取消接口测试：从“学生提交”到“学生取消”的完整流程，使用假 Supabase 和虚构数据。
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startFakeSupabase, SERVICE_KEY } from "./helpers/fake-supabase.mjs";

let fake, submit, cancel;
before(async () => {
  fake = await startFakeSupabase();
  process.env.SUPABASE_URL = `http://127.0.0.1:${fake.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  ({ default: submit } = await import("../netlify/functions/submit-order.mjs"));
  ({ default: cancel } = await import("../netlify/functions/cancel.mjs"));
});
after(() => fake.close());
beforeEach(() => {
  fake.state.orders.length = 0; fake.state.images.length = 0; fake.state.events.length = 0;
  fake.state.files.clear(); fake.state.hooks.beforePatch = null;
});

let phoneSeq = 0;
async function createOrder() {
  const fd = new FormData();
  fd.append("name", "测试同学甲");
  fd.append("phone", `1380000${String(1000 + phoneSeq++)}`);
  fd.append("building", "测试楼1");
  fd.append("room", "101");
  fd.append("service_mode", "lobby_handoff");
  fd.append("preferred_time", "今晚 7 点以后");
  fd.append("description", "开机黑屏（虚构测试数据）");
  const res = await submit(new Request("http://localhost:8888/api/submit-order", { method: "POST", body: fd }));
  assert.equal(res.status, 201);
  const data = await res.json();
  const token = new URLSearchParams(new URL(data.cancelUrl).hash.slice(1)).get("t");
  return { token, orderNo: data.orderNo };
}

const post = async (body, { method = "POST", raw } = {}) => {
  const res = await cancel(
    new Request("http://localhost:8888/api/cancel", {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined,
    })
  );
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
};

test("完整流程：提交 → 查询 → 确认取消", async () => {
  const { token, orderNo } = await createOrder();

  const look = await post({ token });
  assert.equal(look.status, 200);
  assert.equal(look.json.orderNo, orderNo);
  assert.equal(look.json.status, "pending");
  assert.equal(look.json.canCancel, true);
  assert.equal(fake.state.orders[0].status, "pending", "只查询不应改变订单");

  const done = await post({ token, confirm: true });
  assert.equal(done.status, 200);
  assert.equal(done.json.status, "cancelled");
  assert.equal(fake.state.orders[0].status, "cancelled");
  assert.ok(fake.state.orders[0].cancelled_at);

  const ev = fake.state.events.at(-1);
  assert.deepEqual([ev.from_status, ev.to_status, ev.actor], ["pending", "cancelled", "student"]);
});

test("查询结果不包含姓名、手机号、宿舍等个人信息", async () => {
  const { token } = await createOrder();
  const r = await post({ token });
  assert.deepEqual(Object.keys(r.json).sort(), ["canCancel", "createdAt", "orderNo", "status"]);
  for (const s of ["测试同学", "13800", "测试楼", "101"]) assert.ok(!r.text.includes(s));
});

test("重复取消：第二次返回 409，不会再记一条日志", async () => {
  const { token } = await createOrder();
  await post({ token, confirm: true });
  const eventsAfterFirst = fake.state.events.length;
  const again = await post({ token, confirm: true });
  assert.equal(again.status, 409);
  assert.equal(fake.state.events.length, eventsAfterFirst);
  const look = await post({ token });
  assert.equal(look.json.canCancel, false);
});

for (const [status, allowed] of [
  ["pending", true], ["accepted", true],
  ["repairing", false], ["completed", false], ["rejected", false], ["cancelled", false],
]) {
  test(`状态“${status}”${allowed ? "可以" : "不可以"}在线取消`, async () => {
    const { token } = await createOrder();
    fake.state.orders[0].status = status;
    const r = await post({ token, confirm: true });
    assert.equal(r.status, allowed ? 200 : 409);
    assert.equal(fake.state.orders[0].status, allowed ? "cancelled" : status);
  });
}

test("竞态：查询后、更新前管理员开始维修，取消必须失败且不覆盖状态", async () => {
  const { token } = await createOrder();
  fake.state.hooks.beforePatch = (s) => { s.orders[0].status = "repairing"; };
  const r = await post({ token, confirm: true });
  assert.equal(r.status, 409);
  assert.equal(fake.state.orders[0].status, "repairing");
  assert.equal(fake.state.orders[0].cancelled_at, null);
});

test("无效 Token 与不存在的 Token 返回完全相同的 404", async () => {
  await createOrder();
  const fakeButValidFormat = "A".repeat(43);
  const a = await post({ token: fakeButValidFormat });
  const b = await post({ token: "too-short" });
  const c = await post({ token: 12345 });
  const d = await post({});
  for (const r of [a, b, c, d]) assert.equal(r.status, 404);
  assert.equal(a.text, b.text);
  assert.equal(b.text, c.text);
  assert.equal(c.text, d.text);
});

test("Token 的哈希错一位就找不到订单；知道订单号也取消不了", async () => {
  const { token, orderNo } = await createOrder();
  const wrong = (token[0] === "A" ? "B" : "A") + token.slice(1);
  assert.equal((await post({ token: wrong, confirm: true })).status, 404);
  assert.equal((await post({ token: orderNo, confirm: true })).status, 404);
  assert.equal(fake.state.orders[0].status, "pending");
});

test("其他学生的 Token 只能操作自己的订单", async () => {
  const a = await createOrder();
  const b = await createOrder();
  await post({ token: a.token, confirm: true });
  const statuses = fake.state.orders.map((o) => o.status);
  assert.deepEqual(statuses, ["cancelled", "pending"]);
  assert.ok(b.token !== a.token);
});

test("请求格式：只允许 POST；非 JSON 返回 400", async () => {
  assert.equal((await post({}, { method: "GET" })).status, 405);
  assert.equal((await post(null, { raw: "不是json" })).status, 400);
  assert.equal((await post(null, { raw: "null" })).status, 400);
});

test("响应不泄露管理员密钥；数据库只有哈希没有 Token 原文", async () => {
  const { token } = await createOrder();
  const r = await post({ token, confirm: true });
  assert.ok(!r.text.includes(SERVICE_KEY));
  assert.equal(fake.state.orders[0].cancel_token_hash, createHash("sha256").update(token).digest("hex"));
  assert.ok(!JSON.stringify(fake.state).includes(token));
});

test("环境变量缺失：返回通用错误", async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await post({ token: "A".repeat(43) });
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes("SUPABASE"));
  } finally { process.env.SUPABASE_SERVICE_ROLE_KEY = saved; }
});
