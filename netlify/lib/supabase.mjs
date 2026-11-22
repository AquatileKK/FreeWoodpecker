// 访问 Supabase 的最小封装：直接使用 Node 自带的 fetch，不需要安装任何第三方包。
// 只在服务端（Netlify Functions）使用，因为这里会用到管理员密钥。

const BUCKET = "repair-images";

// 后台查询用的字段清单：明确列出，绝不包含 cancel_token_hash
const ORDER_LIST_COLUMNS =
  "id,order_no,status,student_name,phone,building,room,service_mode,preferred_time,created_at,quoted_price,final_price";
const ORDER_DETAIL_COLUMNS = `${ORDER_LIST_COLUMNS},description,reject_reason,admin_note,updated_at,cancelled_at`;

export class SupabaseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
  }
}

// 读取环境变量并检查格式。出错返回 null（不在错误信息里暴露任何值）。
export function getConfig(env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(isLocal && u.protocol === "http:")) return null;
  return { url: u.origin, key };
}

export function createClient(cfg) {
  // 新版 sb_secret_ 密钥只放 apikey；旧版 JWT 形式的 service_role 密钥还需要 Authorization
  const auth = { apikey: cfg.key };
  if (cfg.key.startsWith("eyJ")) auth.Authorization = `Bearer ${cfg.key}`;

  async function rest(method, path, body, extraHeaders = {}) {
    const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method,
      headers: { ...auth, "Content-Type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // 只记录状态码和 Supabase 错误码，不记录返回内容（可能含个人信息）
      let code = "";
      try { code = JSON.parse(text).code || ""; } catch {}
      throw new SupabaseError(`REST ${method} ${path.split("?")[0]} 失败: ${res.status} ${code}`, res.status);
    }
    return text ? JSON.parse(text) : null;
  }

  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  return {
    // 某手机号在 sinceIso 之后提交的订单数（最多数到 limit，够判断限频即可）
    async countRecentOrdersByPhone(phone, sinceIso, limit) {
      const rows = await rest(
        "GET",
        `orders?select=id&phone=eq.${encodeURIComponent(phone)}&created_at=gte.${encodeURIComponent(sinceIso)}&limit=${limit}`
      );
      return rows.length;
    },

    async insertOrder(row) {
      const rows = await rest("POST", "orders?select=id,order_no", row, { Prefer: "return=representation" });
      return rows[0];
    },

    async deleteOrder(id) {
      await rest("DELETE", `orders?id=eq.${encodeURIComponent(id)}`);
    },

    async insertImages(rows) {
      if (rows.length === 0) return;
      await rest("POST", "order_images", rows, { Prefer: "return=minimal" });
    },

    async insertEvent(row) {
      await rest("POST", "order_events", row, { Prefer: "return=minimal" });
    },

    // ===== 管理后台只读查询（永远不选取 cancel_token_hash）=====
    async listOrders({ status, q, limit, offset }) {
      if (q && !/^[\p{L}\p{N} -]{1,30}$/u.test(q)) throw new SupabaseError("非法搜索词", 400);
      const parts = [`select=${ORDER_LIST_COLUMNS}`, "order=created_at.desc", `limit=${Number(limit)}`, `offset=${Number(offset)}`];
      if (status) parts.push(`status=eq.${encodeURIComponent(status)}`);
      if (q) {
        const p = `*${q}*`;
        const cond = `(order_no.ilike.${p},student_name.ilike.${p},phone.ilike.${p},building.ilike.${p},room.ilike.${p})`;
        parts.push(`or=${encodeURIComponent(cond)}`);
      }
      const res = await fetch(`${cfg.url}/rest/v1/orders?${parts.join("&")}`, {
        headers: { ...auth, Prefer: "count=exact" },
      });
      const text = await res.text();
      if (!res.ok) throw new SupabaseError(`REST GET orders 失败: ${res.status}`, res.status);
      const rows = text ? JSON.parse(text) : [];
      const total = Number((res.headers.get("content-range") || "").split("/")[1]);
      return { rows, total: Number.isFinite(total) ? total : rows.length };
    },

    async getOrderById(id) {
      const rows = await rest("GET", `orders?select=${ORDER_DETAIL_COLUMNS}&id=eq.${encodeURIComponent(id)}&limit=1`);
      return rows[0] || null;
    },

    async listOrderImages(orderId) {
      return rest("GET", `order_images?select=id,content_type,size_bytes,created_at&order_id=eq.${encodeURIComponent(orderId)}&order=created_at.asc`);
    },

    async listOrderEvents(orderId) {
      return rest("GET", `order_events?select=from_status,to_status,actor,note,created_at&order_id=eq.${encodeURIComponent(orderId)}&order=created_at.asc,id.asc`);
    },

    // 管理员修改订单。fromStatuses 非空时：只有订单当前状态仍在这个列表里才会更新（原子条件，
    // 防止和学生取消/另一台设备的操作同时发生时互相覆盖）。没有匹配返回 null。
    async updateOrder(id, fromStatuses, patch) {
      let q = `orders?id=eq.${encodeURIComponent(id)}&select=${ORDER_DETAIL_COLUMNS}`;
      if (fromStatuses && fromStatuses.length) {
        q += `&status=in.(${fromStatuses.map(encodeURIComponent).join(",")})`;
      }
      const rows = await rest("PATCH", q, patch, { Prefer: "return=representation" });
      return rows[0] || null;
    },

    async getImageById(id) {
      const rows = await rest("GET", `order_images?select=storage_path,content_type&id=eq.${encodeURIComponent(id)}&limit=1`);
      return rows[0] || null;
    },

    // 从私有桶下载图片（只有服务端带着管理员密钥才能读）
    async downloadImage(path) {
      const res = await fetch(`${cfg.url}/storage/v1/object/authenticated/${BUCKET}/${encodePath(path)}`, { headers: auth });
      if (!res.ok) {
        await res.text();
        throw new SupabaseError(`图片读取失败: ${res.status}`, res.status);
      }
      return Buffer.from(await res.arrayBuffer());
    },

    // 通过取消 Token 的哈希查找订单（只取取消页面需要的字段，不取姓名/手机号）
    async findOrderByTokenHash(hash) {
      const rows = await rest(
        "GET",
        `orders?select=id,order_no,status,created_at&cancel_token_hash=eq.${encodeURIComponent(hash)}&limit=1`
      );
      return rows[0] || null;
    },

    // 原子取消：只有订单当前状态仍等于 fromStatus 才会更新，防止和管理员改状态同时发生时互相覆盖
    async cancelOrder(id, fromStatus) {
      const rows = await rest(
        "PATCH",
        `orders?id=eq.${encodeURIComponent(id)}&status=eq.${encodeURIComponent(fromStatus)}&select=id,order_no,status`,
        { status: "cancelled", cancelled_at: new Date().toISOString() },
        { Prefer: "return=representation" }
      );
      return rows[0] || null;
    },

    async uploadImage(path, buffer, contentType) {
      const res = await fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": contentType, "x-upsert": "false" },
        body: buffer,
      });
      await res.text();
      if (!res.ok) throw new SupabaseError(`图片上传失败: ${res.status}`, res.status);
    },

    async deleteImages(paths) {
      if (paths.length === 0) return;
      const res = await fetch(`${cfg.url}/storage/v1/object/${BUCKET}`, {
        method: "DELETE",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: paths }),
      });
      await res.text();
      if (!res.ok) throw new SupabaseError(`图片删除失败: ${res.status}`, res.status);
    },
  };
}
