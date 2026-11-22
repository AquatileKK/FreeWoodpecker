// 输入校验：姓名、手机号、楼栋、房间号、故障描述、图片。
// 原则：服务端永远不信任浏览器传来的任何东西，图片类型以“文件真实内容”为准，不看文件名和浏览器声称的类型。

export const LIMITS = {
  maxImages: 3,
  maxImageBytes: 1.5 * 1024 * 1024, // 单张 1.5MB（浏览器端会先压缩，见后续阶段）
  maxRequestBytes: 5.5 * 1024 * 1024, // 整个请求上限，低于 Netlify 函数 6MB 的硬限制
};

// 按“字符”计数（一个 emoji 算 1 个），与数据库 char_length 保持一致
const len = (s) => Array.from(s).length;

const CONTROL_NO_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

// 维修方式：visit_room = 师傅上门到寝室（仅限男生宿舍）；lobby_handoff = 学生把电脑送到宿舍一楼
export const SERVICE_MODES = ["visit_room", "lobby_handoff"];

function clean(value) {
  return typeof value === "string" ? value.normalize("NFC").trim() : "";
}

function fail(error, field) {
  return { ok: false, error, field };
}

export function validateFields(raw) {
  const name = clean(raw.name).replace(/\s+/g, " ");
  const phone = clean(raw.phone).replace(/[\s-]/g, "");
  const building = clean(raw.building).replace(/\s+/g, " ");
  const room = clean(raw.room).replace(/\s+/g, "");
  const service_mode = clean(raw.service_mode);
  const preferred_time = clean(raw.preferred_time).replace(/\s+/g, " ");
  const description = clean(raw.description).replace(/\r\n?/g, "\n");

  if (len(name) < 1 || len(name) > 30 || CONTROL_NO_NEWLINE.test(name) || name.includes("\n"))
    return fail("姓名需为 1-30 个字符", "name");
  if (!/^1[3-9]\d{9}$/.test(phone)) return fail("请填写正确的 11 位手机号", "phone");
  if (len(building) < 1 || len(building) > 30 || CONTROL_NO_NEWLINE.test(building) || building.includes("\n"))
    return fail("请填写宿舍楼栋（最多 30 个字符）", "building");
  if (len(room) < 1 || len(room) > 20 || CONTROL_NO_NEWLINE.test(room))
    return fail("请填写房间号（最多 20 个字符）", "room");
  if (!SERVICE_MODES.includes(service_mode)) return fail("请选择维修方式", "service_mode");
  if (len(preferred_time) < 1 || len(preferred_time) > 50 || CONTROL_NO_NEWLINE.test(preferred_time) || preferred_time.includes("\n"))
    return fail("请填写预约时间（最多 50 个字）", "preferred_time");
  if (len(description) < 5 || len(description) > 1000 || CONTROL_NO_NEWLINE.test(description))
    return fail("故障描述需为 5-1000 个字符", "description");

  return {
    ok: true,
    value: { student_name: name, phone, building, room, service_mode, preferred_time, description },
  };
}

// 通过文件头部的“魔数”判断真实图片类型
export function sniffImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: "image/jpeg", ext: "jpg" };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) {
    return { type: "image/png", ext: "png" };
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { type: "image/webp", ext: "webp" };
  }
  return null;
}

// files: 表单里的 File 对象数组。返回处理好的图片（含 Buffer），或错误信息。
export async function validateImages(files) {
  if (files.length > LIMITS.maxImages) return fail(`最多上传 ${LIMITS.maxImages} 张图片`, "images");

  const out = [];
  for (const file of files) {
    if (file.size <= 0) return fail("图片文件为空", "images");
    if (file.size > LIMITS.maxImageBytes) return fail("单张图片不能超过 1.5MB，请压缩后重试", "images");
    const buffer = Buffer.from(await file.arrayBuffer());
    const kind = sniffImage(buffer);
    if (!kind) return fail("只支持 JPG、PNG、WebP 格式的图片", "images");
    out.push({ buffer, type: kind.type, ext: kind.ext, size: buffer.length });
  }
  return { ok: true, value: out };
}
