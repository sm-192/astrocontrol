/**
 * AstroControl — sw.js  (production)
 *
 * Estratégia:
 *   - Assets estáticos (HTML/CSS/JS): cache-first com fallback de rede
 *   - Dados dinâmicos (WS, /api/*): sempre passa direto (sem cache)
 *   - Offline: serve a shell (index.html) — a UI não quebra
 *
 * Melhorias sobre versão anterior:
 *   - Nunca cacheia dados dinâmicos
 *   - Versionamento correto do cache
 *   - Cleanup de caches antigos na ativação
 *   - Fallback offline claro
 */

'use strict';

const CACHE_NAME   = 'astrocontrol-v2';
const STATIC_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/alignment.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

/* URLs que NUNCA devem ser cacheadas */
function isDynamic(url) {
  return (
    url.includes('/api/')    ||
    url.includes('/ws')      ||
    url.protocol === 'ws:'   ||
    url.protocol === 'wss:'  ||
    url.port === '8443'      ||
    url.port === '4400'      ||
    url.port === '7681'      ||
    url.port === '8624'      ||
    url.port === '8765'      ||
    url.port === '2947'
  );
}

/* ── Install: pré-cache dos assets estáticos ── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_SHELL).catch((err) => {
        console.warn('[SW] Alguns assets não foram cacheados:', err);
      });
    })
  );
  self.skipWaiting();
});

/* ── Activate: remove caches antigos ── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch: estratégia por tipo de recurso ── */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }

  /* Dados dinâmicos: sem cache, passa direto */
  if (isDynamic(url)) return;

  /* Apenas GET é cacheável */
  if (req.method !== 'GET') return;

  event.respondWith(handleFetch(req, url));
});

async function handleFetch(req, url) {
  const cache = await caches.open(CACHE_NAME);

  /* Assets estáticos conhecidos: cache-first */
  const isShell = STATIC_SHELL.some(path => url.pathname === path || url.pathname === path.replace(/^\//, ''));
  if (isShell) {
    const cached = await cache.match(req);
    if (cached) {
      /* Atualiza em background (stale-while-revalidate) */
      fetch(req).then((res) => {
        if (res && res.status === 200) cache.put(req, res.clone());
      }).catch(() => {});
      return cached;
    }
  }

  /* Qualquer outro GET: network-first com fallback para cache */
  try {
    const response = await fetch(req);
    if (response && response.status === 200) {
      cache.put(req, response.clone());
    }
    return response;
  } catch {
    /* Offline */
    const cached = await cache.match(req);
    if (cached) return cached;

    /* Fallback: serve index.html para rotas da SPA */
    if (req.headers.get('accept')?.includes('text/html')) {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }

    /* Último recurso: resposta de erro */
    return new Response('Offline — recurso não disponível', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
