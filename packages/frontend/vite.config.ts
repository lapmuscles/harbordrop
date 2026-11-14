import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { BACKEND_PATHS } from "./src/pwa-paths";

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      strategies: "generateSW",
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "HarborDrop",
        short_name: "HarborDrop",
        description: "多儲存渠道的檔案上傳、分享與文字分享",
        lang: "zh-TW",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f8fafc",
        theme_color: "#0f766e",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // 後端路徑不可由 Service Worker 用 index.html 代答
        navigateFallbackDenylist: BACKEND_PATHS,
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,wasm}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          // /api/*、/dav/*、原始檔下載：永遠走網路、不寫入快取
          { urlPattern: ({ url, sameOrigin }) => sameOrigin && /^\/(api|dav)(\/|$)|^\/[fp]\/[^/]+\/raw(\/|$)/.test(url.pathname), handler: "NetworkOnly" },
        ],
      },
    }),
  ],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787", "/dav": "http://127.0.0.1:8787" },
  },
  optimizeDeps: {
    // xet 切塊使用 wasm，避免預先打包時破壞 wasm 載入
    exclude: ["@huggingface/xetchunk-wasm"],
  },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
