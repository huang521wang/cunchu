// 极简 service worker：只为让浏览器把它当"可安装的应用"（有 fetch 处理器就行）。
// 不做缓存——每次都拿最新的页面和接口，避免"改了代码还看旧的"。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // 不调用 respondWith：请求照常走网络，永远最新
});
