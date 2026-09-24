// P2-11 PWA service worker（离线壳缓存，v2）。
// 策略：安装时预缓存应用壳 + 解析 index.html 中的带 hash 静态资源（JS/CSS）一并预缓存，
//       保证「首次离线」即可加载完整首页（v1 仅缓存壳，离线首访因 JS/CSS 未缓存而空白）。
//       导航请求网络优先（失败回退缓存首页）；同源静态资源 stale-while-revalidate。
// 缓存版本号：发布重大静态结构变更时 +1 以清空旧缓存。
const CACHE = 'richman-v2';
const SHELL = [
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// 从 index.html 抽取带 hash 的同源静态资源（/assets/*.js、/assets/*.css）。
function extractAssetUrls(html) {
  const urls = [];
  const re = /(?:src|href)="(\/[^"]+\.(?:js|css))"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    urls.push(match[1]);
  }
  return [...new Set(urls)];
}

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  // 解析入口 HTML 并预缓存其静态资源，使首次离线访问也能拿到 JS/CSS。
  try {
    const res = await fetch('/index.html', { cache: 'no-cache' });
    if (res.ok) {
      const html = await res.text();
      const assets = extractAssetUrls(html);
      await Promise.allSettled(
        assets.map((url) => cache.add(url).catch(() => { /* 单个资源失败不影响整体壳缓存 */ })),
      );
    }
  } catch (_) {
    // 解析失败不影响已缓存的壳，下次在线访问时 stale-while-revalidate 会补齐。
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // 网络优先；离线时回退到缓存的首页壳。
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((r) => r || fetch(req))),
    );
    return;
  }

  // 静态资源：先返回缓存，再在后台用网络结果更新缓存。
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});
