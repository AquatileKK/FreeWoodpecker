// 上线后检查：对已经部署到网上的网站做一轮“体检”。
// 用法：node tests/live-check.mjs https://你的站点.netlify.app
//
// 所有检查都【不会创建订单、不会修改任何数据】：
//   - 提交接口只发一个空表单（会在校验阶段被拒绝）
//   - 取消接口只用一个随便编的 Token 去查询（查不到，返回 404）

const arg = process.argv[2] || "";
let base;
try {
  const u = new URL(arg);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error("need https");
  base = u.origin;
} catch {
  console.error("\n用法：node tests/live-check.mjs https://你的站点.netlify.app\n（网址必须以 https:// 开头）\n");
  process.exit(2);
}

let failed = 0;
const times = [];
const out = (ok, name, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "✅ 通过" : "❌ 失败"}  ${name}${detail ? "  — " + detail : ""}`);
};

async function req(path, init) {
  const t0 = Date.now();
  try {
    const res = await fetch(base + path, { redirect: "manual", ...init });
    const text = await res.text();
    times.push(Date.now() - t0);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, json };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: "", json: null, error: e.cause?.code || e.message };
  }
}

console.log(`\n正在检查：${base}\n`);

// 1. 页面都能打开
const pages = {};
for (const [p, mustHave] of [["/", "鸡西大学校园电脑维修"], ["/report.html", "电脑报修"], ["/privacy.html", "隐私与服务说明"], ["/cancel.html", "取消报修"]]) {
  const r = await req(p);
  pages[p] = r;
  out(r.status === 200 && r.text.includes(mustHave), `页面可以打开 ${p}`, r.status ? `HTTP ${r.status}` : "连接失败：" + r.error);
}
for (const p of ["/report.js", "/cancel.js"]) {
  const r = await req(p);
  pages[p] = r;
  out(r.status === 200 && r.text.length > 100, `脚本可以加载 ${p}`, `HTTP ${r.status}`);
}

// 2. 健康检查
{
  const r = await req("/api/health");
  out(r.status === 200 && r.json?.ok === true, "接口服务已部署 /api/health", `HTTP ${r.status}`);
  out(r.json?.supabaseConfigured === true, "Netlify 里已配置 Supabase 环境变量", r.json?.supabaseConfigured === true ? "" : "还没配置或名字写错");
  out(!/sb_secret_|eyJ[A-Za-z0-9_-]{20,}/.test(r.text), "健康检查没有泄露任何密钥");
}

// 3. 安全响应头
{
  const h = pages["/"].headers;
  out(h.get("x-content-type-options") === "nosniff", "安全头 X-Content-Type-Options");
  out((h.get("x-frame-options") || "").toUpperCase() === "DENY", "安全头 X-Frame-Options（防被嵌入别的网页）");
  out(!!h.get("referrer-policy"), "安全头 Referrer-Policy");
}

// 4. 敏感文件不能被外人下载
for (const p of ["/.env", "/.env.example", "/netlify.toml", "/package.json", "/supabase/migrations/0001_init.sql", "/tests/rls-check.mjs", "/netlify/functions/submit-order.mjs", "/netlify/lib/supabase.mjs"]) {
  const r = await req(p);
  out(r.status !== 200, `外人无法下载 ${p}`, `HTTP ${r.status}`);
}

// 5. 公开页面里没有密钥
{
  const all = Object.values(pages).map((r) => r.text).join("\n");
  out(!/sb_secret_[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{20,}|service[_-]?role/i.test(all), "公开页面和脚本里没有出现管理员密钥");
}

// 6. 接口行为
{
  const r = await req("/api/submit-order");
  out(r.status === 405, "提交接口拒绝 GET 请求", `HTTP ${r.status}`);
}
{
  const r = await req("/api/submit-order", { method: "POST", body: new FormData() });
  out(r.status === 400 && r.json?.field === "name", "提交接口对空表单返回 400（不会创建订单）", `HTTP ${r.status}`);
}
{
  const r = await req("/api/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "x" }) });
  out(r.status === 404, "取消接口对无效链接返回 404", `HTTP ${r.status}`);
}
{
  // 格式正确但不存在的 Token：会真正去查一次数据库。返回 404 = 数据库连通、密钥有效、权限正确
  const r = await req("/api/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "A".repeat(43) }) });
  out(r.status === 404, "服务器能连上 Supabase 数据库，密钥与权限正常", r.status === 404 ? "" : `HTTP ${r.status}（500 表示连不上或密钥/权限有问题）`);
}

// 7. 访问速度
if (times.length) {
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slow = sorted.at(-1);
  console.log(`\nℹ️  访问速度：中位数 ${median} 毫秒，最慢 ${slow} 毫秒。`);
  if (median > 2000) console.log("⚠️  速度偏慢。国内网络访问境外服务器可能不稳定，请在校园网和手机流量下都实际打开试试。");
}

console.log(failed === 0 ? "\n🎉 全部通过。\n" : `\n⚠️ 有 ${failed} 项未通过，请把上面的输出发给我。\n`);
process.exit(failed === 0 ? 0 : 1);
