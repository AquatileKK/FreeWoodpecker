// Service Worker：只做两件事——让网站可以“添加到手机桌面”，以及断网时显示友好的提示页。
// 安全原则：
//  1. 绝不拦截 /api/*（订单、取消、后台接口）和 /admin/*（后台页面），这些请求完全直连网络，
//     所以不会有任何订单、个人信息、登录状态被缓存在手机里。
//  2. 只缓存下面这几个固定的静态文件；页面本身永远优先走网络，更新网站后用户立刻看到新版本。
const VERSION = "v1";
const CACHE = "jx-static-" + VERSION;
const PRECACHE = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("jx-static-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) return; // 不经手，直连网络

  // 页面跳转：先走网络；断网时显示“没有网络”提示页
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  // 图标、manifest：缓存优先
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
  // 其他文件（report.js 等）：不处理，直接走网络
});
