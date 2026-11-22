// 管理后台页面逻辑：登录、订单列表、搜索筛选、订单详情含图片、接单/拒单/改状态/报价/备注。
// 登录令牌在 HttpOnly Cookie 里，这里的代码读不到，也不保存任何令牌或密码。
// 所有展示内容一律用 textContent 写入，不使用 innerHTML。
(function () {
  "use strict";

  var STATUS = { pending: "待处理", accepted: "已接单", repairing: "维修中", completed: "已完成", cancelled: "已取消", rejected: "已拒绝" };
  var MODE = { visit_room: "师傅上门", lobby_handoff: "送到一楼" };
  var MODE_LONG = { visit_room: "师傅上门到寝室（男生宿舍）", lobby_handoff: "学生把电脑送到宿舍一楼（师傅到了电话联系）" };

  var $ = function (id) { return document.getElementById(id); };
  var state = { status: "", q: "", page: 1, pageSize: 20 };

  // ---------- 小工具 ----------
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "text") e.textContent = props[k];
      else if (k === "class") e.className = props[k];
      else e.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) {
      if (c == null) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  }
  function fmtMoney(v) { return v == null ? "未填写" : "¥" + Number(v).toFixed(2); }
  function tag(status) {
    return el("span", { class: "tag " + (/^[a-z]+$/.test(status) ? status : ""), text: STATUS[status] || status });
  }
  function showErr(id, msg) { var p = $(id); p.textContent = msg; p.hidden = !msg; }

  // ---------- 请求（遇到 401 先尝试无感续期一次）----------
  var refreshing = null;
  function doRefresh() {
    if (!refreshing) {
      refreshing = fetch("/api/admin/refresh", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}",
      }).then(function (r) { return r.ok; }, function () { return false; })
        .then(function (ok) { refreshing = null; return ok; });
    }
    return refreshing;
  }
  async function api(path, opts) {
    var init = Object.assign({ credentials: "same-origin" }, opts || {});
    var res = await fetch(path, init);
    if (res.status === 401 && (await doRefresh())) res = await fetch(path, init);
    if (res.status === 401 || res.status === 403) { showLogin(); throw new Error("auth"); }
    return res;
  }
  async function getJson(path) {
    var res = await api(path);
    var data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  // ---------- 登录 / 退出 ----------
  function showLogin() {
    $("app").hidden = true;
    $("loginView").hidden = false;
    $("password").value = "";
  }
  function showApp(email) {
    $("loginView").hidden = true;
    $("app").hidden = false;
    $("who").textContent = email;
    route();
  }

  $("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var btn = $("loginBtn");
    btn.disabled = true; btn.textContent = "登录中…";
    showErr("loginError", "");
    try {
      var res = await fetch("/api/admin/login", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: $("email").value, password: $("password").value }),
      });
      var data = {};
      try { data = await res.json(); } catch (x) {}
      if (res.ok) { $("password").value = ""; showApp(data.email); }
      else showErr("loginError", data.error || "登录失败，请稍后再试");
    } catch (err) {
      showErr("loginError", "网络异常，请检查网络后再试");
    } finally {
      btn.disabled = false; btn.textContent = "登录";
    }
  });

  $("logoutBtn").addEventListener("click", async function () {
    try {
      await fetch("/api/admin/logout", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
    } catch (e) {}
    location.hash = "";
    showLogin();
  });

  // ---------- 订单列表 ----------
  function renderChips() {
    var box = $("chips");
    clear(box);
    [["", "全部"]].concat(Object.keys(STATUS).map(function (k) { return [k, STATUS[k]]; })).forEach(function (p) {
      var b = el("button", { type: "button", class: "chip" + (state.status === p[0] ? " active" : ""), text: p[1] });
      b.addEventListener("click", function () { state.status = p[0]; state.page = 1; loadList(); });
      box.appendChild(b);
    });
  }

  async function loadList() {
    renderChips();
    showErr("listError", "");
    var qs = "?page=" + state.page + (state.status ? "&status=" + encodeURIComponent(state.status) : "") +
      (state.q ? "&q=" + encodeURIComponent(state.q) : "");
    var r;
    try { r = await getJson("/api/admin/orders" + qs); } catch (e) { return; }
    var ul = $("orders");
    clear(ul);
    if (!r.ok) {
      showErr("listError", r.data.error || "加载失败，请稍后再试");
      $("empty").hidden = true; $("pager").hidden = true;
      return;
    }
    var d = r.data;
    state.pageSize = d.pageSize || 20;
    d.orders.forEach(function (o) {
      var a = el("a", { class: "row", href: "#order=" + o.id }, [
        el("div", { class: "r1" }, [el("span", { class: "no", text: o.order_no }), tag(o.status)]),
        el("div", { class: "r2" }, [
          el("span", { text: o.student_name + "　" + o.phone + "　" }),
          el("span", { class: "mode", text: MODE[o.service_mode] || o.service_mode }),
        ]),
        el("div", { class: "r3", text: o.building + " " + o.room + "　预约：" + (o.preferred_time || "—") + "　提交于 " + fmtTime(o.created_at) }),
      ]);
      ul.appendChild(el("li", {}, [a]));
    });
    $("empty").hidden = d.orders.length > 0;
    var pages = Math.max(1, Math.ceil(d.total / state.pageSize));
    $("pager").hidden = d.total <= state.pageSize;
    $("pageInfo").textContent = "第 " + d.page + " / " + pages + " 页，共 " + d.total + " 单";
    $("prevBtn").disabled = d.page <= 1;
    $("nextBtn").disabled = d.page >= pages;
  }

  $("searchForm").addEventListener("submit", function (e) {
    e.preventDefault();
    state.q = $("q").value.trim().replace(/ +/g, " ");
    state.page = 1;
    loadList();
  });
  $("prevBtn").addEventListener("click", function () { if (state.page > 1) { state.page--; loadList(); } });
  $("nextBtn").addEventListener("click", function () { state.page++; loadList(); });

  // ---------- 订单详情 ----------
  function kv(rows) {
    var dl = el("dl", { class: "kv" });
    rows.forEach(function (r) {
      dl.appendChild(el("dt", { text: r[0] }));
      var dd = el("dd");
      if (r[1] instanceof Node) dd.appendChild(r[1]); else dd.textContent = r[1] == null || r[1] === "" ? "—" : String(r[1]);
      dl.appendChild(dd);
    });
    return dl;
  }

  async function postJson(path, payload) {
    var res = await api(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  function showMsg(msg) { var p = $("actionMsg"); p.textContent = msg; p.hidden = !msg; }

  // 提交一次操作。reason 用于拒单/取消；extra 是价格、备注等。
  async function doAction(o, action, extra, okMsg) {
    showErr("detailError", ""); showMsg("");
    var r;
    try { r = await postJson("/api/admin/update-order", Object.assign({ id: o.id, action: action }, extra || {})); } catch (e) { return; }
    if (!r.ok) {
      var msg = r.data.error || "操作失败，请稍后再试";
      if (r.status === 409) await loadDetail(o.id, true); // 状态已变化：刷新成最新状态
      showErr("detailError", msg);
      return;
    }
    await loadDetail(o.id, true);
    showMsg(okMsg);
  }

  function priceVal(id) { return $(id).value.trim(); }

  function buildActions(o) {
    var wrap = el("div");
    var st = o.status;
    var bar = el("div", { class: "actions" });
    function btn(text, cls, fn) {
      var b = el("button", { type: "button", class: cls || "", text: text });
      b.addEventListener("click", function () {
        b.disabled = true;
        Promise.resolve(fn()).then(function () { b.disabled = false; }, function () { b.disabled = false; });
      });
      bar.appendChild(b);
    }
    if (st === "pending") {
      btn("接单", "go", function () {
        if (confirm("确认接单？")) return doAction(o, "accept", null, "已接单");
      });
      btn("拒单", "warn", function () {
        var reason = prompt("请填写拒单原因（会记录在订单里）：");
        if (reason === null) return;
        if (!reason.trim()) { showErr("detailError", "拒单必须填写原因"); return; }
        return doAction(o, "reject", { reason: reason }, "已拒单");
      });
    }
    if (st === "accepted") btn("开始维修", "go", function () {
      if (confirm("确认开始维修？")) return doAction(o, "start", null, "已进入维修中");
    });
    if (st === "repairing") btn("完成订单", "go", function () {
      var fin = priceVal("finalPrice");
      if (fin === "") { showErr("detailError", "完成订单前请先在下面填写“实收金额”（免费请填 0）"); return; }
      if (confirm("确认完成订单？实收金额：¥" + fin)) {
        return doAction(o, "complete", { final_price: fin, quoted_price: priceVal("quotedPrice"), admin_note: $("adminNote").value }, "订单已完成");
      }
    });
    if (st === "pending" || st === "accepted" || st === "repairing") btn("取消订单", "warn", function () {
      var reason = prompt("确认取消这个订单？可以填写取消原因（可不填）：");
      if (reason === null) return;
      return doAction(o, "cancel", { reason: reason }, "订单已取消");
    });
    if (bar.children.length) { wrap.appendChild(el("h2", { text: "处理订单" })); wrap.appendChild(bar); }

    // 报价 / 实收 / 备注
    wrap.appendChild(el("h2", { text: "报价与备注" }));
    var canPrice = st === "accepted" || st === "repairing" || st === "completed";
    if (canPrice) {
      var q = el("input", { id: "quotedPrice", type: "number", inputmode: "decimal", min: "0", max: "99999.99", step: "0.01", placeholder: "元" });
      var f = el("input", { id: "finalPrice", type: "number", inputmode: "decimal", min: "0", max: "99999.99", step: "0.01", placeholder: "元" });
      if (o.quoted_price != null) q.value = o.quoted_price;
      if (o.final_price != null) f.value = o.final_price;
      wrap.appendChild(el("div", { class: "form-grid" }, [
        el("div", {}, [el("label", { for: "quotedPrice", text: "报价（元）" }), q]),
        el("div", {}, [el("label", { for: "finalPrice", text: "实收金额（元）" }), f]),
      ]));
    } else {
      wrap.appendChild(el("p", { class: "muted", text: "接单之后才能填写报价和实收金额。" }));
    }
    wrap.appendChild(el("label", { for: "adminNote", text: "管理员备注（学生看不到）" }));
    var ta = el("textarea", { id: "adminNote", maxlength: "1000" });
    ta.value = o.admin_note || "";
    wrap.appendChild(ta);
    var save = el("button", { type: "button", class: "primary", text: "保存报价与备注" });
    save.addEventListener("click", function () {
      save.disabled = true;
      var extra = { admin_note: $("adminNote").value };
      if (canPrice) { extra.quoted_price = priceVal("quotedPrice"); extra.final_price = priceVal("finalPrice"); }
      doAction(o, "save", extra, "已保存").then(function () { save.disabled = false; }, function () { save.disabled = false; });
    });
    wrap.appendChild(save);
    return wrap;
  }

  async function loadDetail(id, keepMsg) {
    showErr("detailError", "");
    if (!keepMsg) showMsg("");
    var body = $("detailBody");
    clear(body);
    body.appendChild(el("p", { class: "muted", text: "加载中…" }));
    var r;
    try { r = await getJson("/api/admin/order?id=" + encodeURIComponent(id)); } catch (e) { return; }
    clear(body);
    if (!r.ok) {
      showErr("detailError", r.status === 404 ? "订单不存在" : (r.data.error || "加载失败，请稍后再试"));
      return;
    }
    var o = r.data.order;
    var phone = /^1[3-9]\d{9}$/.test(o.phone) ? el("a", { href: "tel:" + o.phone, text: o.phone }) : o.phone;

    body.appendChild(el("h1", {}, [o.order_no + "　", tag(o.status)]));
    body.appendChild(kv([
      ["姓名", o.student_name],
      ["手机号（点击拨打）", phone],
      ["宿舍", o.building + " " + o.room],
      ["维修方式", MODE_LONG[o.service_mode] || o.service_mode],
      ["预约时间", o.preferred_time],
      ["故障描述", o.description],
      ["提交时间", fmtTime(o.created_at)],
      ["报价", fmtMoney(o.quoted_price)],
      ["实际收费", fmtMoney(o.final_price)],
      ["拒单原因", o.reject_reason],
      ["管理员备注", o.admin_note],
      ["取消时间", o.cancelled_at ? fmtTime(o.cancelled_at) : ""],
    ]));

    body.appendChild(buildActions(o));

    body.appendChild(el("h2", { text: "故障图片（" + r.data.images.length + "）" }));
    if (r.data.images.length === 0) body.appendChild(el("p", { class: "muted", text: "学生没有上传图片" }));
    else {
      var box = el("div", { class: "images" });
      r.data.images.forEach(function (im, i) {
        var url = /^\/api\/admin\/image\?id=[0-9a-f-]{36}$/i.test(im.url) ? im.url : "";
        if (!url) return;
        box.appendChild(el("a", { href: url, target: "_blank", rel: "noopener" }, [
          el("img", { src: url, alt: "故障图片 " + (i + 1), loading: "lazy" }),
        ]));
      });
      body.appendChild(box);
    }

    body.appendChild(el("h2", { text: "状态记录" }));
    var ul = el("ul", { class: "events" });
    r.data.events.forEach(function (ev) {
      var from = ev.from_status ? (STATUS[ev.from_status] || ev.from_status) + " → " : "";
      ul.appendChild(el("li", { text: fmtTime(ev.created_at) + "　" + from + (STATUS[ev.to_status] || ev.to_status) +
        "（" + (ev.actor === "admin" ? "管理员" : "学生") + "）" + (ev.note ? "　" + ev.note : "") }));
    });
    if (!r.data.events.length) ul.appendChild(el("li", { class: "muted", text: "暂无记录" }));
    body.appendChild(ul);
  }

  // ---------- 路由：#order=<id> 显示详情，否则显示列表 ----------
  function route() {
    if ($("app").hidden) return;
    var m = /^#order=([0-9a-f-]{36})$/i.exec(location.hash);
    if (m) {
      $("listView").hidden = true; $("detailView").hidden = false;
      loadDetail(m[1]);
    } else {
      $("detailView").hidden = true; $("listView").hidden = false;
      loadList();
    }
  }
  window.addEventListener("hashchange", route);
  $("backLink").addEventListener("click", function (e) { e.preventDefault(); location.hash = ""; });

  // ---------- 启动 ----------
  async function init() {
    var res;
    try {
      res = await fetch("/api/admin/me", { credentials: "same-origin" });
      if (res.status === 401 && (await doRefresh())) res = await fetch("/api/admin/me", { credentials: "same-origin" });
    } catch (e) { return showLogin(); }
    if (!res.ok) return showLogin();
    var data = await res.json();
    showApp(data.email);
  }
  setInterval(doRefresh, 40 * 60 * 1000); // 每 40 分钟无感续期，登录不会在使用中途掉线
  init();
})();
