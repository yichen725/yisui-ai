const CACHE_NAME = 'yisui-ai-v1';
const urlsToCache = [
  './',
  './index.html',
  './app.html',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.1.7/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/common.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) return response;
        return fetch(event.request)
          .then((response) => {
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, responseToCache))
              .catch(() => {});
            return response;
          })
          .catch(() => {
            if (event.request.destination === 'document') {
              return caches.match('./app.html');
            }
          });
      })
  );
});
