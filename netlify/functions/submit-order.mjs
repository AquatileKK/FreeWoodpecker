// 学生提交报修：POST /api/submit-order（multipart/form-data）
// 字段：name, phone, building, room, description, images(0-3 张), website(蜜罐，必须为空)
//
// 流程：校验 → 限频 → 生成取消 Token → 建订单(只存哈希) → 传图 → 记日志；任何一步失败都会回滚。
// 取消链接放在网址 # 后面：浏览器不会把 # 后面的内容发给服务器，也不会写进访问日志或 Referer。

import { randomUUID } from "node:crypto";
import { LIMITS, validateFields, validateImages } from "../lib/validate.mjs";
import { generateCancelToken, hashToken } from "../lib/token.mjs";
import { getConfig, createClient } from "../lib/supabase.mjs";

const MAX_ORDERS_PER_PHONE_PER_HOUR = 3;

const json = (status, body, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });

export default async (req) => {
  if (req.method !== "POST") {
    return json(405, { error: "请求方式不允许" }, { Allow: "POST" });
  }

  const cfg = getConfig();
  if (!cfg) {
    console.error("submit-order: Supabase 环境变量未配置或格式错误");
    return json(500, { error: "服务暂时不可用，请稍后再试", code: "server_misconfigured" });
  }

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return json(400, { error: "请求格式不正确" });
  }
  if (Number(req.headers.get("content-length") || 0) > LIMITS.maxRequestBytes) {
    return json(413, { error: "上传内容过大，请压缩图片后重试" });
  }

  let form;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "请求内容无法解析" });
  }

  const origin = new URL(req.url).origin;

  // 蜜罐：真人看不到这个输入框，机器人会自动填写。假装成功，但不做任何事。
  if (String(form.get("website") || "").trim() !== "") {
    return json(201, {
      orderNo: "JX000000-0000",
      cancelUrl: `${origin}/cancel.html#t=${generateCancelToken()}`,
    });
  }

  const fields = validateFields({
    name: form.get("name"),
    phone: form.get("phone"),
    building: form.get("building"),
    room: form.get("room"),
    service_mode: form.get("service_mode"),
    preferred_time: form.get("preferred_time"),
    description: form.get("description"),
  });
  if (!fields.ok) return json(400, { error: fields.error, field: fields.field });

  // 浏览器没选图片时也会发一个空文件，这里过滤掉
  const imageFiles = form
    .getAll("images")
    .filter((f) => typeof f !== "string" && !(f.size === 0 && !f.name));
  const images = await validateImages(imageFiles);
  if (!images.ok) return json(400, { error: images.error, field: images.field });

  const db = createClient(cfg);

  try {
    // 限频：同一手机号 1 小时内最多 3 单，防止被恶意刷单
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await db.countRecentOrdersByPhone(
      fields.value.phone,
      since,
      MAX_ORDERS_PER_PHONE_PER_HOUR
    );
    if (recent >= MAX_ORDERS_PER_PHONE_PER_HOUR) {
      return json(429, { error: "提交过于频繁，请 1 小时后再试，或直接联系维修点" });
    }
  } catch (err) {
    console.error("submit-order:", err.message);
    return json(500, { error: "服务暂时不可用，请稍后再试" });
  }

  // 取消 Token：原文只返回给这个学生一次，数据库里只有哈希
  const token = generateCancelToken();
  let order;
  try {
    order = await db.insertOrder({ ...fields.value, cancel_token_hash: hashToken(token) });
  } catch (err) {
    console.error("submit-order:", err.message);
    return json(500, { error: "提交失败，请稍后再试" });
  }

  const uploaded = [];
  try {
    const imageRows = [];
    for (const img of images.value) {
      // 文件名由服务器随机生成，不使用学生上传的文件名；扩展名来自真实内容判断
      const path = `${order.id}/${randomUUID()}.${img.ext}`;
      await db.uploadImage(path, img.buffer, img.type);
      uploaded.push(path);
      imageRows.push({
        order_id: order.id,
        storage_path: path,
        content_type: img.type,
        size_bytes: img.size,
      });
    }
    await db.insertImages(imageRows);
    await db.insertEvent({ order_id: order.id, from_status: null, to_status: "pending", actor: "student" });
  } catch (err) {
    console.error("submit-order: 回滚订单:", err.message);
    await db.deleteImages(uploaded).catch(() => {});
    await db.deleteOrder(order.id).catch(() => {});
    return json(500, { error: "提交失败，请稍后再试" });
  }

  return json(201, {
    orderNo: order.order_no,
    cancelUrl: `${origin}/cancel.html#t=${token}`,
    imageCount: uploaded.length,
    notice: "请保存好取消链接：它只显示这一次，丢失后无法找回。",
  });
};

export const config = { path: "/api/submit-order" };
