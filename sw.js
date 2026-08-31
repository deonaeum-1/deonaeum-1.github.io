/* ============================================================
   더나음 서비스워커
   ------------------------------------------------------------
   배포 후 반영이 안 되는 사고를 막는 게 최우선이라,
   index.html 은 항상 네트워크를 먼저 시도하고 실패할 때만
   캐시를 씁니다. 아이콘·폰트·SDK 같은 정적 자원만 캐시에서
   즉시 꺼내 쓰고, Firestore/Storage 트래픽은 아예 건드리지
   않습니다.

   ▸ index.html 을 수정해서 배포할 때 VERSION 은 안 올려도 됩니다
     (network-first 라 자동 반영)
   ▸ 아이콘·manifest·이 파일 자체를 바꿀 때만 VERSION 을 올리세요
   ============================================================ */

const VERSION = 'v2';
const SHELL   = 'deonaeum-shell-' + VERSION;

/* 오프라인 대비 미리 담아두는 파일들 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  './favicon-16.png'
];

/* 절대 가로채면 안 되는 요청.
   Firestore 는 long-polling/스트리밍이라 서비스워커가 끼면 깨지고,
   Storage 업로드·다운로드도 캐시 대상이 아닙니다. */
const BYPASS = [
  /firestore\.googleapis\.com/,
  /firebasestorage\.googleapis\.com/,
  /firebaseinstallations\.googleapis\.com/,
  /identitytoolkit\.googleapis\.com/,
  /securetoken\.googleapis\.com/,
  /firebaselogging/,
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /fcmregistrations\.googleapis\.com/
];

/* 캐시해두면 이득인 외부 정적 자원 (SDK·웹폰트) */
const STATIC = [
  /gstatic\.com\/firebasejs/,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /cdn\.jsdelivr\.net/
];

const match = (list, url) => list.some(re => re.test(url));

/* ---------- install: 셸 미리 담기 ---------- */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    /* addAll 은 하나만 404 나도 전체가 실패하므로 개별로 담습니다 */
    await Promise.all(PRECACHE.map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

/* ---------- activate: 구 버전 캐시 청소 ---------- */
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('deonaeum-') && k !== SHELL)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = req.url;

  /* GET 이 아니거나(POST 업로드 등) 우회 목록이면 손대지 않음 */
  if (req.method !== 'GET') return;
  if (match(BYPASS, url)) return;
  if (!/^https?:/.test(url)) return;

  const sameOrigin = new URL(url).origin === self.location.origin;

  /* 1) 화면 진입(네비게이션) → 네트워크 우선.
        배포 즉시 반영되고, 오프라인일 때만 캐시로 떨어집니다. */
  if (req.mode === 'navigate' || (sameOrigin && /\.html$/.test(new URL(url).pathname))) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (err) {
        const cached = await caches.match('./index.html');
        return cached || new Response(
          '<meta charset="utf-8"><div style="font-family:sans-serif;padding:40px;text-align:center;color:#4E5968">' +
          '<h3 style="margin-bottom:8px">연결이 끊겼어요</h3>' +
          '<p style="font-size:14px">네트워크를 확인하고 다시 시도해주세요.</p></div>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
        );
      }
    })());
    return;
  }

  /* 2) 외부 정적 자원(SDK·폰트) → 캐시 우선 + 백그라운드 갱신 */
  if (match(STATIC, url)) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      const net = fetch(req).then(r => {
        if (r && r.status === 200) cache.put(req, r.clone()).catch(() => {});
        return r;
      }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
    return;
  }

  /* 3) 같은 출처 정적 파일(아이콘 등) → 캐시 우선 */
  if (sameOrigin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r && r.status === 200) cache.put(req, r.clone()).catch(() => {});
        return r;
      } catch (err) {
        return Response.error();
      }
    })());
  }

  /* 그 외(제3자 이미지 등)는 브라우저에 맡깁니다 */
});
