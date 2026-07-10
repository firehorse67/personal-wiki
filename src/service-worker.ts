/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';

const CACHE_NAME = `cache-${version}`;
const ASSETS = [...build, ...files, '/'];

// Install event: cache all static assets and the root page shell
self.addEventListener('install', (event: any) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => (self as any).skipWaiting())
	);
});

// Activate event: clean up outdated caches
self.addEventListener('activate', (event: any) => {
	event.waitUntil(
		caches.keys().then(async (keys) => {
			for (const key of keys) {
				if (key !== CACHE_NAME) {
					await caches.delete(key);
				}
			}
			await (self as any).clients.claim();
		})
	);
});

// Fetch event: intercept network requests
self.addEventListener('fetch', (event: any) => {
	// Only handle GET requests
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);

	// Exclude Supabase API, auth endpoints, or hot reloading during local dev
	if (
		url.host.includes('supabase') || 
		url.pathname.startsWith('/api/') || 
		event.request.url.startsWith('chrome-extension://')
	) {
		return;
	}

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE_NAME);

			// For static build assets and files, apply Cache-First
			const isStaticAsset = ASSETS.includes(url.pathname);
			if (isStaticAsset) {
				const cachedResponse = await cache.match(event.request);
				if (cachedResponse) {
					return cachedResponse;
				}
			}

			// For navigation requests, try network-first, fall back to root shell on failure
			if (event.request.mode === 'navigate') {
				try {
					const networkResponse = await fetch(event.request);
					if (networkResponse.status === 200) {
						// Cache the navigation response for offline use
						await cache.put('/', networkResponse.clone());
						return networkResponse;
					}
				} catch (err) {
					// Offline: serve the cached root shell
					const cachedShell = await cache.match('/');
					if (cachedShell) {
						return cachedShell;
					}
				}
			}

			// Fallback strategy: try network, then cache
			try {
				const response = await fetch(event.request);
				// Stale-While-Revalidate style caching for other assets (e.g. external fonts)
				if (response.status === 200 && (url.protocol === 'http:' || url.protocol === 'https:')) {
					event.waitUntil(cache.put(event.request, response.clone()));
				}
				return response;
			} catch (err) {
				const cachedResponse = await cache.match(event.request);
				if (cachedResponse) {
					return cachedResponse;
				}
				throw err;
			}
		})()
	);
});
