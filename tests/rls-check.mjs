// 权限自检：用“公开密钥”模拟任何一个陌生人，确认他读不到、写不了任何数据。
// 用法（Windows cmd，在项目文件夹里）：
//   set SUPABASE_URL=https://你的项目.supabase.co
//   set SUPABASE_ANON_KEY=你的公开密钥(anon 或 publishable)
//   node tests/rls-check.mjs
//
// 注意：这里只能使用“公开密钥”，严禁使用 service_role / secret 密钥。

const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_ANON_KEY || "";

function die(msg) {
  console.error("\n❌ " + msg + "\n");
  process.exit(2);
}

if (!url || !key) die("缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY 环境变量，请先用 set 命令设置。");
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) die("SUPABASE_URL 格式不对，应类似 https://xxxx.supabase.co");

// 安全保护：如果误填了管理员密钥，立刻中止，不发出任何请求
function looksLikeSecretKey(k) {
  if (k.startsWith("sb_secret_")) return true;
  const parts = k.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      return payload.role === "service_role";
    } catch {
      return false;
    }
  }
  return false;
}
if (looksLikeSecretKey(key)) {
  die("你填的是管理员(service_role/secret)密钥！已中止。请换成公开的 anon / publishable 密钥，并尽快到 Supabase 后台重置刚才暴露的密钥。");
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };
let failed = 0;

async function call(method, path, { body, extra } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: { ...headers, ...(extra || {}) },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

function report(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "✅ 通过" : "❌ 失败"}  ${name}${detail ? "  — " + detail : ""}`);
}

// 读表：只有“被拒绝(401/403)”或“200 且空数组”才算安全。404 说明表不存在（还没建表）。
async function checkTableRead(table) {
  const r = await call("GET", `/rest/v1/${table}?select=*&limit=5`);
  if (r.status === 404) return report(`匿名读取 ${table}`, false, "表不存在，请先运行建表脚本");
  const denied = r.status === 401 || r.status === 403;
  const emptyOk = r.status === 200 && Array.isArray(r.json) && r.json.length === 0;
  const leaked = r.status === 200 && Array.isArray(r.json) && r.json.length > 0;
  report(`匿名读取 ${table}`, (denied || emptyOk) && !leaked, `HTTP ${r.status}`);
}

async function checkTableWrite(table, row) {
  const r = await call("POST", `/rest/v1/${table}`, {
    body: JSON.stringify(row),
    extra: { "Content-Type": "application/json", Prefer: "return=minimal" },
  });
  report(`匿名写入 ${table}`, r.status >= 400 && r.status !== 404, `HTTP ${r.status}`);
}

console.log(`\n正在检查：${url}\n`);

for (const t of ["orders", "order_images", "order_events"]) await checkTableRead(t);

await checkTableWrite("orders", {
  student_name: "权限测试",
  phone: "13800000000",
  building: "测试楼",
  room: "000",
  description: "这是一条自动权限测试，不应写入成功",
  cancel_token_hash: "0".repeat(64),
});

// 存储：私有桶不能公开访问、不能被匿名列出、不能被匿名上传
{
  const r = await call("GET", "/storage/v1/object/public/repair-images/not-exist.jpg");
  report("图片桶不能公开访问", r.status !== 200, `HTTP ${r.status}`);
}
{
  const r = await call("POST", "/storage/v1/object/list/repair-images", {
    body: JSON.stringify({ prefix: "", limit: 10 }),
    extra: { "Content-Type": "application/json" },
  });
  const listed = r.status === 200 && Array.isArray(r.json) && r.json.length > 0;
  report("匿名不能列出图片桶内容", !listed, `HTTP ${r.status}`);
}
{
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64"
  );
  const r = await call("POST", "/storage/v1/object/repair-images/rls-check-should-fail.png", {
    body: png,
    extra: { "Content-Type": "image/png" },
  });
  report("匿名不能上传图片", r.status >= 400, `HTTP ${r.status}`);
}

console.log(failed === 0 ? "\n🎉 全部通过：陌生人无法读取或写入你的数据。\n" : `\n⚠️ 有 ${failed} 项未通过，请把上面的输出发给我。\n`);
process.exit(failed === 0 ? 0 : 1);
