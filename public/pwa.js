// 注册 Service Worker，并显示“添加到手机桌面”的提示。不保存任何用户数据。
(function () {
  "use strict";
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {});
    });
  }

  var tip = document.getElementById("installTip");
  if (!tip) return;
  var btn = document.getElementById("installBtn");
  var iosHint = document.getElementById("iosHint");
  var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) return; // 已经是桌面应用，不再提示

  var deferred = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    tip.hidden = false; btn.hidden = false;
  });
  btn.addEventListener("click", function () {
    if (!deferred) return;
    var p = deferred; deferred = null; btn.hidden = true;
    p.prompt();
    if (p.userChoice) p.userChoice.then(function () { tip.hidden = true; }, function () {});
  });
  window.addEventListener("appinstalled", function () { tip.hidden = true; });

  // iPhone / iPad 的 Safari 不支持一键安装，只能手动：分享 → 添加到主屏幕
  var ua = navigator.userAgent || "";
  var isIOS = /iPhone|iPad|iPod/.test(ua);
  var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|MicroMessenger|QQ\/|EdgiOS/.test(ua);
  if (isIOS && isSafari) { tip.hidden = false; iosHint.hidden = false; }
})();
