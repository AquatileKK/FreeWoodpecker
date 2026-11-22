import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("健康检查函数返回 200 和 JSON", async () => {
  const { default: handler, config } = await import("../netlify/functions/health.mjs");
  const res = await handler(new Request("http://localhost/api/health"));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(config.path, "/api/health");
});

test("健康检查函数不泄露密钥内容", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "SECRET_VALUE_FOR_TEST";
  const { default: handler } = await import("../netlify/functions/health.mjs");
  const text = await (await handler(new Request("http://localhost/api/health"))).text();
  assert.ok(!text.includes("SECRET_VALUE_FOR_TEST"));
  assert.ok(!text.includes("example.supabase.co"));
  assert.equal(JSON.parse(text).supabaseConfigured, true);
});

test("首页存在且适配手机（含 viewport）", async () => {
  const html = await readFile(path.join(root, "public/index.html"), "utf8");
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes("鸡西大学校园电脑维修"));
});

test("public 目录里没有出现 service role 密钥相关字样", async () => {
  const files = await readdir(path.join(root, "public"), { recursive: true });
  for (const f of files) {
    if (!/\.(html|js|css|json|webmanifest)$/.test(f)) continue;
    const text = await readFile(path.join(root, "public", f), "utf8");
    assert.ok(!/service[_-]?role/i.test(text), `${f} 含有 service role 字样`);
  }
});
