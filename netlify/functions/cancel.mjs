// 学生取消报修：POST /api/cancel，JSON 请求体 { token, confirm? }
//   confirm 不传/为 false：只查询订单状态（不修改任何东西），给取消页面展示用
//   confirm 为 true：确认取消
//
// 安全要点：
//   - 用 Token 的 SHA-256 哈希查订单，数据库里没有 Token 原文
//   - Token 格式不对、Token 不存在，返回完全相同的 404，不让人探测
//   - 返回内容只有订单号、状态、提交时间，不含姓名/手机号/宿舍
//   - 只有“待处理”和“已接单”可以在线取消；已开始维修的需要联系维修点

import { getConfig, createClient } from "../lib/supabase.mjs";
import { hashToken } from "../lib/token.mjs";

const CANCELLABLE = new Set(["pending", "accepted"]);
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const BLOCKED_MESSAGE = {
  cancelled: "该订单已经取消过了",
  rejected: "该订单已被维修方拒绝，无需取消",
  repairing: "订单已经在维修中，无法在线取消，请直接联系维修点",
  completed: "订单已经完成，无法取消",
};

const json = (status, body, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });

const NOT_FOUND = () => json(404, { error: "链接无效或已失效" });

export default async (req) => {
  if (req.method !== "POST") {
    return json(405, { error: "请求方式不允许" }, { Allow: "POST" });
  }

  const cfg = getConfig();
  if (!cfg) {
    console.error("cancel: Supabase 环境变量未配置或格式错误");
    return json(500, { error: "服务暂时不可用，请稍后再试", code: "server_misconfigured" });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "请求格式不正确" });
  }
  if (!body || typeof body !== "object") return json(400, { error: "请求格式不正确" });

  const token = typeof body.token === "string" ? body.token : "";
  const confirm = body.confirm === true;
  if (!TOKEN_RE.test(token)) return NOT_FOUND();

  const db = createClient(cfg);
  const tokenHash = hashToken(token);

  let order;
  try {
    order = await db.findOrderByTokenHash(tokenHash);
  } catch (err) {
    console.error("cancel:", err.message);
    return json(500, { error: "服务暂时不可用，请稍后再试" });
  }
  if (!order) return NOT_FOUND();

  const canCancel = CANCELLABLE.has(order.status);

  if (!confirm) {
    return json(200, {
      orderNo: order.order_no,
      status: order.status,
      createdAt: order.created_at,
      canCancel,
    });
  }

  if (!canCancel) {
    return json(409, { error: BLOCKED_MESSAGE[order.status] || "当前状态无法取消", status: order.status });
  }

  let updated;
  try {
    updated = await db.cancelOrder(order.id, order.status);
  } catch (err) {
    console.error("cancel:", err.message);
    return json(500, { error: "取消失败，请稍后再试" });
  }
  if (!updated) {
    // 在我们查询和更新之间，订单状态被别人改了（比如管理员刚刚接单/开始维修）
    return json(409, { error: "订单状态刚刚发生了变化，请刷新页面后再确认" });
  }

  // 日志写入失败不影响取消结果（订单已经取消成功）
  try {
    await db.insertEvent({
      order_id: order.id,
      from_status: order.status,
      to_status: "cancelled",
      actor: "student",
    });
  } catch (err) {
    console.error("cancel: 日志写入失败:", err.message);
  }

  return json(200, { orderNo: order.order_no, status: "cancelled" });
};

export const config = { path: "/api/cancel" };
