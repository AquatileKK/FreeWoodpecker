// 报修页面逻辑。
// 重要：所有展示内容一律用 textContent / setAttribute 写入，不使用 innerHTML。
(function () {
  "use strict";

  var MAX_IMAGES = 3;
  var TARGET_BYTES = 1.4 * 1024 * 1024; // 服务器上限是 1.5MB，这里留一点余量
  var MAX_SIDE = 1600;

  var $ = function (id) { return document.getElementById(id); };
  var photos = []; // { blob, url }
  var busyCount = 0; // 正在处理中的图片数量
  var submitting = false;
  var saved = false;

  // ---------- 小工具 ----------
  function len(s) { return Array.from(s).length; } // 按“字”计数，emoji 算 1 个
  function fieldBox(name) { return document.querySelector('.field[data-field="' + name + '"]'); }
  function selectedMode() {
    var r = document.querySelector('input[name="service_mode"]:checked');
    return r ? r.value : "";
  }

  function setError(name, msg) {
    var box = fieldBox(name);
    if (!box) return;
    var p = box.querySelector(".err");
    if (msg) { p.textContent = msg; p.hidden = false; box.classList.add("invalid"); }
    else { p.textContent = ""; p.hidden = true; box.classList.remove("invalid"); }
  }
  function clearErrors() {
    ["name", "phone", "building", "room", "service_mode", "preferred_time", "description", "images"]
      .forEach(function (n) { setError(n, ""); });
    $("formError").hidden = true;
  }
  function showFormError(msg) {
    $("formError").textContent = msg;
    $("formError").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function refreshSubmit() {
    var btn = $("submitBtn");
    btn.disabled = submitting || busyCount > 0;
    btn.textContent = submitting ? "正在提交…" : busyCount > 0 ? "正在处理图片…" : "提交报修";
  }

  // ---------- 图片：压缩（同时会去掉 EXIF 里的位置等信息）----------
  function toBlob(canvas, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", quality); });
  }

  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* 换备用方法 */ }
    }
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  async function compress(file) {
    var src = await decode(file);
    var w = src.width || src.naturalWidth;
    var h = src.height || src.naturalHeight;
    if (!w || !h) throw new Error("decode");
    var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    var blob = null;

    for (var round = 0; round < 4; round++) {
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // PNG 透明背景填白，避免变黑
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(src, 0, 0, cw, ch);

      var qualities = [0.85, 0.7, 0.55, 0.4];
      for (var i = 0; i < qualities.length; i++) {
        blob = await toBlob(canvas, qualities[i]);
        if (blob && blob.size <= TARGET_BYTES) { if (src.close) src.close(); return blob; }
      }
      scale *= 0.75; // 还是太大就缩小尺寸再试
    }
    if (src.close) src.close();
    throw new Error("toobig");
  }

  function renderThumbs() {
    var ul = $("thumbs");
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    photos.forEach(function (p, idx) {
      var li = document.createElement("li");
      var img = document.createElement("img");
      img.src = p.url;
      img.alt = "故障图片 " + (idx + 1);
      var del = document.createElement("button");
      del.type = "button";
      del.textContent = "删除";
      del.addEventListener("click", function () {
        URL.revokeObjectURL(p.url);
        photos.splice(photos.indexOf(p), 1);
        setError("images", "");
        renderThumbs();
      });
      li.appendChild(img); li.appendChild(del); ul.appendChild(li);
    });
    $("addBtn").setAttribute("aria-disabled", photos.length + busyCount >= MAX_IMAGES ? "true" : "false");
  }

  $("photoInput").addEventListener("change", async function (e) {
    var input = e.target;
    var chosen = Array.prototype.slice.call(input.files || []);
    input.value = ""; // 允许再次选择同一张
    setError("images", "");
    var room = MAX_IMAGES - photos.length - busyCount;
    if (chosen.length > room) setError("images", "最多上传 " + MAX_IMAGES + " 张图片，多余的已忽略。");
    chosen = chosen.slice(0, Math.max(0, room));

    for (var i = 0; i < chosen.length; i++) {
      var file = chosen[i];
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
        setError("images", "只支持 JPG、PNG、WebP 格式的图片。");
        continue;
      }
      busyCount++; refreshSubmit(); renderThumbs();
      try {
        var blob = await compress(file);
        photos.push({ blob: blob, url: URL.createObjectURL(blob) });
      } catch (err) {
        setError("images", err.message === "toobig" ? "图片太大，无法压缩到合适大小，请换一张。" : "无法读取这张图片，请换一张试试。");
      } finally {
        busyCount--; refreshSubmit(); renderThumbs();
      }
    }
  });

  // ---------- 表单校验（与服务器规则一致，服务器仍会再次校验）----------
  $("description").addEventListener("input", function () {
    $("descCount").textContent = len($("description").value) + "/1000";
  });

  function validate() {
    clearErrors();
    var firstBad = null;
    function bad(field, msg) { setError(field, msg); if (!firstBad) firstBad = field; }

    var name = $("name").value.trim();
    var phone = $("phone").value.replace(/[\s-]/g, "");
    var building = $("building").value.trim();
    var room = $("room").value.replace(/\s+/g, "");
    var when = $("preferred_time").value.trim();
    var desc = $("description").value.trim();

    if (len(name) < 1 || len(name) > 30) bad("name", "请填写姓名（1-30 个字）");
    if (!/^1[3-9]\d{9}$/.test(phone)) bad("phone", "请填写正确的 11 位手机号");
    if (len(building) < 1 || len(building) > 30) bad("building", "请填写宿舍楼栋，例如：西1");
    if (len(room) < 1 || len(room) > 20) bad("room", "请填写房间号，例如：114");
    if (!selectedMode()) bad("service_mode", "请选择维修方式");
    if (len(when) < 1 || len(when) > 50) bad("preferred_time", "请填写预约时间，例如：今晚 7 点以后");
    if (len(desc) < 5) bad("description", "请至少写 5 个字，描述一下故障现象");
    if (len(desc) > 1000) bad("description", "最多 1000 个字");

    if (firstBad) {
      var box = fieldBox(firstBad);
      var ctl = box.querySelector("input, select, textarea");
      if (ctl) ctl.focus();
      box.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return !firstBad;
  }

  // 用户开始修改某个输入框时，立刻清掉它的错误提示
  ["name", "phone", "building", "room", "preferred_time", "description"].forEach(function (n) {
    $(n).addEventListener("input", function () { setError(n, ""); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="service_mode"]'), function (r) {
    r.addEventListener("change", function () { setError("service_mode", ""); });
  });

  // ---------- 提交 ----------
  $("form").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (submitting || busyCount > 0) return;
    if (!validate()) return;

    submitting = true; refreshSubmit();
    var fd = new FormData();
    fd.append("name", $("name").value);
    fd.append("phone", $("phone").value);
    fd.append("building", $("building").value);
    fd.append("room", $("room").value);
    fd.append("service_mode", selectedMode());
    fd.append("preferred_time", $("preferred_time").value);
    fd.append("description", $("description").value);
    fd.append("website", $("website").value); // 蜜罐：正常用户为空
    photos.forEach(function (p, i) { fd.append("images", p.blob, "photo-" + (i + 1) + ".jpg"); });

    try {
      var res = await fetch("/api/submit-order", { method: "POST", body: fd });
      var data = {};
      try { data = await res.json(); } catch (x) {}

      if (res.status === 201) return showDone(data);
      if (res.status === 400 && data.field && fieldBox(data.field)) {
        setError(data.field, data.error || "填写有误");
        var c = fieldBox(data.field).querySelector("input, select, textarea");
        if (c) c.focus();
      } else {
        showFormError(data.error || "提交失败，请稍后再试。你填写的内容还在，可以再点一次提交。");
      }
    } catch (err) {
      showFormError("网络异常，请检查网络后再试。你填写的内容还在，可以再点一次提交。");
    } finally {
      submitting = false; refreshSubmit();
    }
  });

  // ---------- 成功页：提醒保存取消链接 ----------
  function warnBeforeLeave(e) {
    if (saved) return;
    e.preventDefault();
    e.returnValue = "";
  }

  function showDone(data) {
    $("formView").hidden = true;
    $("doneView").hidden = false;
    $("doneOrderNo").textContent = data.orderNo;
    $("cancelUrl").value = data.cancelUrl;
    // 只允许跳转到本站的取消页面，防止 javascript: 之类的链接
    var safe = typeof data.cancelUrl === "string" &&
      data.cancelUrl.indexOf(location.origin + "/cancel.html#t=") === 0;
    if (safe) $("openCancel").setAttribute("href", data.cancelUrl);
    else $("openCancel").hidden = true;
    if (navigator.share) $("shareBtn").hidden = false; // 手机浏览器支持时才显示
    photos.forEach(function (p) { URL.revokeObjectURL(p.url); });
    photos = [];
    window.addEventListener("beforeunload", warnBeforeLeave);
    window.scrollTo(0, 0);
  }

  function markSaved() {
    saved = true;
    window.removeEventListener("beforeunload", warnBeforeLeave);
  }

  $("copyBtn").addEventListener("click", async function () {
    var ta = $("cancelUrl");
    var ok = false;
    try { await navigator.clipboard.writeText(ta.value); ok = true; } catch (e) {
      ta.focus(); ta.select();
      try { ok = document.execCommand("copy"); } catch (e2) {}
    }
    $("copyBtn").textContent = ok ? "已复制 ✓" : "复制失败，请长按上面的链接手动复制";
    if (ok) markSaved();
  });

  // 点了“打开取消页面”：链接已经在那个页面的地址栏里，不再弹离开提醒
  $("openCancel").addEventListener("click", markSaved);

  $("shareBtn").addEventListener("click", async function () {
    try {
      await navigator.share({ title: "鸡西大学校园电脑维修 - 取消链接", url: $("cancelUrl").value });
      markSaved();
    } catch (e) { /* 用户关闭了分享面板，不算已保存 */ }
  });

  $("savedBtn").addEventListener("click", function () {
    markSaved();
    $("savedMsg").hidden = false;
    $("savedBtn").hidden = true;
  });

  refreshSubmit();
})();
