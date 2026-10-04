// Spetchbook — Service Worker
// Cache-first strategy: serve from cache when available, fall back to network,
// and opportunistically update the cache from network responses.
//
// TWO CACHES, on purpose (session 114a).
//
//   CACHE_NAME   — the app shell. index.html, manifest, icons. Bumped on every
//                  deploy that changes any of them; `activate` deletes the old
//                  key, which is the only thing that busts the cache for
//                  returning visitors.
//
//   VENDOR_CACHE — three.min.js and nothing else. Keyed on the LIBRARY
//                  VERSION, not the app version, and deliberately EXCLUDED
//                  from the activate sweep so an app bump does not delete it.
//
// Why the split, since it is the whole reason three.min.js is a sibling file
// rather than inlined: it is ~600KB that has not changed since r128 was pinned
// and never will. In a single cache, `activate` would delete it on every
// CACHE_NAME bump and `install` would re-fetch it — so every session's cache
// bump would cost every user 600KB to deliver a few edited lines, which is
// exactly the outcome keeping it a separate file was meant to avoid. Session
// 114 shipped it in the shared cache and only avoided the re-download by
// accident, via the browser's HTTP cache, which is not a guarantee. With its
// own key it is genuinely fetched once, ever.
//
// Bump VENDOR_CACHE only when the pinned Three.js revision actually changes.
// The old key then fails both exclusions below and is reaped normally.
const CACHE_NAME   = 'spetchbook-v137b';
const VENDOR_CACHE = 'spetchbook-vendor-r128';

const VENDOR_URLS = [
  './three.min.js'
];

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png'
];

// True for a request this SW should serve out of VENDOR_CACHE. Matched on the
// path tail rather than the full URL so it works under any GitHub Pages
// subpath.
function isVendor(url) {
  // '/three.min.js' is 13 characters. Getting this length wrong makes the
  // test silently false under a GitHub Pages project subpath (the real deploy
  // is /sketchbook-v5-/) while still passing at the domain root, so the
  // vendor cache would quietly never be used in production.
  return url.pathname.slice(-13) === '/three.min.js';
}

self.addEventListener('install', function(event) {
  event.waitUntil(
    Promise.all([
      // App shell. addAll fails atomically if any single URL 404s — fetch
      // individually so one missing icon (e.g. a size not yet generated)
      // doesn't block the whole install.
      caches.open(CACHE_NAME).then(function(cache) {
        return Promise.all(
          PRECACHE_URLS.map(function(url) {
            return cache.add(url).catch(function(err) {
              console.warn('SW precache skipped:', url, err);
            });
          })
        );
      }),
      // Vendor. Only fetched if it isn't already there — on an app-version
      // bump this whole branch is a cache hit and no bytes move, which is the
      // point of the split.
      caches.open(VENDOR_CACHE).then(function(cache) {
        return Promise.all(
          VENDOR_URLS.map(function(url) {
            return cache.match(url).then(function(hit) {
              if (hit) return null;
              return cache.add(url).catch(function(err) {
                console.warn('SW vendor precache skipped:', url, err);
              });
            });
          })
        );
      })
    ]).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) {
          if (key === CACHE_NAME) return false;
          // Keeping the current vendor cache across app bumps is the entire
          // mechanism. A stale vendor cache from a previous pinned revision
          // does not match this test and is reaped normally.
          if (key === VENDOR_CACHE) return false;
          return true;
        }).map(function(key) {
          return caches.delete(key);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  // Only handle same-origin GET requests. As of session 114 the app's assets
  // are all first-party — Three.js is the sibling ./three.min.js and DM Mono
  // is inlined as base64 in index.html — so this early return no longer skips
  // anything the app needs in order to boot. That is the whole point: this
  // branch is exactly why the installed PWA could not start without a network.
  //
  // index.html DOES carry one cross-origin <script>: a cdnjs fallback that
  // fires only when the local three.min.js is absent. It is deliberately left
  // to pass through untouched. Offline it is never reached (the local file
  // answers first); its only job is to keep a lone index.html with no sibling
  // file working when there IS a network. Caching it would buy nothing and
  // would blur the distinction. See gotchas.md Critical Rule #116(a).
  //
  // Do not add a cross-origin asset the app needs to boot without either
  // caching it here or accepting that regression.
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Vendor: cache-first with NO background refresh. The file is immutable by
  // definition — a pinned revision — so re-fetching it on every load to keep
  // it "fresh" would spend exactly the 600KB the separate cache exists to
  // save. If the revision changes, VENDOR_CACHE's key changes with it.
  if (isVendor(url)) {
    event.respondWith(
      caches.open(VENDOR_CACHE).then(function(cache) {
        return cache.match(event.request).then(function(cached) {
          if (cached) return cached;
          return fetch(event.request).then(function(response) {
            if (response && response.status === 200 && response.type === 'basic') {
              cache.put(event.request, response.clone());
            }
            return response;
          });
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      var networkFetch = fetch(event.request).then(function(response) {
        // Only cache valid, basic (same-origin) responses.
        if (response && response.status === 200 && response.type === 'basic') {
          var responseClone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      }).catch(function() {
        // Network failed — fall back to whatever's cached, if anything.
        return cached;
      });

      // Cache-first: return cached immediately if we have it, but still
      // refresh the cache in the background from the network.
      return cached || networkFetch;
    })
  );
});
