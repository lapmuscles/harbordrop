/**
 * 由後端處理的路徑：Service Worker 的 navigateFallback 必須排除，也不可快取。
 * /api/*、/dav（WebDAV）、/f/<slug>/raw 與 /p/<slug>/raw（原始檔）。
 * 注意：workbox 會把 RegExp 序列化進 sw.js，所以這裡只能放純 RegExp。
 */
export const BACKEND_PATHS: RegExp[] = [/^\/api(\/|$)/, /^\/dav(\/|$)/, /^\/f\/[^/]+\/raw(\/|$)/, /^\/p\/[^/]+\/raw(\/|$)/];
