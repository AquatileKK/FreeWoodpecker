// 本机冒烟测试：向正在运行的本地网站提交一条【虚构】报修单（带一张 1x1 的测试图片）。
// 先在另一个终端运行 netlify dev，再运行：  node tests/smoke-submit.mjs
// 注意：这会在你真实的 Supabase 测试库里创建一条测试订单，测完请在后台删除。

const base = process.env.BASE_URL || "http://localhost:8888";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

const fd = new FormData();
fd.append("name", "测试同学");
fd.append("phone", "13800000000");
fd.append("building", "测试楼");
fd.append("room", "000");
fd.append("service_mode", "lobby_handoff");
fd.append("preferred_time", "测试时间，请忽略");
fd.append("description", "这是一条自动冒烟测试订单（虚构数据），测完请删除。");
fd.append("images", new File([png], "test.png", { type: "image/png" }));

const res = await fetch(`${base}/api/submit-order`, { method: "POST", body: fd });
const data = await res.json().catch(() => ({}));

console.log("HTTP 状态:", res.status);
console.log(data);
if (res.status === 201) {
  console.log("\n✅ 提交成功。请去 Supabase 后台检查：");
  console.log("   1) Table Editor → orders：有一条订单，cancel_token_hash 是一串 64 位字母数字（不是链接里的内容）");
  console.log("   2) Table Editor → order_images：有一条图片记录");
  console.log("   3) Storage → repair-images：有一个以订单 id 命名的文件夹，里面有图片");
} else {
  console.log("\n❌ 没有成功，请把上面的输出发给我。");
  process.exit(1);
}
