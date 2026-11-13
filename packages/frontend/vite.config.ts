import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787", "/dav": "http://127.0.0.1:8787" },
  },
  optimizeDeps: {
    // xet 切塊使用 wasm，避免預先打包時破壞 wasm 載入
    exclude: ["@huggingface/xetchunk-wasm"],
  },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
