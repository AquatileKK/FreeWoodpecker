// PWA 静态检查：manifest、图标、Service Worker 的安全边界、各页面是否正确引用。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(path.join(root, p), "utf8");

test("manifest：字段齐全，图标文件真实存在且尺寸正确", async () => {
  const m = JSON.parse(await read("public/manifest.webmanifest"));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/report.html");
  assert.equal(m.scope, "/");
  assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
  const purposes = m.icons.map((i) => i.purpose);
  assert.ok(purposes.includes("any") && purposes.includes("maskable"));
  for (const icon of m.icons) {
    const buf = await readFile(path.join(root, "public", icon.src));
    assert.equal(buf.subarray(1, 4).toString(), "PNG");
    const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)]; // PNG 头里的宽高
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
  }
});

test("Service Worker：不拦截 /api 和 /admin，只处理 GET 和同源请求", async () => {
  const sw = await read("public/sw.js");
  assert.match(sw, /req\.method !== "GET"\) return/);
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/);
  assert.match(sw, /startsWith\("\/api\/"\)/);
  assert.match(sw, /startsWith\("\/admin"\)/);
  // 预缓存清单里只有静态文件，不能出现 api / admin / 订单相关页面
  const list = sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1];
  assert.ok(!/api|admin|report|cancel/.test(list), "预缓存清单不应包含接口、后台或表单页");
});

test("Service Worker：预缓存的每个文件都真实存在", async () => {
  const sw = await read("public/sw.js");
  const list = [...sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(list.length >= 5);
  for (const f of list) await readFile(path.join(root, "public", f)); // 不存在会抛错，导致 SW 安装失败
});

test("学生页面都引用了 manifest 并注册 SW；后台页面没有", async () => {
  for (const f of ["report", "cancel", "privacy"]) {
    const html = await read(`public/${f}.html`);
    assert.ok(html.includes('rel="manifest"'), `${f} 缺少 manifest`);
    assert.ok(html.includes('src="/pwa.js"'), `${f} 缺少 pwa.js`);
    assert.ok(html.includes("apple-touch-icon"), `${f} 缺少 iOS 图标`);
  }
  const admin = await read("public/admin/index.html");
  assert.ok(!admin.includes("manifest") && !admin.includes("pwa.js"), "后台页面不应被做成可安装应用/注册 SW");
});

test("netlify.toml：sw.js 不缓存", async () => {
  const toml = await read("netlify.toml");
  const block = toml.split("[[headers]]").find((b) => b.includes('for = "/sw.js"'));
  assert.ok(block && /Cache-Control = "no-cache"/.test(block));
});
