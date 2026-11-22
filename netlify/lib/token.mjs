// 取消链接 Token：加密安全的随机数，数据库只保存 SHA-256 哈希。
// Token 有 256 位随机性，无法被猜测，所以用普通 SHA-256 即可（不需要慢哈希）。
import { randomBytes, createHash } from "node:crypto";

// 32 个随机字节 -> 43 个 URL 安全字符
export function generateCancelToken() {
  return randomBytes(32).toString("base64url");
}

// 64 位十六进制小写字符串，与数据库的格式检查一致
export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
