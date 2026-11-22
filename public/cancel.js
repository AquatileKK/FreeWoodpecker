// 取消页面逻辑。Token 在网址 # 后面（形如 /cancel.html#t=xxxx），浏览器不会把它发给服务器。
// 所有展示内容一律用 textContent 写入，不使用 innerHTML，避免被注入恶意代码。
(function () {
  "use strict";

  var STATUS_TEXT = {
    pending: "待处理",
    accepted: "已接单",
    repairing: "维修中",
    completed: "已完成",
    cancelled: "已取消",
    rejected: "已拒绝",
  };

  var $ = function (id) { return document.getElementById(id); };
  var token = new URLSearchParams(location.hash.slice(1)).get("t") || "";

  function show(id) { $(id).hidden = false; }
  function hide(id) { $(id).hidden = true; }

  function showError(text) {
    hide("loading");
    hide("info");
    $("error").textContent = text;
    show("error");
  }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  }

  async function post(body) {
    var res = await fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data: data };
  }

  function render(order) {
    hide("loading");
    $("orderNo").textContent = order.orderNo;
    var tag = $("status");
    tag.textContent = STATUS_TEXT[order.status] || order.status;
    tag.className = "tag " + (/^[a-z]+$/.test(order.status) ? order.status : "");
    $("createdAt").textContent = formatTime(order.createdAt);

    if (order.canCancel) {
      hide("blocked");
      show("confirmBtn");
    } else {
      hide("confirmBtn");
      var blocked = $("blocked");
      blocked.textContent =
        order.status === "cancelled" ? "该订单已经取消。"
        : order.status === "rejected" ? "该订单已被维修方拒绝，无需取消。"
        : "该订单当前状态无法在线取消，请直接联系维修点。";
      show("blocked");
    }
    show("info");
  }

  async function load() {
    if (!token) return showError("链接不完整，请使用提交报修后保存的完整取消链接。");
    try {
      var r = await post({ token: token });
      if (r.status === 200) return render(r.data);
      if (r.status === 404) return showError("链接无效或已失效，请检查是否复制完整。");
      showError(r.data.error || "查询失败，请稍后再试。");
    } catch (e) {
      showError("网络异常，请检查网络后刷新页面。");
    }
  }

  $("confirmBtn").addEventListener("click", async function () {
    var btn = $("confirmBtn");
    if (btn.disabled) return; // 防止连点
    btn.disabled = true;
    btn.textContent = "正在取消…";
    try {
      var r = await post({ token: token, confirm: true });
      if (r.status === 200) {
        hide("info");
        $("done").textContent = "订单 " + r.data.orderNo + " 已取消。";
        show("done");
        return;
      }
      // 失败：重新查询一次，让页面显示最新状态
      var msg = r.data.error || "取消失败，请稍后再试。";
      await load();
      $("error").textContent = msg;
      show("error");
    } catch (e) {
      showError("网络异常，请检查网络后刷新页面。");
    } finally {
      btn.disabled = false;
      btn.textContent = "确认取消这个订单";
    }
  });

  load();
})();
